import 'server-only';

import { Priority, Role } from '@prisma/client';

import {
  AuthzError,
  boardPath,
  isNextControlFlowError,
  orgPath,
  projectPath,
  requireAdmin,
  requireBoard,
  requireOrgBySlug,
  requireProjectByKey,
  requireTicket,
  requireUser,
  ticketPath,
  type BoardCtx,
} from '@/lib/authz';
import { prisma } from '@/lib/db';
import { listNavTree } from '@/lib/nav';
import type { ActionResult } from '@/lib/result';
import { getAppSettings, isRegistrationOpen } from '@/lib/settings';
import { COLUMN_ORDER, TICKET_ORDER, cuid } from '@/lib/validation';

import { setRegistration, setUserAdmin } from '@/app/(app)/admin/actions';
import { createOrganization } from '@/app/(app)/orgs/new/actions';
import { createProject } from '@/app/(app)/orgs/[orgSlug]/actions';
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
} from '@/app/(app)/orgs/[orgSlug]/[projectKey]/actions';
import {
  createTicket,
  moveTicketToBoard,
  placeTicket,
  setTicketDueDate,
  setTicketPriority,
} from '@/app/(app)/orgs/[orgSlug]/[projectKey]/[boardId]/actions';
import {
  assignTicket,
  createComment,
  deleteComment,
  deleteTicket,
  updateComment,
  updateTicket,
} from '@/app/(app)/orgs/[orgSlug]/[projectKey]/[boardId]/[ticketNumber]/actions';

/**
 * The MCP tool surface (transport lives in `src/app/api/mcp/route.ts`).
 *
 * It covers the whole application: organizations, members, projects, boards,
 * tickets, comments and site administration. Everything the web UI can do, a
 * model can do — under exactly the same rules.
 *
 * THIS FILE ADDS NO AUTHORIZATION OF ITS OWN, and that is the point. Every read
 * goes through a `require*` helper from `@/lib/authz` or is a nested/rooted
 * select under an id that helper already proved the caller may see; every write
 * is delegated to the SAME Server Action the web UI submits, so the zod parse,
 * the membership walk, the role checks, the last-owner and last-admin locks,
 * the `requireColumnInBoard` guard and the `revalidatePath` calls all still
 * happen exactly once, in one place.
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

/** Date-only, UTC — matching how `setTicketDueDate` stores it. */
function isoDate(value: Date | null): string | null {
  return value ? value.toISOString().slice(0, 10) : null;
}

/**
 * Columns are addressed by NAME ("In Progress") as well as by id, because a
 * model reasons in names. `boardId` must come from an authorized context: the
 * lookup below is the only thing scoping this query.
 */
