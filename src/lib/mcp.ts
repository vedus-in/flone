import 'server-only';

import { Priority, Role } from '@prisma/client';

import {
  AuthzError,
  boardPath,
  cyclesPath,
  isNextControlFlowError,
  issuesPath,
  orgPath,
  projectPath,
  requireAdmin,
  requireBoard,
  requireOrgBySlug,
  // Tools address a project by (orgSlug, projectKey) and have no URL to prove
  // canonical, so they use the workspace-free loader -- same authorization, one
  // fewer argument every caller would have to look up first.
  requireProjectByKeyInOrg,
  requireTicket,
  requireUser,
  ticketPath,
  type BoardCtx,
  type TicketCtx,
} from '@/lib/authz';
import { prisma } from '@/lib/db';
import { ensureCycles } from '@/lib/cycles';
import { listNavTree } from '@/lib/nav';
import type { ActionResult } from '@/lib/result';
import { getAppSettings, isRegistrationOpen } from '@/lib/settings';
import { listStates } from '@/lib/states';
import { STATE_ORDER, TICKET_ORDER, cuid } from '@/lib/validation';

import { setRegistration, setUserAdmin } from '@/app/(app)/admin/actions';
import { createOrganization } from '@/app/(app)/orgs/new/actions';
import { createWorkspace } from '@/app/(app)/orgs/[orgSlug]/actions';
import { createProject } from '@/app/(app)/orgs/[orgSlug]/[workspaceSlug]/actions';
import {
  addMember,
  changeMemberRole,
  deleteOrganization,
  removeMember,
  renameOrganization,
} from '@/app/(app)/orgs/[orgSlug]/settings/actions';
import {
  createBoard,
  deleteBoard,
  deleteProject,
  renameBoard,
  updateProject,
} from '@/app/(app)/orgs/[orgSlug]/[workspaceSlug]/[projectKey]/actions';
import {
  createIssue,
  deleteIssue,
  placeIssue,
  setIssueAssignee,
  setIssueBoard,
  setIssueCycle,
  setIssueDueDate,
  setIssueLabels,
  setIssueParent,
  setIssuePriority,
  updateIssue,
} from '@/app/(app)/orgs/[orgSlug]/[workspaceSlug]/[projectKey]/issue-actions';
import {
  createComment,
  deleteComment,
  updateComment,
} from '@/app/(app)/orgs/[orgSlug]/[workspaceSlug]/[projectKey]/issue/[ticketNumber]/actions';

/**
 * The MCP tool surface (transport lives in `src/app/api/mcp/route.ts`).
 *
 * It covers the whole application: organizations, members, projects, workflow
 * states, labels, cycles, boards, issues, comments and site administration.
 * Everything the web UI can do, a model can do — under exactly the same rules.
 *
 * THIS FILE ADDS NO AUTHORIZATION OF ITS OWN, and that is the point. Every read
 * goes through a `require*` helper from `@/lib/authz` or is a nested/rooted
 * select under an id that helper already proved the caller may see; every write
 * is delegated to the SAME Server Action the web UI submits, so the zod parse,
 * the membership walk, the role checks, the last-owner and last-admin locks,
 * the `require*InProject` guards and the `revalidatePath` calls all still happen
 * exactly once, in one place.
 *
 * The vocabulary here still says "ticket" where the UI says "issue": the tool
 * NAMES are a wire contract that existing MCP clients call by string, so they
 * are left alone even though the model beneath them has moved. The descriptions
 * carry the new meaning.
 *
 * Identity arrives as a bearer session token (see `presentedToken()` in
 * `@/lib/session`), so an MCP client is precisely as privileged as the person
 * who minted the token — never more. A MEMBER's token cannot delete an
 * organization here any more than their browser can.
 *
 * Two actions are deliberately absent. `signOut` would revoke the very token
 * making the call, and `login`/`register` mint credentials — a caller holding a
 * token is already authenticated, and account creation stays a human act behind
 * the registration flag.
 */

/* -------------------------------------------------------------------------- */
/* Errors                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * A closed, author-written message safe to hand back to the model. Anything that
 * is NOT a ToolError is swallowed by the route and reported generically, so a
 * Prisma message or a stack can never reach the client (SPEC §4.7).
 */
export class ToolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ToolError';
    Object.setPrototypeOf(this, ToolError.prototype);
  }
}

/* -------------------------------------------------------------------------- */
/* Argument readers                                                            */
/* -------------------------------------------------------------------------- */

type Args = Record<string, unknown>;

