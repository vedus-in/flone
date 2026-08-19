import 'server-only';

import { Priority, ReminderChannel, ReminderRepeat, Role, TicketRepeat } from '@prisma/client';

import {
  AuthzError,
  boardPath,
  challengesPath,
  cyclesPath,
  docsPath,
  documentPath,
  isNextControlFlowError,
  issuesPath,
  publicDocumentPath,
  orgPath,
  projectPath,
  projectSettingsPath,
  recurringPath,
  remindersPath,
  requireAdmin,
  requireBoard,
  requireDocument,
  requireOrgBySlug,
  // Tools address a project by (orgSlug, projectKey) and have no URL to prove
  // canonical, so they use the workspace-free loader -- same authorization, one
  // fewer argument every caller would have to look up first.
  requireProjectByKeyInOrg,
  requireTicket,
  requireUser,
  ticketPath,
  viewsPath,
  visibleProject,
  type BoardCtx,
  type TicketCtx,
} from '@/lib/authz';
import { prisma } from '@/lib/db';
import { CHALLENGE_COLUMNS, columnForStateType } from '@/lib/challenges';
import { ensureCycles } from '@/lib/cycles';
import { ancestorChain, descendantIds, flattenTree } from '@/lib/documents';
import { appUrl } from '@/lib/email';
import { listNavTree } from '@/lib/nav';
import {
  CHANNEL_CALLS,
  CHANNEL_EMAILS,
  CHANNEL_LABEL,
  REPEAT_LABEL,
  TICKET_REPEAT_LABEL,
  formatWhen,
} from '@/lib/reminder-math';
import type { ActionResult } from '@/lib/result';
import { getAppSettings, isRegistrationOpen } from '@/lib/settings';
import { listStates } from '@/lib/states';
import { COLOR_TOKENS, STATE_ORDER, TICKET_ORDER, cuid } from '@/lib/validation';

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
  createLabel,
  createSavedView,
  deleteBoard,
  deleteLabel,
  deleteProject,
  deleteSavedView,
  renameBoard,
  updateLabel,
  updateProject,
} from '@/app/(app)/orgs/[orgSlug]/[workspaceSlug]/[projectKey]/actions';
import {
  addChallenge,
  moveChallenge,
  removeChallenge,
} from '@/app/(app)/orgs/[orgSlug]/challenges/actions';
import {
  createReminder,
  deleteReminder,
} from '@/app/(app)/orgs/[orgSlug]/reminders/actions';
import {
  createDocument,
  deleteDocument,
  moveDocument,
  setDocumentShared,
  updateDocument,
} from '@/app/(app)/orgs/[orgSlug]/[workspaceSlug]/[projectKey]/docs/actions';
import {
  createRecurringTicket,
  deleteRecurringTicket,
  setRecurringTicketPaused,
  updateRecurringTicket,
} from '@/app/(app)/orgs/[orgSlug]/[workspaceSlug]/[projectKey]/recurring/actions';
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
 * It covers organizations, members, projects, boards, issues, comments,
 * documents, the per-person Daily Challenges board, scheduled reminders,
 * recurring tickets, saved views and site administration. Workflow states,
 * labels and cycles are readable and referable by name, but not yet editable
 * here — see the gap list at the foot of this comment.
 *
 * What a model CAN do, it does under exactly the same rules as the web UI.
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
 * Deliberately absent, and the list is exhaustive. `signOut` would revoke the
 * very token making the call. `login` / `register` mint credentials — a caller
 * holding a token is already authenticated, and account creation stays a human
 * act behind the registration flag. `createMcpToken` mints a credential for the
 * same reason, and phone verification places a real phone call, which is not
 * something a model should be able to trigger on a colleague's handset.
 *
 * NOT everything the web UI can do is here yet. Known read/write gaps, none of
 * them load-bearing for the tools above: workflow-state and label CRUD, cycle
 * configuration, workspace rename/delete/reorder, notification preferences,
 * pending-invitation visibility, and board colour/lead/target-date.
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
    throw new ToolError(`"${key}" must be an id returned by a previous read (get_organization, get_project, get_board, get_ticket or search_tickets).`);
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
      project: visibleProject(user.id, { key: ref[1] }),
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

/**
 * `tzOffsetMinutes`, which is SIGNED — Berlin in summer is -120.
 *
 * Read here rather than through `optionalInt`, whose non-negative rule would
 * reject every timezone east of Greenwich. Defaults to 0, i.e. the wall clock
 * the caller gave is UTC: there is no browser on this side of the API to ask,
 * and guessing a zone from the server's own clock is how a reminder arrives at
 * the wrong hour in a country nobody involved is in.
 */
function signedOffset(args: Args): number {
  const raw = args.tzOffsetMinutes;
  if (raw === undefined || raw === null) return 0;
  if (!Number.isInteger(raw)) {
    throw new ToolError('"tzOffsetMinutes" must be a whole number of minutes.');
  }
  return raw as number;
}

function requiredBoolean(args: Args, key: string): boolean {
  const value = args[key];
  if (typeof value !== 'boolean') throw new ToolError(`"${key}" must be true or false.`);
  return value;
}

/**
 * FormData is the Server Action calling convention; these are its only inputs.
 *
 * An array value is APPENDED once per entry, because that is how a browser
 * submits a repeated field -- a checkbox group, a multi-select -- and how
 * `fieldList` on the other side expects to read it back.
 */