async function resolveColumn(boardId: string, needle: string) {
  const columns = await prisma.boardColumn.findMany({
    where: { boardId },
    orderBy: COLUMN_ORDER,
    select: { id: true, name: true },
  });
  const wanted = needle.trim().toLowerCase();
  const match =
    columns.find((column) => column.id === needle) ??
    columns.find((column) => column.name.toLowerCase() === wanted);
  if (!match) {
    throw new ToolError(
      `No column "${needle}" on this board. Available: ${columns.map((c) => c.name).join(', ')}.`,
    );
  }
  return match;
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
      'Columns of a board with the tickets in each, in board order, plus the organization members who can be assigned work.',
    inputSchema: {
      type: 'object',
      properties: { boardId: { ...STRING, description: 'From list_boards.' } },
      required: ['boardId'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true },
    run: async (args) => {
      const ctx = await requireBoard(requiredId(args, 'boardId'));

      const columns = await prisma.boardColumn.findMany({
        where: { boardId: ctx.board.id },
        orderBy: COLUMN_ORDER,
        select: {
          id: true,
          name: true,
          tickets: {
            // Belt and braces against a divergent boardId/columnId pair (SPEC §8.7).
            where: { boardId: ctx.board.id },
            orderBy: TICKET_ORDER,
            select: {
              id: true,
              number: true,
              title: true,
              priority: true,
              dueDate: true,
              updatedAt: true,
              assignee: { select: { id: true, name: true } },
              _count: { select: { comments: true } },
            },
          },
        },
      });

      const members = await prisma.membership.findMany({
        where: { organizationId: ctx.org.id },
        orderBy: [{ user: { name: 'asc' } }, { userId: 'asc' }],
        select: { role: true, user: { select: { id: true, name: true, email: true } } },
      });

      return {
        ...boardSummary(ctx),
        columns: columns.map((column) => ({
          name: column.name,
          columnId: column.id,
          tickets: column.tickets.map((ticket) => ({
            ticketId: ticket.id,
            ref: `${ctx.project.key}-${ticket.number}`,
            title: ticket.title,
            priority: ticket.priority,
            dueDate: isoDate(ticket.dueDate),
            assignee: ticket.assignee?.name ?? null,
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
      properties: { ticketId: { ...STRING, description: 'From get_board or search_tickets.' } },
      required: ['ticketId'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true },
    run: async (args) => {
      const ctx = await requireTicket(requiredId(args, 'ticketId'));

      // Rooted at ids the walk above already authorized.
      const detail = await prisma.ticket.findFirst({
        where: { id: ctx.ticket.id, boardId: ctx.board.id },
        select: {
          priority: true,
          dueDate: true,
          createdAt: true,
          updatedAt: true,
          column: { select: { name: true } },
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
        column: detail.column.name,
        priority: detail.priority,
        dueDate: isoDate(detail.dueDate),
        assignee: detail.assignee,
        createdBy: detail.createdBy.name,
        createdAt: detail.createdAt.toISOString(),
        updatedAt: detail.updatedAt.toISOString(),
        url: ticketPath(ctx.org, ctx.project, ctx.board, ctx.ticket.number),
        boardId: ctx.board.id,
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
      const rows = await prisma.ticket.findMany({
        where: {
          board: { project: { organization: { memberships: { some: { userId: user.id } } } } },
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
          column: { select: { name: true } },
          assignee: { select: { name: true } },
          board: {
            select: { id: true, name: true, project: { select: { key: true, name: true } } },
          },
        },
      });

      return {
        query,
        count: rows.length,
        tickets: rows.map((ticket) => ({
          ticketId: ticket.id,
          ref: `${ticket.board.project.key}-${ticket.number}`,
          title: ticket.title,
          column: ticket.column.name,
          priority: ticket.priority,
          dueDate: isoDate(ticket.dueDate),
          assignee: ticket.assignee?.name ?? null,
          board: ticket.board.name,
          boardId: ticket.board.id,
          project: ticket.board.project.name,
          updatedAt: ticket.updatedAt.toISOString(),
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
      'Add an existing account to an organization by email. There is no invitation email — the person must already have registered. ADMIN or OWNER.',
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
    name: 'create_project',
    title: 'Create a project',
    description:
      'Create a project in an organization. The key is derived from the name when omitted. ADMIN or OWNER.',
    inputSchema: {
      type: 'object',
      properties: {
        orgSlug: ORG_SLUG,
        name: STRING,
        key: { ...STRING, description: '2-10 characters: a letter then letters or digits, e.g. ENG.' },
        description: STRING,
      },
      required: ['orgSlug', 'name'],
      additionalProperties: false,
    },
    run: async (args) => {
      const key = optionalString(args, 'key');
      const description = optionalString(args, 'description');
      const target = await runNavigating(() =>
        createProject(
          null,
          form({
            orgSlug: requiredString(args, 'orgSlug'),
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
      const current = await requireProjectByKey(orgSlug, projectKey);

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
      'Create a board in a project, seeded with the three columns To Do, In Progress and Done. ADMIN or OWNER.',
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
      'Permanently delete a board with its columns, tickets and comments. ADMIN or OWNER — ask the user before calling this.',
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
    title: 'Create a ticket',
    description: 'Add a ticket to a board. It lands at the bottom of the named column.',
    inputSchema: {
      type: 'object',
      properties: {
        boardId: { ...STRING, description: 'From list_boards.' },
        title: STRING,
        description: STRING,
        column: { ...STRING, description: 'Column name or id. Defaults to the first column.' },
      },
      required: ['boardId', 'title'],
      additionalProperties: false,
    },
    run: async (args) => {
      const user = await requireUser();
      const ctx = await requireBoard(requiredId(args, 'boardId'));
      const title = requiredString(args, 'title');
      const wanted = optionalString(args, 'column');

      const column = wanted
        ? await resolveColumn(ctx.board.id, wanted)
        : ((await prisma.boardColumn.findFirst({
            where: { boardId: ctx.board.id },
            orderBy: COLUMN_ORDER,
            select: { id: true, name: true },
          })) ?? (() => { throw new ToolError('That board has no columns.'); })());

      must(
        await createTicket(
          null,
          form({
            boardId: ctx.board.id,
            columnId: column.id,
            title,
            description: optionalString(args, 'description') ?? '',
          }),
        ),
      );

      // ponytail: the action returns no id, so the new row is found by
      // (board, creator, title) newest-first. Two identical titles created by the
      // same person in the same instant would return the newer of the two.
      // Upgrade path: have createTicket return the created id.
      const created = await prisma.ticket.findFirst({
        where: { boardId: ctx.board.id, createdById: user.id, title },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        select: { id: true, number: true },
      });

      return {
        ok: true,
        ticketId: created?.id ?? null,
        ref: created ? `${ctx.project.key}-${created.number}` : null,
        column: column.name,
        url: created
          ? ticketPath(ctx.org, ctx.project, ctx.board, created.number)
          : boardPath(ctx.org, ctx.project, ctx.board),
      };
    },
  },

  {
    name: 'update_ticket',
    title: 'Update a ticket',
    description:
      'Change any combination of title, description, priority, due date and assignee. Omitted fields are left alone. Any member may edit any ticket.',
    inputSchema: {
      type: 'object',
      properties: {
        ticketId: STRING,
        title: STRING,
        description: { ...STRING, description: 'Empty string clears it.' },
        priority: { type: 'string', enum: PRIORITIES },
        dueDate: { ...STRING, description: 'YYYY-MM-DD, or an empty string to clear it.' },
        assignee: { ...STRING, description: 'Member email or userId; empty string unassigns.' },
      },
      required: ['ticketId'],
      additionalProperties: false,
    },
    annotations: { idempotentHint: true },
    run: async (args) => {
      const ctx = await requireTicket(requiredId(args, 'ticketId'));
      const ticketId = ctx.ticket.id;

      const title = optionalString(args, 'title');
      const description = optionalString(args, 'description');
      const priority = optionalString(args, 'priority');
      const dueDate = optionalString(args, 'dueDate');
      const assignee = optionalString(args, 'assignee');

      const changed: string[] = [];

      if (title !== undefined || description !== undefined) {
        // updateTicket writes both fields, so the untouched one is re-sent as-is.
        must(
          await updateTicket(
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
        must(
          await setTicketPriority({ ticketId, priority: enumOf(PRIORITIES, 'priority', priority) }),
        );
        changed.push('priority');
      }

      if (dueDate !== undefined) {
        must(
          await setTicketDueDate({ ticketId, dueDate: dueDate.trim() === '' ? null : dueDate.trim() }),
        );
        changed.push('dueDate');
      }

      if (assignee !== undefined) {
        const assigneeId = assignee.trim() === '' ? '' : await resolveMember(ctx.org.id, assignee);
        must(await assignTicket(null, form({ ticketId, assigneeId })));
        changed.push('assignee');
      }

      if (changed.length === 0) throw new ToolError('Nothing to update — pass at least one field.');

      return {
        ok: true,
        ticketId,
        ref: `${ctx.project.key}-${ctx.ticket.number}`,
        updated: changed,
        url: ticketPath(ctx.org, ctx.project, ctx.board, ctx.ticket.number),
      };
    },
  },

  {
    name: 'move_ticket',
    title: 'Move a ticket',
    description:
      'Move a ticket to another column of its own board, optionally to a specific 0-based position. Appends when position is omitted.',
    inputSchema: {
      type: 'object',
      properties: {
        ticketId: STRING,
        column: { ...STRING, description: 'Target column name or id.' },
        position: { type: 'integer', minimum: 0, description: '0 puts it at the top.' },
      },
      required: ['ticketId', 'column'],
      additionalProperties: false,
    },
    annotations: { idempotentHint: true },
    run: async (args) => {
      const ctx = await requireTicket(requiredId(args, 'ticketId'));
      // The ticket's OWN board, from the authorized row — never a client id.
      const column = await resolveColumn(ctx.ticket.boardId, requiredString(args, 'column'));

      // placeTicket clamps to the end of the column, so the cap doubles as "append".
      must(
        await placeTicket({
          ticketId: ctx.ticket.id,
          toColumnId: column.id,
          toIndex: optionalInt(args, 'position') ?? 10_000,
        }),
      );

      return {
        ok: true,
        ticketId: ctx.ticket.id,
        ref: `${ctx.project.key}-${ctx.ticket.number}`,
        column: column.name,
      };
    },
  },

  {
    name: 'move_ticket_to_board',
    title: 'Move a ticket to another board',
    description:
      'Move a ticket to a different board in the SAME project. It lands in that board\'s first column and is renumbered, so its ref changes.',
    inputSchema: {
      type: 'object',
      properties: { ticketId: STRING, toBoardId: { ...STRING, description: 'From list_boards.' } },
      required: ['ticketId', 'toBoardId'],
      additionalProperties: false,
    },
    run: async (args) => {
      const ticketId = requiredId(args, 'ticketId');
      must(await moveTicketToBoard({ ticketId, toBoardId: requiredId(args, 'toBoardId') }));

      // Re-read through the authorized walk so the caller gets the NEW ref.
      const ctx = await requireTicket(ticketId);
      return {
        ok: true,
        ticketId,
        ref: `${ctx.project.key}-${ctx.ticket.number}`,
        board: ctx.board.name,
        url: ticketPath(ctx.org, ctx.project, ctx.board, ctx.ticket.number),
      };
    },
  },

  {
    name: 'delete_ticket',
    title: 'Delete a ticket',
    description:
      'Permanently delete a ticket and its comments. The ticket author, or an ADMIN or OWNER — ask the user before calling this.',
    inputSchema: {
      type: 'object',
      properties: { ticketId: STRING },
      required: ['ticketId'],
      additionalProperties: false,
    },
    annotations: { destructiveHint: true },
    run: async (args) => {
      const ctx = await requireTicket(requiredId(args, 'ticketId'));
      const ref = `${ctx.project.key}-${ctx.ticket.number}`;
      await runNavigating(() => deleteTicket(null, form({ ticketId: ctx.ticket.id })));
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
      properties: { ticketId: STRING, body: STRING },
      required: ['ticketId', 'body'],
      additionalProperties: false,
    },
    run: async (args) => {
      const ctx = await requireTicket(requiredId(args, 'ticketId'));
      must(
        await createComment(
          null,
          form({ ticketId: ctx.ticket.id, body: requiredString(args, 'body') }),
        ),
      );
      return {
        ok: true,
        ref: `${ctx.project.key}-${ctx.ticket.number}`,
        url: ticketPath(ctx.org, ctx.project, ctx.board, ctx.ticket.number),
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