function optionalString(args: Args, key: string): string | undefined {
  const value = args[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') throw new ToolError(`"${key}" must be a string.`);
  return value;
}

function requiredString(args: Args, key: string): string {
  const value = optionalString(args, key);
  if (value === undefined || value.trim() === '') throw new ToolError(`"${key}" is required.`);
  return value;
}

/** Ids are opaque and only ever come from a previous tool result. */
function requiredId(args: Args, key: string): string {
  const parsed = cuid.safeParse(requiredString(args, key));
  if (!parsed.success) {
    throw new ToolError(`"${key}" must be an id returned by a previous read (list_boards, get_organization, get_board, get_ticket or search_tickets).`);
  }
  return parsed.data;
}

/** `ENG-12` — the ref every read hands back, and the only handle a human types. */
const TICKET_REF = /^([A-Z][A-Z0-9]*)-([1-9][0-9]*)$/;

/** Postgres `Int`. A ref above this cannot name a row, so it is simply not found. */
const MAX_TICKET_NUMBER = 2_147_483_647;

/**
 * A ticket id, or the `ENG-12` ref reads return. Both land on the SAME
 * membership-scoped walk in `requireTicket`, so a ref reaches nothing an id
 * could not — it is a lookup, never an authorization.
 *
 * Every tool that takes a `ticketId` goes through here, so accepting refs is
 * one change rather than eight, and no tool can accidentally be left behind
 * taking cuids only.
 */
async function requireTicketArg(args: Args, key = 'ticketId'): Promise<TicketCtx> {
  const raw = requiredString(args, key).trim();

  if (cuid.safeParse(raw).success) return requireTicket(raw);

  const ref = TICKET_REF.exec(raw.toUpperCase());
  if (!ref) {
    throw new ToolError(
      `"${key}" must be an id returned by a previous read (get_board, get_ticket or search_tickets), or a ref like ENG-12.`,
    );
  }

  const number = Number(ref[2]);
  if (number > MAX_TICKET_NUMBER) throw new AuthzError('NOT_FOUND');

  const user = await requireUser();
  const matches = await prisma.ticket.findMany({
    where: {
      number,
      project: {
        key: ref[1],
        organization: { memberships: { some: { userId: user.id } } },
      },
    },
    // Deliberately not `findFirst`. Two organizations may each own a project
    // keyed ENG, and silently taking the first is how you edit the right ticket
    // at the wrong company. Ambiguity is reported, never guessed.
    select: { id: true, project: { select: { organization: { select: { name: true } } } } },
  });

  // Indistinguishable from a ticket in another tenant, exactly as an unknown id
  // is: there is no existence oracle here either.
  if (matches.length === 0) throw new AuthzError('NOT_FOUND');

  if (matches.length > 1) {
    const orgs = matches
      .map((row) => row.project.organization.name)
      .sort()
      .join(', ');
    throw new ToolError(
      `"${raw}" matches an issue in more than one organization (${orgs}). Pass the ticketId from get_board or search_tickets instead.`,
    );
  }

  return requireTicket(matches[0].id);
}

function optionalInt(args: Args, key: string): number | undefined {
  const value = args[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    throw new ToolError(`"${key}" must be a non-negative integer.`);
  }
  return value;
}

function requiredBoolean(args: Args, key: string): boolean {
  const value = args[key];
  if (typeof value !== 'boolean') throw new ToolError(`"${key}" must be true or false.`);
  return value;
}

/** FormData is the Server Action calling convention; these are its only inputs. */
function form(values: Record<string, string>): FormData {
  const formData = new FormData();
  for (const [key, value] of Object.entries(values)) formData.set(key, value);
  return formData;
}

/** Server Actions never throw for a rejection — they answer with a closed literal. */
function must(result: ActionResult): void {
  if (!result.ok) {
    const fields = result.fieldErrors ? ` (${Object.values(result.fieldErrors).join(' ')})` : '';
    throw new ToolError(`${result.error}${fields}`);
  }
}

/**
 * `redirect()` signals by THROWING, and encodes its destination in the thrown
 * error's digest: `NEXT_REDIRECT;<kind>;<url>;<status>;`.
 *
 * ponytail: that digest is a Next internal. If its shape ever changes the parse
 * returns null and the tool simply reports success without a `url` — degraded,
 * never wrong. Upgrade path: have the navigating actions return their path in
 * `ActionResult`.
 */
function redirectTarget(e: unknown): string | null {
  if (!isNextControlFlowError(e)) return null;
  const digest = (e as { digest?: unknown }).digest;
  if (typeof digest !== 'string' || !digest.startsWith('NEXT_REDIRECT')) return null;
  return digest.split(';')[2] ?? null;
}

/**
 * For the actions that navigate on success (every create, and the destructive
 * deletes). A thrown redirect is "done" here, and its URL is the most reliable
 * handle on what was just created — for a new board it literally contains the
 * new board id.
 */
async function runNavigating(run: () => Promise<ActionResult>): Promise<string | null> {
  try {
    must(await run());
    return null;
  } catch (e) {
    const target = redirectTarget(e);
    if (target !== null) return target;
    throw e;
  }
}

/** Last path segment of a redirect target — the new slug, key or id. */
function tailOf(path: string | null): string | null {
  if (!path) return null;
  const segments = path.split('?')[0].split('/').filter(Boolean);
  const last = segments[segments.length - 1];
  return last ? decodeURIComponent(last) : null;
}

/* -------------------------------------------------------------------------- */
/* Shared shaping                                                              */
/* -------------------------------------------------------------------------- */

/** Date-only, UTC — matching how `setIssueDueDate` stores it. */
function isoDate(value: Date | null): string | null {
  return value ? value.toISOString().slice(0, 10) : null;
}

/**
 * States are addressed by NAME ("In Progress") as well as by id, because a model
 * reasons in names. `projectId` must come from an authorized context: the lookup
 * below is the only thing scoping this query.
 *
 * The successor to `resolveColumn`. Workflow states belong to the PROJECT now,
 * so the same name resolves identically from any board in it — which is the
 * whole reason a board and the issue list can no longer disagree about status.
 */
async function resolveState(projectId: string, needle: string) {
  const states = await prisma.workflowState.findMany({
    where: { projectId },
    orderBy: STATE_ORDER,
    select: { id: true, name: true, type: true },
  });
  const wanted = needle.trim().toLowerCase();
  const match =
    states.find((state) => state.id === needle) ??
    states.find((state) => state.name.toLowerCase() === wanted);
  if (!match) {
    throw new ToolError(
      `No status "${needle}" in this project. Available: ${states.map((s) => s.name).join(', ')}.`,
    );
  }
  return match;
}

/** Boards are addressed by name or id, and the empty string means "no board". */
async function resolveBoard(projectId: string, needle: string): Promise<string> {
  if (needle.trim() === '') return '';
  const boards = await prisma.board.findMany({
    where: { projectId },
    orderBy: [{ name: 'asc' }, { id: 'asc' }],
    select: { id: true, name: true },
  });
  const wanted = needle.trim().toLowerCase();
  const match =
    boards.find((board) => board.id === needle) ??
    boards.find((board) => board.name.toLowerCase() === wanted);
  if (!match) {
    throw new ToolError(
      `No board "${needle}" in this project. Available: ${boards.map((b) => b.name).join(', ') || 'none'}.`,
    );
  }
  return match.id;
}

/** Labels are addressed by name or id. Unknown names are an error, not a silent drop. */
async function resolveLabels(projectId: string, names: string[]): Promise<string[]> {
  if (names.length === 0) return [];
  const labels = await prisma.label.findMany({
    where: { projectId },
    select: { id: true, name: true },
  });
  return names.map((needle) => {
    const wanted = needle.trim().toLowerCase();
    const match =
      labels.find((label) => label.id === needle) ??
      labels.find((label) => label.name.toLowerCase() === wanted);
    if (!match) {
      throw new ToolError(
        `No label "${needle}" in this project. Available: ${labels.map((l) => l.name).join(', ') || 'none'}.`,
      );
    }
    return match.id;
  });
}

/** People are addressed by email or id; never by display name, which is ambiguous. */
async function resolveMember(organizationId: string, needle: string): Promise<string> {
  const membership = await prisma.membership.findFirst({
    where: {
      organizationId,
      user: { OR: [{ id: needle }, { email: needle.trim().toLowerCase() }] },
    },
    select: { userId: true },
  });
  // NOT_FOUND rather than "no such user": assignment must not become a probe for
  // accounts outside this organization (SPEC §7.14).
  if (!membership) throw new ToolError('That person is not a member of this organization.');
  return membership.userId;
}

function enumOf<T extends string>(values: readonly T[], label: string, value: string): T {
  const wanted = value.trim().toUpperCase();
  const match = values.find((candidate) => candidate === wanted);
  if (!match) throw new ToolError(`"${label}" must be one of: ${values.join(', ')}.`);
  return match;
}

const PRIORITIES = Object.values(Priority);
const ROLES = Object.values(Role);

function boardSummary(ctx: BoardCtx) {
  return {
    boardId: ctx.board.id,
    board: ctx.board.name,
    project: ctx.project.name,
    projectKey: ctx.project.key,
    organization: ctx.org.name,
    orgSlug: ctx.org.slug,
    yourRole: ctx.role,
    url: boardPath(ctx.org, ctx.project, ctx.board),
  };
}

/* -------------------------------------------------------------------------- */
/* Tools                                                                       */
/* -------------------------------------------------------------------------- */

type Tool = {
  name: string;
  title: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
    additionalProperties: false;
  };
  annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean; idempotentHint?: boolean };
  run: (args: Args) => Promise<unknown>;
};