function form(values: Record<string, string | string[]>): FormData {
  const formData = new FormData();
  for (const [key, value] of Object.entries(values)) {
    if (Array.isArray(value)) for (const entry of value) formData.append(key, entry);
    else formData.set(key, value);
  }
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

/**
 * Documents are addressed by TITLE as well as by id, for the same reason states
 * and boards are: a model reasons in names, and a document's id is a cuid nobody
 * types. `projectId` must come from an authorized context -- it is the only thing
 * scoping this query.
 *
 * An ambiguous title is reported rather than guessed at. Two sibling pages called
 * "Overview" is a completely ordinary thing to have, and silently editing the
 * wrong one is not recoverable through the UI.
 */
async function resolveDocument(projectId: string, needle: string): Promise<string> {
  const documents = await prisma.document.findMany({
    where: { projectId },
    orderBy: [{ title: 'asc' }, { id: 'asc' }],
    select: { id: true, title: true },
  });

  const byId = documents.find((document) => document.id === needle);
  if (byId) return byId.id;

  const wanted = needle.trim().toLowerCase();
  const matches = documents.filter((document) => document.title.toLowerCase() === wanted);
  if (matches.length === 1) return matches[0].id;
  if (matches.length > 1) {
    throw new ToolError(
      `More than one document in this project is called "${needle}". Pass the documentId from list_documents instead.`,
    );
  }
  throw new ToolError(
    `No document "${needle}" in this project. Call list_documents to see what is there.`,
  );
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

/**
 * A palette token.
 *
 * NOT `enumOf`, which upper-cases its input because every Prisma enum here is
 * upper-case. Colour tokens are the one closed vocabulary in this file that is
 * lower-case (`gray`, `brand`, ...), so routing them through `enumOf` would
 * compare "GRAY" against "gray" and reject every valid colour.
 */
function colorToken(value: string): (typeof COLOR_TOKENS)[number] {
  const wanted = value.trim().toLowerCase();
  const match = COLOR_TOKENS.find((candidate) => candidate === wanted);
  if (!match) throw new ToolError(`"color" must be one of: ${COLOR_TOKENS.join(', ')}.`);
  return match;
}

function enumOf<T extends string>(values: readonly T[], label: string, value: string): T {
  const wanted = value.trim().toUpperCase();
  const match = values.find((candidate) => candidate === wanted);
  if (!match) throw new ToolError(`"${label}" must be one of: ${values.join(', ')}.`);
  return match;
}

const PRIORITIES = Object.values(Priority);
const ROLES = Object.values(Role);
const REPEATS = Object.values(ReminderRepeat);
const CHANNELS = Object.values(ReminderChannel);
/** No ONCE here: a one-time pre-filled ticket is `create_ticket`. */
const TICKET_REPEATS = Object.values(TicketRepeat);
const CHALLENGE_COLUMN_IDS = CHALLENGE_COLUMNS.map((column) => column.id);

/**
 * A reminder's recipient, addressed the way a model has one to hand: an email,
 * a userId, or nothing at all for the caller themselves.
 *
 * Resolved through the MEMBERSHIP table of an organization the caller has
 * already been authorized for, so an address outside it is simply not found --
 * this cannot be turned into a way to discover who holds an account elsewhere.
 * `createReminder` re-checks membership with `assertOrgMember` regardless; this
 * only spares the caller having to look an id up first.
 */
async function resolveRecipient(organizationId: string, needle: string): Promise<string> {
  const wanted = needle.trim();
  const membership = await prisma.membership.findFirst({
    where: {
      organizationId,
      OR: [{ userId: wanted }, { user: { email: wanted.toLowerCase() } }],
    },
    select: { userId: true },
  });
  if (!membership) {
    throw new ToolError(
      `No member "${needle}" in this organization. Use get_organization to list who is in it.`,
    );
  }
  return membership.userId;
}

/**
 * The recipient list, from either `recipients` (an array) or `recipient` (one),
 * defaulting to the caller. Both spellings are accepted because the single form
 * was published first and a client may already be calling it.
 */
async function resolveRecipients(organizationId: string, args: Args): Promise<string[]> {
  const many = args.recipients;
  if (many !== undefined && many !== null) {
    if (!Array.isArray(many) || many.some((value) => typeof value !== 'string')) {
      throw new ToolError('"recipients" must be an array of emails or userIds.');
    }
    const names = (many as string[]).map((value) => value.trim()).filter(Boolean);
    if (names.length === 0) throw new ToolError('"recipients" must name at least one person.');
    const ids = await Promise.all(names.map((name) => resolveRecipient(organizationId, name)));
    // Two spellings of the same person -- an email and their userId -- must not
    // become two identical reminders.
    return [...new Set(ids)];
  }

  const one = optionalString(args, 'recipient');
  if (one !== undefined && one.trim() !== '') {
    return [await resolveRecipient(organizationId, one)];
  }

  const user = await requireUser();
  return [user.id];
}

/**
 * The wall clock `createReminder` expects: `YYYY-MM-DDTHH:mm`.
 *
 * Models reach for a full ISO instant far more often than for this, so a
 * trailing `:ss` and a trailing `Z` are trimmed rather than rejected. Both are
 * safe to drop: seconds are below a reminder's resolution, and `Z` agrees with
 * the UTC default that `tzOffsetMinutes` already carries. Anything else is an
 * error the model can act on rather than a time silently landing elsewhere.
 */
function reminderWallClock(raw: string): string {
  // Captured rather than trimmed: a bare `2026-08-20T09:00` ends in `:00` too,
  // so stripping a trailing `:\d\d` would eat the MINUTES and schedule the
  // reminder for midnight.
  const match = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2})(?::\d{2})?(?:\.\d+)?Z?$/.exec(raw.trim());
  if (!match) {
    throw new ToolError(
      `"runAt" must look like 2026-08-20T09:00 (a wall clock, not an instant). Got "${raw}".`,
    );
  }
  return `${match[1]}T${match[2]}`;
}

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
const DOCUMENT_ID = { ...STRING, description: 'Document id, from list_documents.' } as const;

export const TOOLS: Tool[] = [
  /* ------------------------------------------------------------------ */
  /* Reading                                                             */
  /* ------------------------------------------------------------------ */

  {
    name: 'list_boards',
    title: 'List boards',
    description:
      'Every organization, workspace and project the signed-in user can reach, with the slugs and keys the other tools need. Start here. It does NOT return boards — those come from get_organization or get_project.',
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
          where: visibleProject(ctx.user.id, { organizationId: ctx.org.id }),
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
      properties: {
        boardId: { ...STRING, description: 'From get_organization or get_project.' },
      },
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
          project: visibleProject(user.id),
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
        // `color` is selected above and was being dropped here, which left
        // update_label unable to preserve a colour it could not read.
        labels: labels.map((label) => ({
          labelId: label.id,
          name: label.name,
          color: label.color,
        })),
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
  /* Labels                                                              */
  /*                                                                     */
  /* Per-project and shared by everyone in it. Read them from            */
  /* get_project; every tool that takes labels accepts a NAME, so these  */
  /* exist so a model can create the one it wants rather than failing on */
  /* "No label X in this project".                                       */
  /* ------------------------------------------------------------------ */

  {
    name: 'create_label',
    title: 'Create a label',
    description:
      'Add a label to a project. Names are unique within the project and case-sensitive as stored. ADMIN or OWNER only. Read get_project first — a label that already exists is an error, not a no-op.',
    inputSchema: {
      type: 'object',
      properties: {
        orgSlug: ORG_SLUG,
        projectKey: PROJECT_KEY,
        name: { ...STRING, description: 'Label name, 1 to 40 characters.' },
        color: {
          ...STRING,
          enum: COLOR_TOKENS,
          description: 'Palette token, not a hex value. Defaults to gray.',
        },
      },
      required: ['orgSlug', 'projectKey', 'name'],
      additionalProperties: false,
    },
    run: async (args) => {
      const ctx = await requireProjectByKeyInOrg(
        requiredString(args, 'orgSlug'),
        requiredString(args, 'projectKey').toUpperCase(),
      );
      const color = optionalString(args, 'color');

      must(
        await createLabel(
          null,
          form({
            projectId: ctx.project.id,
            name: requiredString(args, 'name'),
            ...(color ? { color: colorToken(color) } : {}),
          }),
        ),
      );

      return { ok: true, url: projectSettingsPath(ctx.org, ctx.project) };
    },
  },

  {
    name: 'update_label',
    title: 'Rename or recolour a label',
    description:
      'Change a label\'s name or colour. Only the fields you pass change. Renaming keeps it on every issue that carries it — it is the same label. ADMIN or OWNER only.',
    inputSchema: {
      type: 'object',
      properties: {
        orgSlug: ORG_SLUG,
        projectKey: PROJECT_KEY,
        label: { ...STRING, description: 'Current label name or id, from get_project.' },
        name: { ...STRING, description: 'New name.' },
        color: { ...STRING, enum: COLOR_TOKENS, description: 'New palette token.' },
      },
      required: ['orgSlug', 'projectKey', 'label'],
      additionalProperties: false,
    },
    annotations: { idempotentHint: true },
    run: async (args) => {
      const ctx = await requireProjectByKeyInOrg(
        requiredString(args, 'orgSlug'),
        requiredString(args, 'projectKey').toUpperCase(),
      );

      // Name or id, the same way every other tool addresses a label.
      const [labelId] = await resolveLabels(ctx.project.id, [requiredString(args, 'label')]);

      // `updateLabel` demands BOTH name and colour -- the web form submits every
      // field every time -- so a tool naming one of them would silently reset
      // the other. The current row is read first and the arguments merged over
      // it. Scoped to the authorized project, so a foreign id is not found.
      const current = await prisma.label.findFirst({
        where: { id: labelId, projectId: ctx.project.id },
        select: { name: true, color: true },
      });
      if (!current) throw new AuthzError('NOT_FOUND');

      const color = optionalString(args, 'color');

      must(
        await updateLabel(
          null,
          form({
            projectId: ctx.project.id,
            labelId,
            name: optionalString(args, 'name') ?? current.name,
            color: color ? colorToken(color) : current.color,
          }),
        ),
      );

      return { ok: true, url: projectSettingsPath(ctx.org, ctx.project) };
    },
  },

  {
    name: 'delete_label',
    title: 'Delete a label',
    description:
      'Remove a label from a project. The issues that carried it are NOT deleted — they simply lose the tag, and nothing else about them changes. This cannot be undone; recreating the label does not re-tag anything. ADMIN or OWNER only.',
    inputSchema: {
      type: 'object',
      properties: {
        orgSlug: ORG_SLUG,
        projectKey: PROJECT_KEY,
        label: { ...STRING, description: 'Label name or id, from get_project.' },
      },
      required: ['orgSlug', 'projectKey', 'label'],
      additionalProperties: false,
    },
    annotations: { destructiveHint: true },
    run: async (args) => {
      const ctx = await requireProjectByKeyInOrg(
        requiredString(args, 'orgSlug'),
        requiredString(args, 'projectKey').toUpperCase(),
      );
      const [labelId] = await resolveLabels(ctx.project.id, [requiredString(args, 'label')]);

      // How many issues are about to lose the tag, counted BEFORE the delete --
      // afterwards the join rows are gone and the number is unknowable. A model
      // reporting "removed from 14 issues" is the difference between a deletion
      // somebody notices and one they discover a week later.
      const tagged = await prisma.ticket.count({
        where: { projectId: ctx.project.id, labels: { some: { id: labelId } } },
      });

      must(await deleteLabel(null, form({ projectId: ctx.project.id, labelId })));

      return { ok: true, deleted: labelId, untaggedIssues: tagged };
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
  /* Daily Challenges                                                    */
  /*                                                                     */
  /* PRIVATE BY CONSTRUCTION. Every query below is keyed on the session's */
  /* own user id, so there is no argument anywhere in this section that   */
  /* could name another person's board -- no filter to forget and no role */
  /* to check. Picking is per-person; the status a move writes is not.    */
  /* ------------------------------------------------------------------ */

  {
    name: 'list_challenges',
    title: 'Read your Daily Challenges board',
    description:
      "The signed-in user's own cherry-picked board for one organization, grouped by column. Picks are private: this is never anyone else's board.",
    inputSchema: {
      type: 'object',
      properties: { orgSlug: ORG_SLUG },
      required: ['orgSlug'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true },
    run: async (args) => {
      const ctx = await requireOrgBySlug(requiredString(args, 'orgSlug'));

      const picks = await prisma.challengePick.findMany({
        where: {
          userId: ctx.user.id,
          ticket: { project: { organizationId: ctx.org.id } },
        },
        // Same order the page renders in, arrangement included, so a caller
        // reads the board the person actually sees.
        orderBy: [
          { position: 'asc' },
          { ticket: { priority: 'desc' } },
          { ticket: { updatedAt: 'desc' } },
          { id: 'asc' },
        ],
        select: {
          ticket: {
            select: {
              id: true,
              number: true,
              title: true,
              priority: true,
              state: { select: { name: true, type: true } },
              project: {
                select: { name: true, key: true, workspace: { select: { slug: true } } },
              },
            },
          },
        },
      });

      const columns = Object.fromEntries(
        CHALLENGE_COLUMNS.map((column) => [column.id, [] as unknown[]]),
      );

      for (const { ticket } of picks) {
        columns[columnForStateType(ticket.state.type)].push({
          ticketId: ticket.id,
          ref: `${ticket.project.key}-${ticket.number}`,
          title: ticket.title,
          status: ticket.state.name,
          priority: ticket.priority,
          project: ticket.project.name,
          url: ticketPath(
            ctx.org,
            {
              id: '',
              name: ticket.project.name,
              key: ticket.project.key,
              description: null,
              workspaceSlug: ticket.project.workspace.slug,
            },
            ticket.number,
          ),
        });
      }

      return {
        organization: ctx.org.name,
        url: challengesPath(ctx.org),
        // Named so a caller knows what each column MEANS before moving a card
        // into it -- in particular that "completed" writes no status at all.
        columns: CHALLENGE_COLUMNS.map((column) => ({
          id: column.id,
          name: column.name,
          meaning: column.hint,
          setsStatus: column.sets,
          issues: columns[column.id],
        })),
      };
    },
  },

  {
    name: 'add_challenge',
    title: 'Pick up an issue',
    description:
      "Put an issue on the signed-in user's own Daily Challenges board. Writes nothing to the issue, so nobody else's view changes. Picking the same issue twice is a no-op.",
    inputSchema: {
      type: 'object',
      properties: { ticketId: TICKET_ID },
      required: ['ticketId'],
      additionalProperties: false,
    },
    annotations: { idempotentHint: true },
    run: async (args) => {
      const ctx = await requireTicketArg(args);
      must(await addChallenge({ ticketId: ctx.ticket.id }));
      return {
        ok: true,
        ticketId: ctx.ticket.id,
        ref: `${ctx.project.key}-${ctx.ticket.number}`,
        url: challengesPath(ctx.org),
      };
    },
  },

  {
    name: 'remove_challenge',
    title: 'Drop an issue from your board',
    description:
      "Take an issue off the signed-in user's own board. Writes nothing to the issue itself — its status is untouched.",
    inputSchema: {
      type: 'object',
      properties: { ticketId: TICKET_ID },
      required: ['ticketId'],
      additionalProperties: false,
    },
    annotations: { idempotentHint: true },
    run: async (args) => {
      const ctx = await requireTicketArg(args);
      must(await removeChallenge({ ticketId: ctx.ticket.id }));
      return { ok: true, ticketId: ctx.ticket.id, removed: true };
    },
  },

  {
    name: 'move_challenge',
    title: 'Move a card on your board',
    description:
      'Move a picked issue between columns. To-do, In Progress and Done change the issue\'s REAL status, visible to everyone; "completed" writes no status at all and only clears the card from your own board.',
    inputSchema: {
      type: 'object',
      properties: {
        ticketId: TICKET_ID,
        column: {
          ...STRING,
          enum: CHALLENGE_COLUMN_IDS,
          description: 'todo, in-progress, done, or completed (clears it from your board only).',
        },
      },
      required: ['ticketId', 'column'],
      additionalProperties: false,
    },
    run: async (args) => {
      const ctx = await requireTicketArg(args);
      const column = requiredString(args, 'column').trim().toLowerCase();
      if (!(CHALLENGE_COLUMN_IDS as readonly string[]).includes(column)) {
        throw new ToolError(`"column" must be one of: ${CHALLENGE_COLUMN_IDS.join(', ')}.`);
      }
      must(await moveChallenge({ ticketId: ctx.ticket.id, column }));
      return { ok: true, ticketId: ctx.ticket.id, column };
    },
  },

  /* ------------------------------------------------------------------ */
  /* Reminders                                                           */
  /*                                                                     */
  /* Scheduled email, at organization or project scope, addressed to any */
  /* member. There is no browser here to supply a timezone, so a wall    */
  /* clock is read as UTC unless `tzOffsetMinutes` says otherwise.       */
  /* ------------------------------------------------------------------ */

  {
    name: 'list_reminders',
    title: 'List reminders',
    description:
      'Every scheduled reminder in one organization — what it says, when it next sends, how often, and who receives it. Everyone in the organization can see all of them.',
    inputSchema: {
      type: 'object',
      properties: { orgSlug: ORG_SLUG },
      required: ['orgSlug'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true },
    run: async (args) => {
      const ctx = await requireOrgBySlug(requiredString(args, 'orgSlug'));

      const reminders = await prisma.reminder.findMany({
        // Scoped reminders name their project, so the list is narrowed by the
        // same predicate the web page uses. Org-wide reminders carry no project
        // and are not narrowed.
        where: {
          organizationId: ctx.org.id,
          OR: [{ projectId: null }, { project: visibleProject(ctx.user.id) }],
        },
        orderBy: [{ nextRunAt: { sort: 'asc', nulls: 'last' } }, { createdAt: 'desc' }],
        select: {
          id: true,
          title: true,
          repeat: true,
          channel: true,
          nextRunAt: true,
          lastSentAt: true,
          tzOffsetMinutes: true,
          project: { select: { name: true, key: true } },
          recipient: {
            select: {
              id: true,
              name: true,
              email: true,
              emailVerified: true,
              // `phoneVerified` only, NEVER the number itself. Every member of
              // the organization can call this tool, and a roster of
              // colleagues' phone numbers is not something reading the reminder
              // list should hand out -- the same rule the web page follows.
              phoneVerified: true,
            },
          },
          createdBy: { select: { name: true } },
        },
      });

      return {
        organization: ctx.org.name,
        url: remindersPath(ctx.org),
        reminders: reminders.map((reminder) => {
          // What this row will ACTUALLY do, which is not the same as what it was
          // set to. A channel whose destination has never been confirmed is
          // claimed, advanced and delivered nowhere -- the feature's one silent
          // failure, and the reason this is computed rather than assumed.
          //
          // Mirrors `runDueReminders` exactly: it counts a row as delivered if
          // ANY requested channel got through, so BOTH with only a confirmed
          // email is still deliverable, just not by phone.
          const wantsEmail = CHANNEL_EMAILS[reminder.channel];
          const wantsCall = CHANNEL_CALLS[reminder.channel];
          const byEmail = wantsEmail && reminder.recipient.emailVerified !== null;
          const byCall = wantsCall && reminder.recipient.phoneVerified !== null;

          return {
            reminderId: reminder.id,
            title: reminder.title,
            repeat: reminder.repeat,
            repeatLabel: REPEAT_LABEL[reminder.repeat],
            channel: reminder.channel,
            channelLabel: CHANNEL_LABEL[reminder.channel],
            // Both: the instant is what to reason about, the label is what the
            // recipient will actually read in the message.
            nextRunAt: reminder.nextRunAt?.toISOString() ?? null,
            nextRunLocal: reminder.nextRunAt
              ? formatWhen(reminder.nextRunAt, reminder.tzOffsetMinutes)
              : null,
            lastSentAt: reminder.lastSentAt?.toISOString() ?? null,
            scope: reminder.project ? 'project' : 'organization',
            projectKey: reminder.project?.key ?? null,
            recipient: reminder.recipient.name,
            recipientEmail: reminder.recipient.email,
            deliverable: byEmail || byCall,
            // Per-channel, so a BOTH reminder that will email but never ring is
            // legible as exactly that rather than a flat "deliverable: true".
            willEmail: byEmail,
            willCall: byCall,
            setBy: reminder.createdBy.name,
          };
        }),
      };
    },
  },

  {
    name: 'create_reminder',
    title: 'Schedule a reminder',
    description:
      'Schedule an email reminder for yourself or any number of teammates, about the whole organization or one project. Each recipient gets their own reminder. `runAt` is a wall clock (2026-08-20T09:00), read as UTC unless `tzOffsetMinutes` is given. It must be in the future. Any member may schedule one, for anyone in the organization.',
    inputSchema: {
      type: 'object',
      properties: {
        orgSlug: ORG_SLUG,
        title: { ...STRING, description: 'What to be reminded about. Becomes the subject line.' },
        runAt: { ...STRING, description: 'First send, as 2026-08-20T09:00.' },
        repeat: {
          ...STRING,
          enum: REPEATS,
          description: 'ONCE, DAILY or WEEKLY. Defaults to ONCE.',
        },
        channel: {
          ...STRING,
          enum: CHANNELS,
          description:
            'EMAIL, CALL or BOTH. Defaults to EMAIL. A CALL needs a phone number the recipient has confirmed on their own account — nobody else can set one for them, and an unconfirmed number is silently never rung. Check `willCall` in list_reminders afterwards.',
        },
        projectKey: {
          ...STRING,
          description: 'Scope it to one project. Omit for the whole organization.',
        },
        recipients: {
          type: 'array',
          items: STRING,
          description:
            'Emails or userIds of members to remind. Each gets their own reminder, which they can delete without affecting the others. Omit to remind yourself.',
        },
        recipient: {
          ...STRING,
          description: 'One member, as an email or userId. Use `recipients` for several.',
        },
        tzOffsetMinutes: {
          type: 'integer',
          description:
            "The recipient's UTC offset in minutes as getTimezoneOffset() reports it — Berlin in summer is -120. Defaults to 0, i.e. runAt is UTC.",
        },
      },
      required: ['orgSlug', 'title', 'runAt'],
      additionalProperties: false,
    },
    run: async (args) => {
      const ctx = await requireOrgBySlug(requiredString(args, 'orgSlug'));

      const repeat = (optionalString(args, 'repeat') ?? ReminderRepeat.ONCE).toUpperCase();
      if (!(REPEATS as string[]).includes(repeat)) {
        throw new ToolError(`"repeat" must be one of: ${REPEATS.join(', ')}.`);
      }

      // Defaults to EMAIL, matching the column default: a caller who does not
      // mention a channel cannot accidentally schedule a phone call.
      const channel = (optionalString(args, 'channel') ?? ReminderChannel.EMAIL).toUpperCase();
      if (!(CHANNELS as string[]).includes(channel)) {
        throw new ToolError(`"channel" must be one of: ${CHANNELS.join(', ')}.`);
      }

      const projectKey = optionalString(args, 'projectKey');
      // Resolved through the membership-scoped loader, so a key from another
      // tenant is not found rather than silently scoped to the wrong project.
      const scope = projectKey
        ? (await requireProjectByKeyInOrg(ctx.org.slug, projectKey.toUpperCase())).project.id
        : 'ORG';

      const recipientIds = await resolveRecipients(ctx.org.id, args);

      const tzOffsetMinutes = signedOffset(args);

      must(
        await createReminder(
          null,
          form({
            orgSlug: ctx.org.slug,
            title: requiredString(args, 'title'),
            runAt: reminderWallClock(requiredString(args, 'runAt')),
            repeat,
            channel,
            scope,
            recipientIds,
            tzOffsetMinutes: String(tzOffsetMinutes),
          }),
        ),
      );

      return {
        ok: true,
        recipients: recipientIds.length,
        channel,
        url: remindersPath(ctx.org),
      };
    },
  },

  {
    name: 'delete_reminder',
    title: 'Delete a reminder',
    description:
      'Stop a reminder. Whoever set it, whoever receives it, and any admin may delete one. There is no edit — delete and schedule another.',
    inputSchema: {
      type: 'object',
      properties: {
        orgSlug: ORG_SLUG,
        reminderId: { ...STRING, description: 'From list_reminders.' },
      },
      required: ['orgSlug', 'reminderId'],
      additionalProperties: false,
    },
    annotations: { destructiveHint: true },
    run: async (args) => {
      const orgSlug = requiredString(args, 'orgSlug');
      const reminderId = requiredId(args, 'reminderId');
      must(await deleteReminder(null, form({ orgSlug, reminderId })));
      return { ok: true, deleted: reminderId };
    },
  },

  /* ------------------------------------------------------------------ */
  /* Recurring tickets                                                   */
  /*                                                                     */
  /* A template the scheduler turns into a real issue on a cadence. The  */
  /* spawned issue is an ORDINARY issue -- get_ticket, create_comment,   */
  /* update_ticket all work on it, and nothing links it back here -- so  */
  /* these tools are about the SCHEDULE, not about the work.             */
  /*                                                                     */
  /* Same timezone rule as reminders: there is no browser here to supply */
  /* an offset, so a wall clock is read as UTC unless `tzOffsetMinutes`  */
  /* says otherwise.                                                     */
  /* ------------------------------------------------------------------ */

  {
    name: 'list_recurring_tickets',
    title: 'List recurring tickets',
    description:
      "Every recurring ticket template in one project — what it creates, when the next one appears, how often, and who it is assigned to. A template with no next run is PAUSED. Every member of the organization can see all of them.",
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

      const templates = await prisma.recurringTicket.findMany({
        where: { projectId: ctx.project.id },
        orderBy: [{ nextRunAt: { sort: 'asc', nulls: 'last' } }, { createdAt: 'desc' }],
        select: {
          id: true,
          title: true,
          description: true,
          priority: true,
          repeat: true,
          anchorAt: true,
          nextRunAt: true,
          lastSpawnedAt: true,
          tzOffsetMinutes: true,
          assignee: { select: { id: true, name: true, email: true, emailVerified: true } },
          createdBy: { select: { name: true } },
          labels: { select: { name: true } },
        },
      });

      return {
        organization: ctx.org.name,
        project: ctx.project.name,
        projectKey: ctx.project.key,
        url: recurringPath(ctx.org, ctx.project),
        recurringTickets: templates.map((template) => ({
          recurringTicketId: template.id,
          title: template.title,
          description: template.description,
          priority: template.priority,
          repeat: template.repeat,
          repeatLabel: TICKET_REPEAT_LABEL[template.repeat],
          // Null next run IS the paused state -- there is no second flag, so
          // this is derived rather than stored.
          paused: template.nextRunAt === null,
          // Both: the instant is what to reason about, the label is the time
          // the person who set it up actually picked.
          nextRunAt: template.nextRunAt?.toISOString() ?? null,
          nextRunLocal: template.nextRunAt
            ? formatWhen(template.nextRunAt, template.tzOffsetMinutes)
            : null,
          // Every occurrence is counted from here, never from the last one.
          anchorAt: template.anchorAt.toISOString(),
          lastSpawnedAt: template.lastSpawnedAt?.toISOString() ?? null,
          tzOffsetMinutes: template.tzOffsetMinutes,
          assignee: template.assignee?.name ?? null,
          assigneeEmail: template.assignee?.email ?? null,
          // An unassigned template mails nobody by design: the issue appearing
          // on the board is the notification. Only flag a real dead end.
          assigneeNotified:
            template.assignee === null ? null : template.assignee.emailVerified !== null,
          labels: template.labels.map((label) => label.name),
          setBy: template.createdBy.name,
        })),
      };
    },
  },

  {
    name: 'create_recurring_ticket',
    title: 'Create a recurring ticket',
    description:
      'Set up a template that creates a pre-filled issue on a schedule — DAILY, WEEKDAYS, WEEKLY or MONTHLY. Each issue gets the date appended to its title and is due that day. There is no ONCE: for a single pre-filled issue use create_ticket. `runAt` is a wall clock (2026-08-20T09:00) for the FIRST issue, read as UTC unless `tzOffsetMinutes` is given, and it must be in the future. MONTHLY keeps the day of the month you pick, clamped in shorter months. Any member may create one.',
    inputSchema: {
      type: 'object',
      properties: {
        orgSlug: ORG_SLUG,
        projectKey: PROJECT_KEY,
        title: {
          ...STRING,
          description:
            'Title of each created issue, before the date is appended. Max 160 characters.',
        },
        description: {
          ...STRING,
          description:
            "Markdown body copied onto every issue this creates. This is the living checklist — edit it later to change what every future issue asks for.",
        },
        runAt: { ...STRING, description: 'When the FIRST issue appears, as 2026-08-20T09:00.' },
        repeat: {
          ...STRING,
          enum: TICKET_REPEATS,
          description: 'DAILY, WEEKDAYS (skips Saturday and Sunday), WEEKLY or MONTHLY.',
        },
        assignee: {
          ...STRING,
          description:
            'Email or userId of the member each issue is assigned to. They get an email every time one appears. Omit for unassigned.',
        },
        priority: { ...STRING, enum: PRIORITIES, description: 'Defaults to NONE.' },
        labels: {
          type: 'array',
          items: STRING,
          description:
            'Label names copied onto every issue this creates. One label per recurring duty is what turns its whole history into a single filter on the issue list.',
        },
        tzOffsetMinutes: {
          type: 'integer',
          description:
            "UTC offset in minutes as getTimezoneOffset() reports it — Berlin in summer is -120. Defaults to 0, i.e. runAt is UTC. Also decides which days count as the weekend for WEEKDAYS.",
        },
      },
      required: ['orgSlug', 'projectKey', 'title', 'runAt', 'repeat'],
      additionalProperties: false,
    },
    run: async (args) => {
      const ctx = await requireProjectByKeyInOrg(
        requiredString(args, 'orgSlug'),
        requiredString(args, 'projectKey').toUpperCase(),
      );

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
        orgSlug: ctx.org.slug,
        projectKey: ctx.project.key,
        title: requiredString(args, 'title'),
        description: optionalString(args, 'description') ?? '',
        runAt: reminderWallClock(requiredString(args, 'runAt')),
        repeat: enumOf(TICKET_REPEATS, 'repeat', requiredString(args, 'repeat')),
        assigneeId,
        tzOffsetMinutes: String(signedOffset(args)),
        ...(priority ? { priority: enumOf(PRIORITIES, 'priority', priority) } : {}),
      });
      for (const id of labelIds) formData.append('labelIds', id);

      must(await createRecurringTicket(null, formData));

      return { ok: true, url: recurringPath(ctx.org, ctx.project) };
    },
  },

  {
    name: 'update_recurring_ticket',
    title: 'Update a recurring ticket',
    description:
      "Change what a recurring ticket creates: its title, description, priority, assignee or labels. Only the fields you pass change; the rest are kept. This is how you refine the checklist — it affects every FUTURE issue, and never the ones already created. To change the schedule use reschedule_recurring_ticket. Any member may update one.",
    inputSchema: {
      type: 'object',
      properties: {
        orgSlug: ORG_SLUG,
        projectKey: PROJECT_KEY,
        recurringTicketId: { ...STRING, description: 'From list_recurring_tickets.' },
        title: { ...STRING, description: 'Max 160 characters.' },
        description: { ...STRING, description: 'Markdown. Pass "" to clear it.' },
        priority: { ...STRING, enum: PRIORITIES },
        assignee: {
          ...STRING,
          description: 'Email or userId. Pass "" to unassign.',
        },
        labels: {
          type: 'array',
          items: STRING,
          description: 'Replaces the whole label set. Pass [] to clear it.',
        },
      },
      required: ['orgSlug', 'projectKey', 'recurringTicketId'],
      additionalProperties: false,
    },
    run: async (args) => {
      const ctx = await requireProjectByKeyInOrg(
        requiredString(args, 'orgSlug'),
        requiredString(args, 'projectKey').toUpperCase(),
      );
      const recurringTicketId = requiredId(args, 'recurringTicketId');

      // The action takes the WHOLE content shape and replaces it, because the
      // web form submits every field every time. A tool that only names one
      // field would otherwise blank the others, so the current row is read
      // first and the arguments are merged over it. Scoped to the authorized
      // project, so an id from another tenant is simply not found.
      const current = await prisma.recurringTicket.findFirst({
        where: { id: recurringTicketId, projectId: ctx.project.id },
        select: {
          title: true,
          description: true,
          priority: true,
          assigneeId: true,
          labels: { select: { id: true } },
        },
      });
      if (!current) throw new AuthzError('NOT_FOUND');

      const assignee = optionalString(args, 'assignee');
      const assigneeId =
        assignee === undefined
          ? (current.assigneeId ?? '')
          : assignee.trim() === ''
            ? ''
            : await resolveMember(ctx.org.id, assignee);

      const rawLabels = args.labels;
      if (rawLabels !== undefined && !Array.isArray(rawLabels)) {
        throw new ToolError('"labels" must be an array of strings.');
      }
      const labelIds =
        rawLabels === undefined
          ? current.labels.map((label) => label.id)
          : await resolveLabels(
              ctx.project.id,
              rawLabels.map((value) => String(value)),
            );

      const priority = optionalString(args, 'priority');

      const formData = form({
        part: 'CONTENT',
        orgSlug: ctx.org.slug,
        projectKey: ctx.project.key,
        recurringTicketId,
        title: optionalString(args, 'title') ?? current.title,
        description: optionalString(args, 'description') ?? current.description ?? '',
        priority: priority ? enumOf(PRIORITIES, 'priority', priority) : current.priority,
        assigneeId,
      });
      for (const id of labelIds) formData.append('labelIds', id);

      must(await updateRecurringTicket(null, formData));

      return { ok: true, url: recurringPath(ctx.org, ctx.project) };
    },
  },

  {
    name: 'reschedule_recurring_ticket',
    title: 'Reschedule a recurring ticket',
    description:
      'Change WHEN a recurring ticket creates issues. `runAt` becomes the new anchor every later occurrence is counted from, so it must be in the future — this is not the same as editing the content, which reschedule leaves alone. A PAUSED template stays paused; use set_recurring_ticket_paused to restart it.',
    inputSchema: {
      type: 'object',
      properties: {
        orgSlug: ORG_SLUG,
        projectKey: PROJECT_KEY,
        recurringTicketId: { ...STRING, description: 'From list_recurring_tickets.' },
        runAt: { ...STRING, description: 'New first issue, as 2026-08-20T09:00. Must be future.' },
        repeat: { ...STRING, enum: TICKET_REPEATS, description: 'DAILY, WEEKDAYS, WEEKLY or MONTHLY.' },
        tzOffsetMinutes: {
          type: 'integer',
          description: 'UTC offset in minutes. Defaults to 0, i.e. runAt is UTC.',
        },
      },
      required: ['orgSlug', 'projectKey', 'recurringTicketId', 'runAt', 'repeat'],
      additionalProperties: false,
    },
    run: async (args) => {
      const ctx = await requireProjectByKeyInOrg(
        requiredString(args, 'orgSlug'),
        requiredString(args, 'projectKey').toUpperCase(),
      );

      must(
        await updateRecurringTicket(
          null,
          form({
            part: 'SCHEDULE',
            orgSlug: ctx.org.slug,
            projectKey: ctx.project.key,
            recurringTicketId: requiredId(args, 'recurringTicketId'),
            runAt: reminderWallClock(requiredString(args, 'runAt')),
            repeat: enumOf(TICKET_REPEATS, 'repeat', requiredString(args, 'repeat')),
            tzOffsetMinutes: String(signedOffset(args)),
          }),
        ),
      );

      return { ok: true, url: recurringPath(ctx.org, ctx.project) };
    },
  },

  {
    name: 'set_recurring_ticket_paused',
    title: 'Pause or resume a recurring ticket',
    description:
      'Stop a recurring ticket creating issues, or start it again. Pausing keeps the template and everything written into it, which is what makes it the right way to stop one temporarily — deleting is not. Resuming computes the next issue from the original anchor, always in the future, so a template paused for a month does not create a backlog on the next tick. Any member may pause or resume.',
    inputSchema: {
      type: 'object',
      properties: {
        orgSlug: ORG_SLUG,
        projectKey: PROJECT_KEY,
        recurringTicketId: { ...STRING, description: 'From list_recurring_tickets.' },
        paused: { type: 'boolean', description: 'true to pause, false to resume.' },
      },
      required: ['orgSlug', 'projectKey', 'recurringTicketId', 'paused'],
      additionalProperties: false,
    },
    run: async (args) => {
      const ctx = await requireProjectByKeyInOrg(
        requiredString(args, 'orgSlug'),
        requiredString(args, 'projectKey').toUpperCase(),
      );
      const paused = requiredBoolean(args, 'paused');

      must(
        await setRecurringTicketPaused(
          null,
          form({
            orgSlug: ctx.org.slug,
            projectKey: ctx.project.key,
            recurringTicketId: requiredId(args, 'recurringTicketId'),
            paused: String(paused),
          }),
        ),
      );

      return { ok: true, paused, url: recurringPath(ctx.org, ctx.project) };
    },
  },

  {
    name: 'delete_recurring_ticket',
    title: 'Delete a recurring ticket',
    description:
      'Delete a recurring ticket template. Issues it has already created are NOT touched — they are ordinary issues with no link back. Whoever set it up, and any admin, may delete one. To stop it temporarily without losing the checklist, use set_recurring_ticket_paused instead.',
    inputSchema: {
      type: 'object',
      properties: {
        orgSlug: ORG_SLUG,
        projectKey: PROJECT_KEY,
        recurringTicketId: { ...STRING, description: 'From list_recurring_tickets.' },
      },
      required: ['orgSlug', 'projectKey', 'recurringTicketId'],
      additionalProperties: false,
    },
    annotations: { destructiveHint: true },
    run: async (args) => {
      const ctx = await requireProjectByKeyInOrg(
        requiredString(args, 'orgSlug'),
        requiredString(args, 'projectKey').toUpperCase(),
      );
      const recurringTicketId = requiredId(args, 'recurringTicketId');

      must(
        await deleteRecurringTicket(
          null,
          form({
            orgSlug: ctx.org.slug,
            projectKey: ctx.project.key,
            recurringTicketId,
          }),
        ),
      );

      return { ok: true, deleted: recurringTicketId };
    },
  },

  /* ------------------------------------------------------------------ */
  /* Saved views                                                         */
  /*                                                                     */
  /* A view is a stored Issues-list query string and nothing more, so    */
  /* there is no second filter language here either -- `query` is the    */
  /* same thing search_tickets filters by, spelled as a URL.             */
  /* ------------------------------------------------------------------ */

  {
    name: 'list_views',
    title: 'List saved views',
    description:
      "A project's saved issue filters: the shared ones, plus the signed-in user's own private ones. Never anyone else's private view.",
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
        requiredString(args, 'projectKey'),
      );

      const views = await prisma.savedView.findMany({
        where: {
          projectId: ctx.project.id,
          // Shared, or your own. The same clause the views page uses.
          OR: [{ isShared: true }, { createdById: ctx.user.id }],
        },
        orderBy: [{ name: 'asc' }, { id: 'asc' }],
        select: {
          id: true,
          name: true,
          query: true,
          isShared: true,
          createdBy: { select: { name: true } },
        },
      });

      return {
        project: ctx.project.name,
        projectKey: ctx.project.key,
        url: viewsPath(ctx.org, ctx.project),
        views: views.map((view) => ({
          viewId: view.id,
          name: view.name,
          query: view.query,
          shared: view.isShared,
          createdBy: view.createdBy.name,
          url: `${issuesPath(ctx.org, ctx.project)}${view.query ? `?${view.query}` : ''}`,
        })),
      };
    },
  },

  {
    name: 'create_view',
    title: 'Save an issue filter',
    description:
      'Save an Issues-list filter under a name. `query` is the query string only — e.g. "tab=active&assignee=me" — with no leading "?" and no path. Any member may save one.',
    inputSchema: {
      type: 'object',
      properties: {
        orgSlug: ORG_SLUG,
        projectKey: PROJECT_KEY,
        name: STRING,
        query: {
          ...STRING,
          description: 'The Issues-list query string, e.g. tab=active&priority=HIGH.',
        },
        shared: {
          type: 'boolean',
          description: 'Visible to everyone in the project. Defaults to true.',
        },
      },
      required: ['orgSlug', 'projectKey', 'name', 'query'],
      additionalProperties: false,
    },
    run: async (args) => {
      const ctx = await requireProjectByKeyInOrg(
        requiredString(args, 'orgSlug'),
        requiredString(args, 'projectKey'),
      );

      const shared = args.shared === undefined ? true : requiredBoolean(args, 'shared');

      must(
        await createSavedView(
          null,
          form({
            projectId: ctx.project.id,
            name: requiredString(args, 'name'),
            query: requiredString(args, 'query'),
            // The action reads a checkbox: present-and-"on" is true, absent is
            // false. There is no "off" to send.
            ...(shared ? { isShared: 'on' } : {}),
          }),
        ),
      );

      return { ok: true, shared, url: viewsPath(ctx.org, ctx.project) };
    },
  },

  {
    name: 'delete_view',
    title: 'Delete a saved view',
    description:
      'Remove a saved filter. Your own are yours to delete; anyone else\'s needs ADMIN.',
    inputSchema: {
      type: 'object',
      properties: {
        orgSlug: ORG_SLUG,
        projectKey: PROJECT_KEY,
        viewId: { ...STRING, description: 'From list_views.' },
      },
      required: ['orgSlug', 'projectKey', 'viewId'],
      additionalProperties: false,
    },
    annotations: { destructiveHint: true },
    run: async (args) => {
      const ctx = await requireProjectByKeyInOrg(
        requiredString(args, 'orgSlug'),
        requiredString(args, 'projectKey'),
      );
      const viewId = requiredId(args, 'viewId');
      must(await deleteSavedView(null, form({ projectId: ctx.project.id, viewId })));
      return { ok: true, deleted: viewId };
    },
  },

  /* ------------------------------------------------------------------ */
  /* Documents                                                           */
  /*                                                                     */
  /* Long-form Markdown pages inside a project, nested by parent. The    */
  /* body is the SAME Markdown an issue description is, so a document    */
  /* reads identically here and in the browser, and an image already     */
  /* uploaded to the project renders in both.                            */
  /*                                                                     */
  /* Every document is addressable by title as well as by id, and the    */
  /* tree is returned flat with a `depth` -- a model does not need a      */
  /* nested JSON shape to understand what is filed under what.           */
  /* ------------------------------------------------------------------ */

  {
    name: 'list_documents',
    title: 'List documents',
    description:
      "A project's documents as a flat tree: every page with its depth and parent, deepest-first within each branch. Pass `query` to keep only the documents whose title or body contains it (case-insensitive). Bodies are omitted here — read one with get_document.",
    inputSchema: {
      type: 'object',
      properties: {
        orgSlug: ORG_SLUG,
        projectKey: PROJECT_KEY,
        query: {
          ...STRING,
          description: 'Optional. Case-insensitive substring of the title or body.',
        },
      },
      required: ['orgSlug', 'projectKey'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true },
    run: async (args) => {
      const ctx = await requireProjectByKeyInOrg(
        requiredString(args, 'orgSlug'),
        requiredString(args, 'projectKey'),
      );
      const query = optionalString(args, 'query')?.trim();

      const rows = await prisma.document.findMany({
        where: { projectId: ctx.project.id },
        orderBy: [{ title: 'asc' }, { id: 'asc' }],
        select: {
          id: true,
          parentId: true,
          title: true,
          updatedAt: true,
          createdBy: { select: { name: true } },
        },
      });

      // The tree is built from EVERY row and filtered afterwards, so a matching
      // document keeps the depth it actually has rather than the depth it would
      // have if its ancestors had also matched.
      const tree = flattenTree(rows);
      const matched = query
        ? await prisma.document
            .findMany({
              where: {
                projectId: ctx.project.id,
                OR: [
                  { title: { contains: query, mode: 'insensitive' } },
                  { body: { contains: query, mode: 'insensitive' } },
                ],
              },
              select: { id: true },
            })
            .then((hits) => new Set(hits.map((hit) => hit.id)))
        : null;

      const documents = matched ? tree.filter((row) => matched.has(row.id)) : tree;

      return {
        project: ctx.project.name,
        projectKey: ctx.project.key,
        url: docsPath(ctx.org, ctx.project),
        ...(query ? { query } : {}),
        count: documents.length,
        documents: documents.map((document) => ({
          documentId: document.id,
          title: document.title,
          depth: document.depth,
          parentId: document.parentId,
          updatedBy: document.createdBy.name,
          updatedAt: document.updatedAt.toISOString(),
          url: documentPath(ctx.org, ctx.project, document.id),
        })),
      };
    },
  },

  {
    name: 'get_document',
    title: 'Read a document',
    description:
      'One document in full: its Markdown body, the chain of documents it sits under, and the documents filed inside it.',
    inputSchema: {
      type: 'object',
      properties: { documentId: DOCUMENT_ID },
      required: ['documentId'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true },
    run: async (args) => {
      const ctx = await requireDocument(requiredId(args, 'documentId'));

      // Rooted at the project the walk above authorized.
      const rows = await prisma.document.findMany({
        where: { projectId: ctx.project.id },
        orderBy: [{ title: 'asc' }, { id: 'asc' }],
        select: { id: true, parentId: true, title: true },
      });

      const detail = await prisma.document.findFirst({
        where: { id: ctx.document.id, projectId: ctx.project.id },
        select: {
          createdAt: true,
          updatedAt: true,
          createdBy: { select: { name: true } },
        },
      });
      if (!detail) throw new AuthzError('NOT_FOUND');

      return {
        documentId: ctx.document.id,
        title: ctx.document.title,
        body: ctx.document.body,
        project: ctx.project.name,
        projectKey: ctx.project.key,
        orgSlug: ctx.org.slug,
        // Root first, this document last -- the breadcrumbs, as a path.
        path: ancestorChain(rows, ctx.document.id).map((row) => row.title),
        parentId: ctx.document.parentId,
        children: rows
          .filter((row) => row.parentId === ctx.document.id)
          .map((child) => ({
            documentId: child.id,
            title: child.title,
            url: documentPath(ctx.org, ctx.project, child.id),
          })),
        createdBy: detail.createdBy.name,
        createdAt: detail.createdAt.toISOString(),
        updatedAt: detail.updatedAt.toISOString(),
        url: documentPath(ctx.org, ctx.project, ctx.document.id),
        // Absolute, because this one is meant to be sent to somebody who has no
        // account. Null is the ordinary answer: a document is private until it
        // is deliberately published.
        publicUrl: ctx.document.shareToken
          ? appUrl(publicDocumentPath(ctx.document.shareToken))
          : null,
      };
    },
  },

  {
    name: 'create_document',
    title: 'Create a document',
    description:
      'Write a new document in a project. `body` is Markdown, the same dialect issue descriptions use. Pass `parent` (a title or documentId) to file it inside another document. Any member may create one.',
    inputSchema: {
      type: 'object',
      properties: {
        orgSlug: ORG_SLUG,
        projectKey: PROJECT_KEY,
        title: STRING,
        body: { ...STRING, description: 'Markdown. Optional — a document may start empty.' },
        parent: {
          ...STRING,
          description: 'Document title or documentId. Omit to create it at the top level.',
        },
      },
      required: ['orgSlug', 'projectKey', 'title'],
      additionalProperties: false,
    },
    run: async (args) => {
      const ctx = await requireProjectByKeyInOrg(
        requiredString(args, 'orgSlug'),
        requiredString(args, 'projectKey'),
      );

      const parent = optionalString(args, 'parent');
      const parentId =
        parent === undefined || parent.trim() === ''
          ? ''
          : await resolveDocument(ctx.project.id, parent);

      // `createDocument` navigates to what it made, so the redirect target is
      // where the new id comes from -- the same trick create_board uses.
      const target = await runNavigating(() =>
        createDocument(
          null,
          form({
            projectId: ctx.project.id,
            title: requiredString(args, 'title'),
            body: optionalString(args, 'body') ?? '',
            parentId,
          }),
        ),
      );

      return { ok: true, documentId: tailOf(target), url: target };
    },
  },

  {
    name: 'update_document',
    title: 'Rewrite a document',
    description:
      'Change a document\'s title, its body, or both. Whichever you leave out keeps its current value. This does NOT move the document — use move_document for that.',
    inputSchema: {
      type: 'object',
      properties: {
        documentId: DOCUMENT_ID,
        title: STRING,
        body: { ...STRING, description: 'Markdown. Replaces the whole body.' },
      },
      required: ['documentId'],
      additionalProperties: false,
    },
    run: async (args) => {
      const ctx = await requireDocument(requiredId(args, 'documentId'));

      const title = optionalString(args, 'title');
      const body = optionalString(args, 'body');
      if (title === undefined && body === undefined) {
        throw new ToolError('Pass "title", "body", or both.');
      }

      // The action's schema demands both fields on every call, so the one that
      // was not passed is sent back unchanged -- read from the authorized walk,
      // never from the caller.
      must(
        await updateDocument(
          null,
          form({
            documentId: ctx.document.id,
            title: title ?? ctx.document.title,
            body: body ?? ctx.document.body,
          }),
        ),
      );

      return { ok: true, documentId: ctx.document.id, url: documentPath(ctx.org, ctx.project, ctx.document.id) };
    },
  },

  {
    name: 'move_document',
    title: 'Move a document',
    description:
      'File a document under another one, or at the top level. A document cannot be filed inside itself or inside anything already beneath it — that would detach the branch from the tree, and it is refused.',
    inputSchema: {
      type: 'object',
      properties: {
        documentId: DOCUMENT_ID,
        parent: {
          ...STRING,
          description:
            'Document title or documentId to file it under. Pass "" or omit it for the top level.',
        },
      },
      required: ['documentId'],
      additionalProperties: false,
    },
    annotations: { idempotentHint: true },
    run: async (args) => {
      const ctx = await requireDocument(requiredId(args, 'documentId'));

      const parent = optionalString(args, 'parent');
      const parentId =
        parent === undefined || parent.trim() === ''
          ? ''
          : await resolveDocument(ctx.project.id, parent);

      must(await moveDocument(null, form({ documentId: ctx.document.id, parentId })));

      return {
        ok: true,
        documentId: ctx.document.id,
        parentId: parentId === '' ? null : parentId,
        url: documentPath(ctx.org, ctx.project, ctx.document.id),
      };
    },
  },

  {
    name: 'set_document_shared',
    title: 'Share a document on a public link',
    description:
      'Publish a document at a link anyone can open without an account, or revoke it. Only this document — anything filed inside it stays private. Revoking kills the URL permanently; sharing again mints a different one. The author, an ADMIN or an OWNER may do it.',
    inputSchema: {
      type: 'object',
      properties: {
        documentId: DOCUMENT_ID,
        shared: { type: 'boolean', description: 'True publishes it, false revokes the link.' },
      },
      required: ['documentId', 'shared'],
      additionalProperties: false,
    },
    annotations: { idempotentHint: true },
    run: async (args) => {
      const ctx = await requireDocument(requiredId(args, 'documentId'));
      const shared = requiredBoolean(args, 'shared');

      must(
        await setDocumentShared(
          null,
          form({ documentId: ctx.document.id, shared: String(shared) }),
        ),
      );

      // Re-read: publishing an already-published document keeps its token, and
      // publishing a private one mints a token this call has never seen.
      const after = await prisma.document.findFirst({
        where: { id: ctx.document.id, projectId: ctx.project.id },
        select: { shareToken: true },
      });

      return {
        ok: true,
        documentId: ctx.document.id,
        shared,
        publicUrl: after?.shareToken ? appUrl(publicDocumentPath(after.shareToken)) : null,
      };
    },
  },

  {
    name: 'delete_document',
    title: 'Delete a document',
    description:
      'Delete a document AND every document filed inside it. There is no trash. Yours are yours to delete; anyone else\'s needs ADMIN.',
    inputSchema: {
      type: 'object',
      properties: { documentId: DOCUMENT_ID },
      required: ['documentId'],
      additionalProperties: false,
    },
    annotations: { destructiveHint: true },
    run: async (args) => {
      const ctx = await requireDocument(requiredId(args, 'documentId'));

      // Reported back, because "delete this page" and "delete this page and the
      // nine under it" are different acts and the caller should see which it did.
      const rows = await prisma.document.findMany({
        where: { projectId: ctx.project.id },
        select: { id: true, parentId: true, title: true },
      });
      const nested = descendantIds(rows, ctx.document.id).size;

      const target = await runNavigating(() =>
        deleteDocument(null, form({ documentId: ctx.document.id })),
      );

      return {
        ok: true,
        deleted: ctx.document.id,
        alsoDeleted: nested,
        url: target ?? docsPath(ctx.org, ctx.project),
      };
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