const STRING = { type: 'string' } as const;
const ORG_SLUG = { ...STRING, description: 'Organization slug, from list_boards.' } as const;
const PROJECT_KEY = { ...STRING, description: 'Project key, e.g. ENG.' } as const;
const TICKET_ID = {
  ...STRING,
  description: 'Issue id from a previous read, or a ref like ENG-12.',
} as const;

export const TOOLS: Tool[] = [
  /* ------------------------------------------------------------------ */
  /* Reading                                                             */
  /* ------------------------------------------------------------------ */

  {
    name: 'list_boards',
    title: 'List boards',
    description:
      'Every organization, project and board the signed-in user can reach, with the ids and slugs the other tools need. Start here.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true },
    run: async () => ({ organizations: await listNavTree() }),
  },

  {
    name: 'whoami',
    title: 'Who am I',
    description:
      'The person this token acts as. Every other tool is scoped to them, so this is who "assigned to me" means.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true },
    run: async () => {
      const user = await requireUser();
      // `sessionId` is deliberately not returned: it identifies the credential
      // rather than the person, and nothing outside `@/lib/session` needs it.
      return { userId: user.id, name: user.name, email: user.email };
    },
  },

  {
    name: 'get_organization',
    title: 'Read an organization',
    description:
      'One organization: your role in it, its members (with the membershipId that set_member_role and remove_member need), and its projects and boards.',
    inputSchema: {
      type: 'object',
      properties: { orgSlug: ORG_SLUG },
      required: ['orgSlug'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true },
    run: async (args) => {
      const ctx = await requireOrgBySlug(requiredString(args, 'orgSlug'));

      const [members, projects] = await Promise.all([
        prisma.membership.findMany({
          where: { organizationId: ctx.org.id },
          orderBy: [{ role: 'asc' }, { user: { name: 'asc' } }, { id: 'asc' }],
          select: {
            id: true,
            role: true,
            user: { select: { id: true, name: true, email: true } },
          },
        }),
        prisma.project.findMany({
          where: { organizationId: ctx.org.id },
          orderBy: [{ name: 'asc' }, { id: 'asc' }],
          select: {
            id: true,
            key: true,
            name: true,
            description: true,
            boards: {
              orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
              select: { id: true, name: true },
            },
          },
        }),
      ]);

      return {
        organization: ctx.org.name,
        orgSlug: ctx.org.slug,
        yourRole: ctx.role,
        url: orgPath(ctx.org),
        members: members.map((row) => ({
          membershipId: row.id,
          userId: row.user.id,
          name: row.user.name,
          email: row.user.email,
          role: row.role,
        })),
        projects: projects.map((project) => ({
          projectKey: project.key,
          name: project.name,
          description: project.description,
          boards: project.boards.map((board) => ({ boardId: board.id, name: board.name })),
        })),
      };
    },
  },

  {
    name: 'get_board',
    title: 'Read a board',
    description:
      "A board's issues, grouped by the PROJECT's workflow states in board order, plus the organization members who can be assigned work. A board owns no columns of its own.",
    inputSchema: {
      type: 'object',
      properties: { boardId: { ...STRING, description: 'From list_boards.' } },
      required: ['boardId'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true },
    run: async (args) => {
      const ctx = await requireBoard(requiredId(args, 'boardId'));

      // The columns are the PROJECT's workflow states, in board order. A board
      // owns none of its own; it shows a filtered slice of each state.
      const [states, tickets, members] = await Promise.all([
        listStates(ctx.project.id),
        prisma.ticket.findMany({
          where: { projectId: ctx.project.id, boardId: ctx.board.id },
          orderBy: TICKET_ORDER,
          select: {
            id: true,
            number: true,
            title: true,
            priority: true,
            dueDate: true,
            updatedAt: true,
            stateId: true,
            assignee: { select: { id: true, name: true } },
            labels: { select: { name: true } },
            _count: { select: { comments: true } },
          },
        }),
        prisma.membership.findMany({
          where: { organizationId: ctx.org.id },
          orderBy: [{ user: { name: 'asc' } }, { userId: 'asc' }],
          select: { role: true, user: { select: { id: true, name: true, email: true } } },
        }),
      ]);

      return {
        ...boardSummary(ctx),
        columns: states.map((state) => ({
          name: state.name,
          stateId: state.id,
          type: state.type,
          tickets: tickets
            .filter((ticket) => ticket.stateId === state.id)
            .map((ticket) => ({
              ticketId: ticket.id,
              ref: `${ctx.project.key}-${ticket.number}`,
              title: ticket.title,
              priority: ticket.priority,
              dueDate: isoDate(ticket.dueDate),
              assignee: ticket.assignee?.name ?? null,
              labels: ticket.labels.map((label) => label.name),
              comments: ticket._count.comments,
              updatedAt: ticket.updatedAt.toISOString(),
            })),
        })),
        members: members.map((row) => ({
          userId: row.user.id,
          name: row.user.name,
          email: row.user.email,
          role: row.role,
        })),
      };
    },
  },

  {
    name: 'get_ticket',
    title: 'Read a ticket',
    description:
      'One ticket in full: description, column, priority, due date, assignee and comments (with the commentId that update_comment and delete_comment need).',
    inputSchema: {
      type: 'object',
      properties: { ticketId: TICKET_ID },
      required: ['ticketId'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true },
    run: async (args) => {
      const ctx = await requireTicketArg(args);

      // Rooted at an id the walk above already authorized.
      const detail = await prisma.ticket.findFirst({
        where: { id: ctx.ticket.id, projectId: ctx.project.id },
        select: {
          priority: true,
          dueDate: true,
          startedAt: true,
          completedAt: true,
          createdAt: true,
          updatedAt: true,
          state: { select: { id: true, name: true, type: true } },
          board: { select: { id: true, name: true } },
          cycle: { select: { number: true, name: true } },
          parent: { select: { id: true, number: true, title: true } },
          labels: { orderBy: [{ name: 'asc' }], select: { name: true } },
          children: {
            orderBy: [{ number: 'asc' }],
            select: {
              id: true,
              number: true,
              title: true,
              state: { select: { name: true, type: true } },
            },
          },
          createdBy: { select: { name: true } },
          assignee: { select: { id: true, name: true, email: true } },
          comments: {
            orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
            select: {
              id: true,
              body: true,
              createdAt: true,
              author: { select: { name: true } },
            },
          },
        },
      });
      if (!detail) throw new AuthzError('NOT_FOUND');

      return {
        ticketId: ctx.ticket.id,
        ref: `${ctx.project.key}-${ctx.ticket.number}`,
        title: ctx.ticket.title,
        description: ctx.ticket.description,
        status: detail.state.name,
        statusType: detail.state.type,
        priority: detail.priority,
        dueDate: isoDate(detail.dueDate),
        assignee: detail.assignee,
        // Null is a legitimate answer for both: an issue need not be on a board
        // and need not be in a cycle.
        board: detail.board?.name ?? null,
        boardId: detail.board?.id ?? null,
        cycle: detail.cycle ? (detail.cycle.name ?? `Cycle ${detail.cycle.number}`) : null,
        labels: detail.labels.map((label) => label.name),
        parent: detail.parent
          ? {
              ticketId: detail.parent.id,
              ref: `${ctx.project.key}-${detail.parent.number}`,
              title: detail.parent.title,
            }
          : null,
        subIssues: detail.children.map((child) => ({
          ticketId: child.id,
          ref: `${ctx.project.key}-${child.number}`,
          title: child.title,
          status: child.state.name,
        })),
        createdBy: detail.createdBy.name,
        createdAt: detail.createdAt.toISOString(),
        startedAt: detail.startedAt?.toISOString() ?? null,
        completedAt: detail.completedAt?.toISOString() ?? null,
        updatedAt: detail.updatedAt.toISOString(),
        url: ticketPath(ctx.org, ctx.project, ctx.ticket.number),
        comments: detail.comments.map((comment) => ({
          commentId: comment.id,
          author: comment.author.name,
          createdAt: comment.createdAt.toISOString(),
          body: comment.body,
        })),
      };
    },
  },

  {
    name: 'search_tickets',
    title: 'Search tickets',
    description:
      'Case-insensitive substring search over ticket titles and descriptions, across every board the user can reach.',
    inputSchema: {
      type: 'object',
      properties: {
        query: STRING,
        limit: { type: 'integer', minimum: 1, maximum: 50, description: 'Default 20.' },
      },
      required: ['query'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true },
    run: async (args) => {
      const user = await requireUser();
      const query = requiredString(args, 'query');
      const limit = Math.min(optionalInt(args, 'limit') ?? 20, 50) || 20;

      // The membership predicate is part of the lookup, exactly as in @/lib/authz:
      // a ticket in another tenant is not "forbidden", it simply does not match.
      // Rooted at the PROJECT, not the board: an issue on no board is still an
      // issue, and walking through the board would have hidden every one of them.
      const rows = await prisma.ticket.findMany({
        where: {
          project: { organization: { memberships: { some: { userId: user.id } } } },
          OR: [
            { title: { contains: query, mode: 'insensitive' } },
            { description: { contains: query, mode: 'insensitive' } },
          ],
        },
        orderBy: [{ updatedAt: 'desc' }, { id: 'asc' }],
        take: limit,
        select: {
          id: true,
          number: true,
          title: true,
          priority: true,
          dueDate: true,
          updatedAt: true,
          state: { select: { name: true, type: true } },
          assignee: { select: { name: true } },
          board: { select: { id: true, name: true } },
          cycle: { select: { number: true } },
          labels: { select: { name: true } },
          project: { select: { key: true, name: true } },
        },
      });

      return {
        query,
        count: rows.length,
        tickets: rows.map((ticket) => ({
          ticketId: ticket.id,
          ref: `${ticket.project.key}-${ticket.number}`,
          title: ticket.title,
          status: ticket.state.name,
          statusType: ticket.state.type,
          priority: ticket.priority,
          dueDate: isoDate(ticket.dueDate),
          assignee: ticket.assignee?.name ?? null,
          board: ticket.board?.name ?? null,
          boardId: ticket.board?.id ?? null,
          cycle: ticket.cycle?.number ?? null,
          labels: ticket.labels.map((label) => label.name),
          project: ticket.project.name,
          updatedAt: ticket.updatedAt.toISOString(),
        })),
      };
    },
  },

  {
    name: 'get_project',
    title: 'Read a project',
    description:
      'A project (the team) and everything an issue can be set to: its workflow states with their types, its labels, its cycles and its boards. Read this before creating or moving issues.',
    inputSchema: {
      type: 'object',
      properties: { orgSlug: ORG_SLUG, projectKey: PROJECT_KEY },
      required: ['orgSlug', 'projectKey'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true },
    run: async (args) => {
      const ctx = await requireProjectByKeyInOrg(
        requiredString(args, 'orgSlug'),
        requiredString(args, 'projectKey').toUpperCase(),
      );

      // Materializes the current and upcoming cycles, exactly as the pages do,
      // so a model sees the same cycle numbers a person would.
      const cycleState = await ensureCycles(ctx.project.id);

      const [states, labels, boards, cycles] = await Promise.all([
        listStates(ctx.project.id),
        prisma.label.findMany({
          where: { projectId: ctx.project.id },
          orderBy: [{ name: 'asc' }, { id: 'asc' }],
          select: { id: true, name: true, color: true },
        }),
        prisma.board.findMany({
          where: { projectId: ctx.project.id },
          orderBy: [{ name: 'asc' }, { id: 'asc' }],
          select: { id: true, name: true, status: true, _count: { select: { tickets: true } } },
        }),
        prisma.cycle.findMany({
          where: {
            projectId: ctx.project.id,
            ...(cycleState ? { number: { gte: cycleState.current } } : {}),
          },
          orderBy: { number: 'asc' },
          select: { id: true, number: true, name: true, startsAt: true, endsAt: true },
        }),
      ]);

      return {
        project: ctx.project.name,
        projectKey: ctx.project.key,
        description: ctx.project.description,
        organization: ctx.org.name,
        orgSlug: ctx.org.slug,
        yourRole: ctx.role,
        url: projectPath(ctx.org, ctx.project),
        issuesUrl: issuesPath(ctx.org, ctx.project),
        cyclesUrl: cyclesPath(ctx.org, ctx.project),
        // `type` is what the app reasons about, not the name: it decides which
        // tab an issue falls under and whether it counts as done.
        states: states.map((state) => ({
          stateId: state.id,
          name: state.name,
          type: state.type,
        })),
        labels: labels.map((label) => ({ labelId: label.id, name: label.name })),
        boards: boards.map((board) => ({
          boardId: board.id,
          name: board.name,
          status: board.status,
          tickets: board._count.tickets,
        })),
        currentCycle: cycleState?.current ?? null,
        cycles: cycles.map((cycle) => ({
          cycleId: cycle.id,
          number: cycle.number,
          name: cycle.name,
          startsAt: cycle.startsAt.toISOString(),
          endsAt: cycle.endsAt.toISOString(),
          current: cycle.number === cycleState?.current,
        })),
      };
    },
  },

  /* ------------------------------------------------------------------ */
  /* Organizations and members                                           */
  /* ------------------------------------------------------------------ */

  {
    name: 'create_organization',
    title: 'Create an organization',
    description:
      'Create an organization. You become its OWNER. The slug is derived from the name when omitted, and a random suffix is added if it is taken.',
    inputSchema: {
      type: 'object',
      properties: {
        name: STRING,
        slug: { ...STRING, description: '2-40 lowercase letters, numbers or dashes.' },
      },
      required: ['name'],
      additionalProperties: false,
    },
    run: async (args) => {
      const slug = optionalString(args, 'slug');
      const target = await runNavigating(() =>
        createOrganization(
          null,
          form({ name: requiredString(args, 'name'), ...(slug ? { slug } : {}) }),
        ),
      );
      return { ok: true, orgSlug: tailOf(target), url: target };
    },
  },

  {
    name: 'rename_organization',
    title: 'Rename an organization',
    description: 'Change the display name. The slug and every existing URL stay as they are. ADMIN or OWNER.',
    inputSchema: {
      type: 'object',
      properties: { orgSlug: ORG_SLUG, name: STRING },
      required: ['orgSlug', 'name'],
      additionalProperties: false,
    },
    annotations: { idempotentHint: true },
    run: async (args) => {
      must(
        await renameOrganization(
          null,
          form({ orgSlug: requiredString(args, 'orgSlug'), name: requiredString(args, 'name') }),
        ),
      );
      return { ok: true, orgSlug: requiredString(args, 'orgSlug') };
    },
  },

  {
    name: 'delete_organization',
    title: 'Delete an organization',
    description:
      'Permanently delete an organization and every project, board, ticket and comment in it. OWNER only. `confirmName` must equal the organization name exactly — ask the user before calling this.',
    inputSchema: {
      type: 'object',
      properties: {
        orgSlug: ORG_SLUG,
        confirmName: { ...STRING, description: 'The exact organization name.' },
      },
      required: ['orgSlug', 'confirmName'],
      additionalProperties: false,
    },
    annotations: { destructiveHint: true },
    run: async (args) => {
      await runNavigating(() =>
        deleteOrganization(
          null,
          form({
            orgSlug: requiredString(args, 'orgSlug'),
            confirmName: requiredString(args, 'confirmName'),
          }),
        ),
      );
      return { ok: true, deleted: requiredString(args, 'orgSlug') };
    },
  },

  {
    name: 'add_member',
    title: 'Add a member',
    description:
      'Add someone to an organization by email. If they already have an account they are added immediately; if not, they are emailed an invitation that expires in 7 days and the membership is created when they accept. ADMIN or OWNER.',
    inputSchema: {
      type: 'object',
      properties: {
        orgSlug: ORG_SLUG,
        email: STRING,
        role: { type: 'string', enum: ['ADMIN', 'MEMBER'], description: 'Default MEMBER.' },
      },
      required: ['orgSlug', 'email'],
      additionalProperties: false,
    },
    run: async (args) => {
      const role = optionalString(args, 'role');
      must(
        await addMember(
          null,
          form({
            orgSlug: requiredString(args, 'orgSlug'),
            email: requiredString(args, 'email'),
            role: role ? enumOf(['ADMIN', 'MEMBER'] as const, 'role', role) : Role.MEMBER,
          }),
        ),
      );
      return { ok: true, added: requiredString(args, 'email') };
    },
  },

  {
    name: 'set_member_role',
    title: 'Change a member role',
    description:
      'Change someone\'s role. ADMIN or OWNER; granting OWNER is OWNER-only, and the last OWNER cannot be demoted.',
    inputSchema: {
      type: 'object',
      properties: {
        orgSlug: ORG_SLUG,
        membershipId: { ...STRING, description: 'From get_organization.' },
        role: { type: 'string', enum: ROLES },
      },
      required: ['orgSlug', 'membershipId', 'role'],
      additionalProperties: false,
    },
    annotations: { idempotentHint: true },
    run: async (args) => {
      const role = enumOf(ROLES, 'role', requiredString(args, 'role'));
      must(
        await changeMemberRole(
          null,
          form({
            orgSlug: requiredString(args, 'orgSlug'),
            membershipId: requiredId(args, 'membershipId'),
            role,
          }),
        ),
      );
      return { ok: true, role };
    },
  },

  {
    name: 'remove_member',
    title: 'Remove a member',
    description:
      'Remove someone from an organization. ADMIN or OWNER; only an OWNER may remove another OWNER, and the last OWNER cannot be removed. Their tickets and comments stay.',
    inputSchema: {
      type: 'object',
      properties: {
        orgSlug: ORG_SLUG,
        membershipId: { ...STRING, description: 'From get_organization.' },
      },
      required: ['orgSlug', 'membershipId'],
      additionalProperties: false,
    },
    annotations: { destructiveHint: true },
    run: async (args) => {
      must(
        await removeMember(
          null,
          form({
            orgSlug: requiredString(args, 'orgSlug'),
            membershipId: requiredId(args, 'membershipId'),
          }),
        ),
      );
      return { ok: true };
    },
  },

  /* ------------------------------------------------------------------ */
  /* Projects                                                            */
  /* ------------------------------------------------------------------ */

  {
    name: 'create_workspace',
    title: 'Create a workspace',
    description:
      'Create a workspace: a named group of projects inside an organization, and a URL segment. The URL slug is derived from the name when omitted. ADMIN or OWNER.',
    inputSchema: {
      type: 'object',
      properties: {
        orgSlug: ORG_SLUG,
        name: STRING,
        slug: { ...STRING, description: '2-40 lowercase letters, digits or dashes, e.g. platform.' },
      },
      required: ['orgSlug', 'name'],
      additionalProperties: false,
    },
    run: async (args) => {
      const slug = optionalString(args, 'slug');
      const target = await runNavigating(() =>
        createWorkspace(
          null,
          form({
            orgSlug: requiredString(args, 'orgSlug'),
            name: requiredString(args, 'name'),
            ...(slug ? { slug } : {}),
          }),
        ),
      );
      return { ok: true, workspaceSlug: tailOf(target), url: target };
    },
  },

  {
    name: 'create_project',
    title: 'Create a project',
    description:
      'Create a project inside a workspace. The key is derived from the name when omitted, and is unique across the organization. Omit `workspace` only when the organization has exactly one. ADMIN or OWNER.',
    inputSchema: {
      type: 'object',
      properties: {
        orgSlug: ORG_SLUG,
        workspace: {
          ...STRING,
          description: 'Workspace slug, from list_boards. Required once there is more than one.',
        },
        name: STRING,
        key: { ...STRING, description: '2-10 characters: a letter then letters or digits, e.g. ENG.' },
        description: STRING,
      },
      required: ['orgSlug', 'name'],
      additionalProperties: false,
    },
    run: async (args) => {
      const orgSlug = requiredString(args, 'orgSlug');
      const key = optionalString(args, 'key');
      const description = optionalString(args, 'description');

      // Resolve the destination rather than guessing it. One workspace is the
      // unambiguous case and stays a one-argument call; more than one is a
      // question only the caller can answer, so it is asked rather than assumed.
      let workspaceSlug = optionalString(args, 'workspace');
      if (!workspaceSlug) {
        const ctx = await requireOrgBySlug(orgSlug);
        const workspaces = await prisma.workspace.findMany({
          where: { organizationId: ctx.org.id },
          orderBy: [{ name: 'asc' }, { id: 'asc' }],
          select: { name: true, slug: true },
        });
        if (workspaces.length !== 1) {
          throw new ToolError(
            workspaces.length === 0
              ? 'This organization has no workspaces. Create one with create_workspace first.'
              : `Pass "workspace" — this organization has ${workspaces.length}: ${workspaces
                  .map((w) => w.slug)
                  .join(', ')}.`,
          );
        }
        workspaceSlug = workspaces[0].slug;
      }

      const target = await runNavigating(() =>
        createProject(
          null,
          form({
            orgSlug,
            workspaceSlug,
            name: requiredString(args, 'name'),
            ...(key ? { key } : {}),
            ...(description ? { description } : {}),
          }),
        ),
      );
      return { ok: true, projectKey: tailOf(target), url: target };
    },
  },

  {
    name: 'update_project',
    title: 'Update a project',
    description:
      'Change a project name or description. The key never changes. ADMIN or OWNER. Omitted fields are left alone.',
    inputSchema: {
      type: 'object',
      properties: {
        orgSlug: ORG_SLUG,
        projectKey: PROJECT_KEY,
        name: STRING,
        description: { ...STRING, description: 'Empty string clears it.' },
      },
      required: ['orgSlug', 'projectKey'],
      additionalProperties: false,
    },
    annotations: { idempotentHint: true },
    run: async (args) => {
      const orgSlug = requiredString(args, 'orgSlug');
      const projectKey = requiredString(args, 'projectKey');
      const name = optionalString(args, 'name');
      const description = optionalString(args, 'description');
      if (name === undefined && description === undefined) {
        throw new ToolError('Nothing to update — pass a name or a description.');
      }

      // updateProject writes BOTH columns and nulls an absent description, so the
      // untouched field is read back and re-sent rather than silently wiped.
      const current = await requireProjectByKeyInOrg(orgSlug, projectKey);

      must(
        await updateProject(
          null,
          form({
            orgSlug,
            projectKey,
            name: name ?? current.project.name,
            description: description ?? current.project.description ?? '',
          }),
        ),
      );
      return { ok: true, projectKey, url: projectPath(current.org, current.project) };
    },
  },

  {
    name: 'delete_project',
    title: 'Delete a project',
    description:
      'Permanently delete a project with every board, ticket and comment in it. ADMIN or OWNER. `confirmKey` must equal the project key exactly — ask the user before calling this.',
    inputSchema: {
      type: 'object',
      properties: {
        orgSlug: ORG_SLUG,
        projectKey: PROJECT_KEY,
        confirmKey: { ...STRING, description: 'The exact project key.' },
      },
      required: ['orgSlug', 'projectKey', 'confirmKey'],
      additionalProperties: false,
    },
    annotations: { destructiveHint: true },
    run: async (args) => {
      await runNavigating(() =>
        deleteProject(
          null,
          form({
            orgSlug: requiredString(args, 'orgSlug'),
            projectKey: requiredString(args, 'projectKey'),
            confirmKey: requiredString(args, 'confirmKey'),
          }),
        ),
      );
      return { ok: true, deleted: requiredString(args, 'projectKey') };
    },
  },

  /* ------------------------------------------------------------------ */
  /* Boards                                                              */
  /* ------------------------------------------------------------------ */

  {
    name: 'create_board',
    title: 'Create a board',
    description:
      'Create a board in a project. A board is a named grouping of issues (Linear calls it a project) and owns no columns of its own — its columns are the project\'s workflow states. ADMIN or OWNER.',
    inputSchema: {
      type: 'object',
      properties: { orgSlug: ORG_SLUG, projectKey: PROJECT_KEY, name: STRING },
      required: ['orgSlug', 'projectKey', 'name'],
      additionalProperties: false,
    },
    run: async (args) => {
      const target = await runNavigating(() =>
        createBoard(
          null,
          form({
            orgSlug: requiredString(args, 'orgSlug'),
            projectKey: requiredString(args, 'projectKey'),
            name: requiredString(args, 'name'),
          }),
        ),
      );
      return { ok: true, boardId: tailOf(target), url: target };
    },
  },

  {
    name: 'rename_board',
    title: 'Rename a board',
    description: 'Change a board name. ADMIN or OWNER.',
    inputSchema: {
      type: 'object',
      properties: { boardId: STRING, name: STRING },
      required: ['boardId', 'name'],
      additionalProperties: false,
    },
    annotations: { idempotentHint: true },
    run: async (args) => {
      must(
        await renameBoard(
          null,
          form({ boardId: requiredId(args, 'boardId'), name: requiredString(args, 'name') }),
        ),
      );
      return { ok: true, boardId: requiredId(args, 'boardId') };
    },
  },

  {
    name: 'delete_board',
    title: 'Delete a board',
    description:
      'Delete a board. Its issues SURVIVE — they simply lose the board and stay in the project. ADMIN or OWNER — ask the user before calling this.',
    inputSchema: {
      type: 'object',
      properties: { boardId: STRING },
      required: ['boardId'],
      additionalProperties: false,
    },
    annotations: { destructiveHint: true },
    run: async (args) => {
      const boardId = requiredId(args, 'boardId');
      await runNavigating(() => deleteBoard(null, form({ boardId })));
      return { ok: true, deleted: boardId };
    },
  },

  /* ------------------------------------------------------------------ */
  /* Tickets                                                             */
  /* ------------------------------------------------------------------ */

  {
    name: 'create_ticket',
    title: 'Create an issue',
    description:
      'Create an issue in a project. The board is OPTIONAL — an issue can belong to no board. Call get_project first for the available statuses, labels, boards and cycles.',
    inputSchema: {
      type: 'object',
      properties: {
        orgSlug: ORG_SLUG,
        projectKey: PROJECT_KEY,
        title: STRING,
        description: STRING,
        status: { ...STRING, description: 'Workflow state name or id. Defaults to the first non-backlog state.' },
        board: { ...STRING, description: 'Board name or id. Omit to file it under no board.' },
        cycle: { type: 'integer', minimum: 1, description: 'Cycle number, from get_project.' },
        priority: { type: 'string', enum: PRIORITIES },
        assignee: { ...STRING, description: 'Member email or userId.' },
        labels: { type: 'array', items: STRING, description: 'Label names or ids.' },
      },
      required: ['orgSlug', 'projectKey', 'title'],
      additionalProperties: false,
    },
    run: async (args) => {
      const user = await requireUser();
      const ctx = await requireProjectByKeyInOrg(
        requiredString(args, 'orgSlug'),
        requiredString(args, 'projectKey').toUpperCase(),
      );
      const title = requiredString(args, 'title');

      const wantedStatus = optionalString(args, 'status');
      const states = await listStates(ctx.project.id);
      const state = wantedStatus
        ? await resolveState(ctx.project.id, wantedStatus)
        : (states.find((candidate) => candidate.type !== 'BACKLOG') ??
          states[0] ??
          (() => {
            throw new ToolError('That project has no workflow states.');
          })());

      const boardName = optionalString(args, 'board');
      const boardId = boardName ? await resolveBoard(ctx.project.id, boardName) : '';

      const cycleNumber = optionalInt(args, 'cycle');
      let cycleId = '';
      if (cycleNumber !== undefined) {
        const cycle = await prisma.cycle.findFirst({
          where: { projectId: ctx.project.id, number: cycleNumber },
          select: { id: true },
        });
        if (!cycle) throw new ToolError(`No cycle ${cycleNumber} in this project.`);
        cycleId = cycle.id;
      }

      const assignee = optionalString(args, 'assignee');
      const assigneeId =
        assignee && assignee.trim() !== '' ? await resolveMember(ctx.org.id, assignee) : '';

      const rawLabels = args.labels;
      if (rawLabels !== undefined && !Array.isArray(rawLabels)) {
        throw new ToolError('"labels" must be an array of strings.');
      }
      const labelIds = await resolveLabels(
        ctx.project.id,
        (rawLabels ?? []).map((value) => String(value)),
      );

      const priority = optionalString(args, 'priority');

      const formData = form({
        projectId: ctx.project.id,
        stateId: state.id,
        title,
        description: optionalString(args, 'description') ?? '',
        boardId,
        cycleId,
        assigneeId,
        ...(priority ? { priority: enumOf(PRIORITIES, 'priority', priority) } : {}),
      });
      for (const id of labelIds) formData.append('labelIds', id);

      must(await createIssue(null, formData));

      // ponytail: the action returns no id, so the new row is found by
      // (project, creator, title) newest-first. Two identical titles created by
      // the same person in the same instant would return the newer of the two.
      // Upgrade path: have createIssue return the created id.
      const created = await prisma.ticket.findFirst({
        where: { projectId: ctx.project.id, createdById: user.id, title },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        select: { id: true, number: true },
      });

      return {
        ok: true,
        ticketId: created?.id ?? null,
        ref: created ? `${ctx.project.key}-${created.number}` : null,
        status: state.name,
        url: created
          ? ticketPath(ctx.org, ctx.project, created.number)
          : issuesPath(ctx.org, ctx.project),
      };
    },
  },

  {
    name: 'update_ticket',
    title: 'Update an issue',
    description:
      'Change any combination of title, description, priority, due date, assignee, board, cycle, labels and parent. Omitted fields are left alone; an empty string clears the ones that are nullable. Any member may edit any issue.',
    inputSchema: {
      type: 'object',
      properties: {
        ticketId: TICKET_ID,
        title: STRING,
        description: { ...STRING, description: 'Empty string clears it.' },
        priority: { type: 'string', enum: PRIORITIES },
        dueDate: { ...STRING, description: 'YYYY-MM-DD, or an empty string to clear it.' },
        assignee: { ...STRING, description: 'Member email or userId; empty string unassigns.' },
        board: { ...STRING, description: 'Board name or id; empty string files it under no board.' },
        cycle: {
          ...STRING,
          description: 'Cycle number as a string; empty string removes it from its cycle.',
        },
        labels: {
          type: 'array',
          items: STRING,
          description: 'Label names or ids. REPLACES the whole set; pass [] to clear.',
        },
        parent: {
          ...STRING,
          description: 'Parent issue id, making this a sub-issue; empty string detaches it.',
        },
      },
      required: ['ticketId'],
      additionalProperties: false,
    },
    annotations: { idempotentHint: true },
    run: async (args) => {
      const ctx = await requireTicketArg(args);
      const ticketId = ctx.ticket.id;
      const projectId = ctx.ticket.projectId;

      const title = optionalString(args, 'title');
      const description = optionalString(args, 'description');
      const priority = optionalString(args, 'priority');
      const dueDate = optionalString(args, 'dueDate');
      const assignee = optionalString(args, 'assignee');
      const board = optionalString(args, 'board');
      const cycle = optionalString(args, 'cycle');
      const parent = optionalString(args, 'parent');
      const rawLabels = args.labels;

      const changed: string[] = [];

      if (title !== undefined || description !== undefined) {
        // updateIssue writes both fields, so the untouched one is re-sent as-is.
        must(
          await updateIssue(
            null,
            form({
              ticketId,
              title: title ?? ctx.ticket.title,
              description: description ?? ctx.ticket.description ?? '',
            }),
          ),
        );
        if (title !== undefined) changed.push('title');
        if (description !== undefined) changed.push('description');
      }

      if (priority !== undefined) {
        must(await setIssuePriority({ ticketId, priority: enumOf(PRIORITIES, 'priority', priority) }));
        changed.push('priority');
      }

      if (dueDate !== undefined) {
        must(await setIssueDueDate({ ticketId, dueDate: dueDate.trim() === '' ? null : dueDate.trim() }));
        changed.push('dueDate');
      }

      if (assignee !== undefined) {
        const assigneeId = assignee.trim() === '' ? '' : await resolveMember(ctx.org.id, assignee);
        must(await setIssueAssignee({ ticketId, assigneeId }));
        changed.push('assignee');
      }

      if (board !== undefined) {
        must(await setIssueBoard({ ticketId, boardId: await resolveBoard(projectId, board) }));
        changed.push('board');
      }

      if (cycle !== undefined) {
        let cycleId = '';
        if (cycle.trim() !== '') {
          const number = Number.parseInt(cycle.trim(), 10);
          if (!Number.isInteger(number) || number < 1) {
            throw new ToolError('"cycle" must be a cycle number, or an empty string to clear it.');
          }
          const row = await prisma.cycle.findFirst({
            where: { projectId, number },
            select: { id: true },
          });
          if (!row) throw new ToolError(`No cycle ${number} in this project.`);
          cycleId = row.id;
        }
        must(await setIssueCycle({ ticketId, cycleId }));
        changed.push('cycle');
      }

      if (rawLabels !== undefined) {
        if (!Array.isArray(rawLabels)) throw new ToolError('"labels" must be an array of strings.');
        const labelIds = await resolveLabels(
          projectId,
          rawLabels.map((value) => String(value)),
        );
        must(await setIssueLabels({ ticketId, labelIds }));
        changed.push('labels');
      }

      if (parent !== undefined) {
        must(await setIssueParent({ ticketId, parentId: parent.trim() }));
        changed.push('parent');
      }

      if (changed.length === 0) throw new ToolError('Nothing to update — pass at least one field.');

      return {
        ok: true,
        ticketId,
        ref: `${ctx.project.key}-${ctx.ticket.number}`,
        updated: changed,
        url: ticketPath(ctx.org, ctx.project, ctx.ticket.number),
      };
    },
  },

  {
    name: 'move_ticket',
    title: 'Set an issue status',
    description:
      "Move an issue to another workflow state of its own project, optionally to a specific 0-based position. Appends when position is omitted. This is the ONE status an issue has — every board and list reflects it immediately.",
    inputSchema: {
      type: 'object',
      properties: {
        ticketId: TICKET_ID,
        status: { ...STRING, description: 'Target workflow state name or id, from get_project.' },
        position: { type: 'integer', minimum: 0, description: '0 puts it at the top.' },
      },
      required: ['ticketId', 'status'],
      additionalProperties: false,
    },
    annotations: { idempotentHint: true },
    run: async (args) => {
      const ctx = await requireTicketArg(args);
      // The issue's OWN project, from the authorized row — never a client id.
      const state = await resolveState(ctx.ticket.projectId, requiredString(args, 'status'));

      // placeIssue clamps to the end of the state, so the cap doubles as "append".
      // No `visibleIds`: a tool call has no viewport, so the index is an index
      // into the real set rather than into a filtered slice.
      must(
        await placeIssue({
          ticketId: ctx.ticket.id,
          toStateId: state.id,
          toIndex: optionalInt(args, 'position') ?? 10_000,
        }),
      );

      return {
        ok: true,
        ticketId: ctx.ticket.id,
        ref: `${ctx.project.key}-${ctx.ticket.number}`,
        status: state.name,
        statusType: state.type,
      };
    },
  },

  {
    name: 'move_ticket_to_board',
    title: 'Set an issue board',
    description:
      "File an issue under a different board of the SAME project, or under none. The issue keeps its ref and its status — a board is a grouping, not a container. Pass an empty string to remove it from every board.",
    inputSchema: {
      type: 'object',
      properties: {
        ticketId: TICKET_ID,
        board: { ...STRING, description: 'Board name or id; empty string for no board.' },
      },
      required: ['ticketId', 'board'],
      additionalProperties: false,
    },
    annotations: { idempotentHint: true },
    run: async (args) => {
      const ctx = await requireTicketArg(args);
      const boardId = await resolveBoard(ctx.ticket.projectId, requiredString(args, 'board'));
      must(await setIssueBoard({ ticketId: ctx.ticket.id, boardId }));

      // Re-read through the authorized walk so the caller sees the new board.
      const after = await requireTicket(ctx.ticket.id);
      return {
        ok: true,
        ticketId: after.ticket.id,
        ref: `${after.project.key}-${after.ticket.number}`,
        board: after.board?.name ?? null,
        url: ticketPath(after.org, after.project, after.ticket.number),
      };
    },
  },

  {
    name: 'delete_ticket',
    title: 'Delete an issue',
    description:
      'Permanently delete an issue and its comments. Any sub-issues survive and simply lose their parent. The issue author, or an ADMIN or OWNER — ask the user before calling this.',
    inputSchema: {
      type: 'object',
      properties: { ticketId: TICKET_ID },
      required: ['ticketId'],
      additionalProperties: false,
    },
    annotations: { destructiveHint: true },
    run: async (args) => {
      const ctx = await requireTicketArg(args);
      const ref = `${ctx.project.key}-${ctx.ticket.number}`;
      await runNavigating(() => deleteIssue(null, form({ ticketId: ctx.ticket.id })));
      return { ok: true, deleted: ref };
    },
  },

  /* ------------------------------------------------------------------ */
  /* Comments                                                            */
  /* ------------------------------------------------------------------ */

  {
    name: 'create_comment',
    title: 'Comment on a ticket',
    description: 'Post a comment, authored by the owner of the token. Any member may comment.',
    inputSchema: {
      type: 'object',
      properties: { ticketId: TICKET_ID, body: STRING },
      required: ['ticketId', 'body'],
      additionalProperties: false,
    },
    run: async (args) => {
      const ctx = await requireTicketArg(args);
      must(
        await createComment(
          null,
          form({ ticketId: ctx.ticket.id, body: requiredString(args, 'body') }),
        ),
      );
      return {
        ok: true,
        ref: `${ctx.project.key}-${ctx.ticket.number}`,
        url: ticketPath(ctx.org, ctx.project, ctx.ticket.number),
      };
    },
  },

  {
    name: 'update_comment',
    title: 'Edit a comment',
    description: 'Replace a comment body. The comment author, or an ADMIN or OWNER.',
    inputSchema: {
      type: 'object',
      properties: {
        commentId: { ...STRING, description: 'From get_ticket.' },
        body: STRING,
      },
      required: ['commentId', 'body'],
      additionalProperties: false,
    },
    annotations: { idempotentHint: true },
    run: async (args) => {
      must(
        await updateComment(
          null,
          form({
            commentId: requiredId(args, 'commentId'),
            body: requiredString(args, 'body'),
          }),
        ),
      );
      return { ok: true, commentId: requiredId(args, 'commentId') };
    },
  },

  {
    name: 'delete_comment',
    title: 'Delete a comment',
    description: 'Permanently delete a comment. The comment author, or an ADMIN or OWNER.',
    inputSchema: {
      type: 'object',
      properties: { commentId: { ...STRING, description: 'From get_ticket.' } },
      required: ['commentId'],
      additionalProperties: false,
    },
    annotations: { destructiveHint: true },
    run: async (args) => {
      const commentId = requiredId(args, 'commentId');
      must(await deleteComment(null, form({ commentId })));
      return { ok: true, deleted: commentId };
    },
  },

  /* ------------------------------------------------------------------ */
  /* Site administration                                                 */
  /*                                                                     */
  /* Instance-level, NOT tenant access: being a site admin governs who   */
  /* may register and who else is an admin, and grants no ability to     */
  /* read or write any organization's data. These three fail with        */
  /* "You don't have permission to do that." for everyone else.          */
  /* ------------------------------------------------------------------ */

  {
    name: 'admin_list_users',
    title: 'List accounts (site admin)',
    description:
      'Every account on the instance, and whether registration is currently open. Site administrators only.',
    inputSchema: {
      type: 'object',
      properties: { limit: { type: 'integer', minimum: 1, maximum: 500, description: 'Default 100.' } },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true },
    run: async (args) => {
      await requireAdmin();
      const limit = Math.min(optionalInt(args, 'limit') ?? 100, 500) || 100;

      const [users, total, settings, open] = await Promise.all([
        prisma.user.findMany({
          // Never `passwordHash`, and never a session token (SPEC §4.7).
          select: { id: true, name: true, email: true, isAdmin: true, createdAt: true },
          orderBy: [{ isAdmin: 'desc' }, { createdAt: 'asc' }, { id: 'asc' }],
          take: limit,
        }),
        prisma.user.count(),
        getAppSettings(),
        // The flag alone is not the answer: registration re-opens by itself while
        // the instance has no accounts, and this is the one helper that knows it.
        isRegistrationOpen(),
      ]);

      return {
        registrationEnabled: settings.registrationEnabled,
        registrationOpen: open,
        total,
        shown: users.length,
        users: users.map((user) => ({
          userId: user.id,
          name: user.name,
          email: user.email,
          isAdmin: user.isAdmin,
          createdAt: user.createdAt.toISOString(),
        })),
      };
    },
  },

  {
    name: 'admin_set_registration',
    title: 'Open or close registration (site admin)',
    description:
      'Open or close sign-ups for the whole instance. Site administrators only. Registration re-opens by itself while no account exists, so this cannot brick a fresh deployment.',
    inputSchema: {
      type: 'object',
      properties: { enabled: { type: 'boolean' } },
      required: ['enabled'],
      additionalProperties: false,
    },
    annotations: { idempotentHint: true },
    run: async (args) => {
      const enabled = requiredBoolean(args, 'enabled');
      must(await setRegistration(null, form({ enabled: String(enabled) })));
      return { ok: true, registrationEnabled: enabled };
    },
  },

  {
    name: 'admin_set_user_admin',
    title: 'Grant or revoke site admin',
    description:
      'Grant or revoke site-administrator access on an account. Site administrators only. You cannot revoke your own, and the last administrator cannot be removed.',
    inputSchema: {
      type: 'object',
      properties: {
        userId: { ...STRING, description: 'From admin_list_users.' },
        isAdmin: { type: 'boolean' },
      },
      required: ['userId', 'isAdmin'],
      additionalProperties: false,
    },
    annotations: { idempotentHint: true },
    run: async (args) => {
      const userId = requiredId(args, 'userId');
      const isAdmin = requiredBoolean(args, 'isAdmin');
      must(await setUserAdmin(null, form({ userId, isAdmin: String(isAdmin) })));
      return { ok: true, userId, isAdmin };
    },
  },
];

export const TOOLS_BY_NAME = new Map(TOOLS.map((tool) => [tool.name, tool]));

/** The wire shape for `tools/list` — everything except the handler. */
export function toolDescriptors() {
  return TOOLS.map(({ run: _run, ...descriptor }) => descriptor);
}
