import 'server-only';
import { randomUUID } from 'node:crypto';
import { notFound, redirect } from 'next/navigation';
import { Role, type WorkflowStateType } from '@prisma/client';
import { prisma } from '@/lib/db';
import { readSession, touchSessionCookie } from '@/lib/session';
import { ERRORS, type ActionResult } from '@/lib/result';

/**
 * SPEC 3 -- the security core.
 *
 * THE ONE RULE: access is always re-derived by walking up from the resource to
 * its Organization, INSIDE the Prisma `where` clause, using the `userId` read
 * from the session -- never from client input.
 *
 * The membership predicate is part of the lookup, not a follow-up `if`. A
 * missing resource and a resource in another tenant both produce `null` from the
 * SAME single query: identical result, identical shape, indistinguishable
 * timing. There is no existence oracle and no separate 403 to leak from.
 *
 * HARD PROHIBITION: outside this file, the tenant-scoped models (Organization,
 * Membership, Project, Board, WorkflowState, Cycle, Label, SavedView, Ticket,
 * Comment, Attachment) must NEVER be reached with `findUnique({ where: { id } })` or any
 * `findFirst` / `count` / `aggregate` lacking a tenant predicate. Fetch through
 * a `require*` helper, or via a nested `select` rooted at an already-authorized
 * entity.
 *
 * The Linear rework moved the walk's spine off the board. A ticket now belongs
 * to a PROJECT and its board is optional, so every ticket loader below walks
 * ticket -> project -> organization. Walking through the board would have made
 * a board-less issue unreachable, which is exactly the kind of hole that reads
 * as a 404 and gets shrugged at.
 */

/* -------------------------------------------------------------------------- */
/* Context shapes                                                              */
/* -------------------------------------------------------------------------- */

export type SessionUser = { id: string; email: string; name: string; sessionId: string };

export type OrgRef = { id: string; name: string; slug: string };
export type WorkspaceRef = { id: string; name: string; slug: string };
export type ProjectRef = {
  id: string;
  name: string;
  key: string;
  description: string | null;
  /**
   * The owning workspace's slug, denormalized onto the ref.
   *
   * Deliberate: every path builder below derives from `projectPath`, and every
   * project URL now needs the workspace segment. Carrying the slug here keeps
   * all of them binary `(org, project)` functions, so adding the segment did not
   * touch a single one of their call sites. `ctx.workspace` is the full ref when
   * a caller needs more than the slug.
   */
  workspaceSlug: string;
};
export type BoardRef = { id: string; name: string };
export type CycleRef = { id: string; number: number; name: string | null; startsAt: Date; endsAt: Date };
export type StateRef = { id: string; name: string; type: WorkflowStateType; position: number };
export type TicketRef = {
  id: string;
  number: number;
  projectId: string;
  /** Null when the issue is not filed under any board. */
  boardId: string | null;
  stateId: string;
  cycleId: string | null;
  parentId: string | null;
  position: number;
  title: string;
  description: string | null;
  createdById: string;
  assigneeId: string | null;
  /** Carried so a state transition can decide what to stamp without a re-read. */
  startedAt: Date | null;
  completedAt: Date | null;
};
export type CommentRef = { id: string; ticketId: string; authorId: string; body: string };
export type AttachmentRef = {
  id: string;
  projectId: string;
  /** Null when the image was pasted into a body that had no row yet. */
  ticketId: string | null;
  /** Bucket object key. Never rendered, never logged. */
  key: string;
  filename: string;
  mimeType: string;
};

export type OrgCtx = { user: SessionUser; org: OrgRef; role: Role };
export type WorkspaceCtx = OrgCtx & { workspace: WorkspaceRef };
export type ProjectCtx = WorkspaceCtx & { project: ProjectRef };
export type BoardCtx = ProjectCtx & { board: BoardRef };
/** `board` is nullable here precisely because an issue need not be on one. */
export type TicketCtx = ProjectCtx & { ticket: TicketRef; board: BoardRef | null };
export type CycleCtx = ProjectCtx & { cycle: CycleRef };
export type CommentCtx = TicketCtx & { comment: CommentRef };
/**
 * PROJECT-rooted, not ticket-rooted, because an attachment need not have an
 * issue. Nothing needs the issue to serve an image, so the ctx does not carry one.
 */
export type AttachmentCtx = ProjectCtx & { attachment: AttachmentRef };

/* -------------------------------------------------------------------------- */
/* Errors                                                                      */
/* -------------------------------------------------------------------------- */

export type AuthzKind = 'UNAUTHENTICATED' | 'NOT_FOUND' | 'FORBIDDEN';

export class AuthzError extends Error {
  readonly kind: AuthzKind;

  constructor(kind: AuthzKind, message?: string) {
    super(message ?? kind);
    this.name = 'AuthzError';
    this.kind = kind;
    // Insurance against downlevel transpilation silently breaking `instanceof`,
    // which would turn every authz failure into a generic 500.
    Object.setPrototypeOf(this, AuthzError.prototype);
  }
}

/**
 * `redirect()` and `notFound()` signal by throwing. Swallowing those throws
 * would break navigation, so every catch block in the app re-throws them first.
 */
export function isNextControlFlowError(e: unknown): boolean {
  if (!e || typeof e !== 'object' || !('digest' in e)) return false;
  const digest = (e as { digest?: unknown }).digest;
  if (typeof digest !== 'string') return false;
  return (
    digest === 'NEXT_NOT_FOUND' ||
    digest.startsWith('NEXT_REDIRECT') ||
    digest.startsWith('NEXT_HTTP_ERROR_FALLBACK')
  );
}

/* -------------------------------------------------------------------------- */
/* Selection fragments                                                         */
/*                                                                             */
/* Written once so a loader cannot accidentally omit the membership predicate   */
/* while looking like it has one.                                              */
/* -------------------------------------------------------------------------- */

type OrgRow = { id: string; name: string; slug: string; memberships: Array<{ role: Role }> };
type WorkspaceRow = WorkspaceRef & { organization: OrgRow };
type ProjectRow = Omit<ProjectRef, 'workspaceSlug'> & { workspace: WorkspaceRow };
type BoardRow = BoardRef & { project: ProjectRow };
type TicketRow = TicketRef & { project: ProjectRow; board: BoardRef | null };
type CycleRow = CycleRef & { project: ProjectRow };
type CommentRow = CommentRef & { ticket: TicketRow };
type AttachmentRow = AttachmentRef & { project: ProjectRow };

function orgSelect(userId: string) {
  return {
    id: true,
    name: true,
    slug: true,
    memberships: { where: { userId }, select: { role: true }, take: 1 },
  } as const;
}

function workspaceSelect(userId: string) {
  return {
    id: true,
    name: true,
    slug: true,
    organization: { select: orgSelect(userId) },
  } as const;
}

/**
 * The walk-up is now project -> workspace -> organization. The membership
 * predicate still lands on the organization, which is still the only tenant
 * boundary; the workspace is one more link in the same chain, not a second one.
 */
function projectSelect(userId: string) {
  return {
    id: true,
    name: true,
    key: true,
    description: true,
    workspace: { select: workspaceSelect(userId) },
  } as const;
}

function ticketSelect(userId: string) {
  return {
    id: true,
    number: true,
    projectId: true,
    boardId: true,
    stateId: true,
    cycleId: true,
    parentId: true,
    position: true,
    title: true,
    description: true,
    createdById: true,
    assigneeId: true,
    startedAt: true,
    completedAt: true,
    board: { select: { id: true, name: true } },
    project: { select: projectSelect(userId) },
  } as const;
}

function toOrgCtx(user: SessionUser, row: OrgRow): OrgCtx {
  const role = row.memberships[0]?.role;
  // Belt and braces: the `where` clause already proved membership, so an empty
  // array here means the query was edited wrongly. Fail closed and indistinguishably.
  if (!role) throw new AuthzError('NOT_FOUND');
  return { user, org: { id: row.id, name: row.name, slug: row.slug }, role };
}

function toWorkspaceCtx(user: SessionUser, row: WorkspaceRow): WorkspaceCtx {
  return {
    ...toOrgCtx(user, row.organization),
    workspace: { id: row.id, name: row.name, slug: row.slug },
  };
}

function toProjectCtx(user: SessionUser, row: ProjectRow): ProjectCtx {
  return {
    ...toWorkspaceCtx(user, row.workspace),
    project: {
      id: row.id,
      name: row.name,
      key: row.key,
      description: row.description,
      workspaceSlug: row.workspace.slug,
    },
  };
}

function toBoardCtx(user: SessionUser, row: BoardRow): BoardCtx {
  return { ...toProjectCtx(user, row.project), board: { id: row.id, name: row.name } };
}

function toTicketCtx(user: SessionUser, row: TicketRow): TicketCtx {
  return {
    ...toProjectCtx(user, row.project),
    board: row.board ? { id: row.board.id, name: row.board.name } : null,
    ticket: {
      id: row.id,
      number: row.number,
      projectId: row.projectId,
      boardId: row.boardId,
      stateId: row.stateId,
      cycleId: row.cycleId,
      parentId: row.parentId,
      position: row.position,
      title: row.title,
      description: row.description,
      createdById: row.createdById,
      assigneeId: row.assigneeId,
      startedAt: row.startedAt,
      completedAt: row.completedAt,
    },
  };
}

function toCycleCtx(user: SessionUser, row: CycleRow): CycleCtx {
  return {
    ...toProjectCtx(user, row.project),
    cycle: {
      id: row.id,
      number: row.number,
      name: row.name,
      startsAt: row.startsAt,
      endsAt: row.endsAt,
    },
  };
}

function toCommentCtx(user: SessionUser, row: CommentRow): CommentCtx {
  return {
    ...toTicketCtx(user, row.ticket),
    comment: { id: row.id, ticketId: row.ticketId, authorId: row.authorId, body: row.body },
  };
}

function toAttachmentCtx(user: SessionUser, row: AttachmentRow): AttachmentCtx {
  return {
    ...toProjectCtx(user, row.project),
    attachment: {
      id: row.id,
      projectId: row.projectId,
      ticketId: row.ticketId,
      key: row.key,
      filename: row.filename,
      mimeType: row.mimeType,
    },
  };
}

/* -------------------------------------------------------------------------- */
/* Identity                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * The literal first statement of every Server Action body, and the root of every
 * loader below. Wraps the `cache()`d `readSession()`, so N calls in one render
 * cost one round-trip.
 *
 * `touchSessionCookie()` re-issues the browser cookie with the refreshed expiry.
 * It is a no-op outside a Server Action (SPEC 7.17).
 */
export async function requireUser(): Promise<SessionUser> {
  const session = await readSession();
  if (!session) throw new AuthzError('UNAUTHENTICATED');
  await touchSessionCookie();
  return {
    id: session.user.id,
    email: session.user.email,
    name: session.user.name,
    sessionId: session.sessionId,
  };
}

/** Memberships of the caller only. Used by `/orgs` to dispatch and by the org picker. */
export async function listUserOrgs(): Promise<Array<OrgRef & { role: Role }>> {
  const user = await requireUser();
  const rows = await prisma.membership.findMany({
    where: { userId: user.id },
    select: {
      role: true,
      organization: { select: { id: true, name: true, slug: true } },
    },
    orderBy: [{ organization: { name: 'asc' } }, { organizationId: 'asc' }],
  });
  return rows.map((row) => ({
    id: row.organization.id,
    name: row.organization.name,
    slug: row.organization.slug,
    role: row.role,
  }));
}

/* -------------------------------------------------------------------------- */
/* Site administration                                                         */
/*                                                                             */
/* `User.isAdmin` is INSTANCE-level and is deliberately NOT tenant access. A    */
/* site admin governs registration and other admins. It grants NO ability to    */
/* read or write any organization's projects, boards, tickets or comments, and  */
/* nothing below weakens the org scoping above: these helpers only ever answer  */
/* "is the CALLER an admin?", never "may the caller see this resource?".        */
/*                                                                             */
/* `isAdmin` is read fresh from the User row rather than carried on the session */
/* record, so revoking an admin takes effect on the next request instead of     */
/* whenever their 30-day session happens to expire. The id comes from the       */
/* session, never from client input.                                           */
/* -------------------------------------------------------------------------- */

/** Throws UNAUTHENTICATED without a session, FORBIDDEN for a non-admin. */
export async function requireAdmin(): Promise<SessionUser> {
  const user = await requireUser();
  const row = await prisma.user.findUnique({
    where: { id: user.id },
    select: { isAdmin: true },
  });
  if (!row?.isAdmin) throw new AuthzError('FORBIDDEN');
  return user;
}

/** Non-throwing variant, for deciding whether to render the admin nav entry. */
export async function isCurrentUserAdmin(): Promise<boolean> {
  const session = await readSession();
  if (!session) return false;
  const row = await prisma.user.findUnique({
    where: { id: session.user.id },
    select: { isAdmin: true },
  });
  return row?.isAdmin === true;
}

/* -------------------------------------------------------------------------- */
/* URL-tuple loaders (pages / layouts)                                         */
/*                                                                             */
/* Every ancestor segment of the URL is a CONSTRAINT in the SAME query, so a    */
/* mismatched ancestor yields null rather than needing a separate assertion.    */
/* -------------------------------------------------------------------------- */

export async function requireOrgBySlug(orgSlug: string): Promise<OrgCtx> {
  const user = await requireUser();
  const row = await prisma.organization.findFirst({
    where: {
      slug: orgSlug,
      memberships: { some: { userId: user.id } },
    },
    select: orgSelect(user.id),
  });
  if (!row) throw new AuthzError('NOT_FOUND');
  return toOrgCtx(user, row);
}

/**
 * Non-throwing. Exists because one caller -- the workspace page -- has to tell
 * "no such workspace" apart from "not yours" only to decide whether to try the
 * segment as a legacy project key instead, and a thrown NOT_FOUND cannot be
 * caught without also swallowing UNAUTHENTICATED.
 */
export async function findWorkspaceBySlug(
  orgSlug: string,
  workspaceSlug: string,
): Promise<WorkspaceCtx | null> {
  const user = await requireUser();
  const row = await prisma.workspace.findFirst({
    where: {
      slug: workspaceSlug,
      organization: { slug: orgSlug, memberships: { some: { userId: user.id } } },
    },
    select: workspaceSelect(user.id),
  });
  return row ? toWorkspaceCtx(user, row) : null;
}

export async function requireWorkspaceBySlug(
  orgSlug: string,
  workspaceSlug: string,
): Promise<WorkspaceCtx> {
  const ctx = await findWorkspaceBySlug(orgSlug, workspaceSlug);
  if (!ctx) throw new AuthzError('NOT_FOUND');
  return ctx;
}

/**
 * The workspace slug is a CONSTRAINT, not a hint: asking for `ENG` under the
 * wrong workspace yields null, exactly as asking for it under the wrong org
 * does. `Project.key` stays unique per organization, so the workspace segment
 * never disambiguates the lookup — it only proves the URL is the canonical one.
 */
export async function requireProjectByKey(
  orgSlug: string,
  workspaceSlug: string,
  projectKey: string,
): Promise<ProjectCtx> {
  const user = await requireUser();
  const row = await prisma.project.findFirst({
    where: {
      key: projectKey,
      workspace: {
        slug: workspaceSlug,
        organization: { slug: orgSlug, memberships: { some: { userId: user.id } } },
      },
    },
    select: projectSelect(user.id),
  });
  if (!row) throw new AuthzError('NOT_FOUND');
  return toProjectCtx(user, row);
}

/**
 * The same project, resolved WITHOUT the workspace segment. For Server Actions.
 *
 * The workspace is not an access boundary -- the membership predicate on the
 * organization is, and `Project.key` is unique per organization, so the
 * workspace slug never narrows the result. It earns its place in the URL-tuple
 * loader above only as proof that the URL is canonical, which an action has no
 * URL to check. Threading a hidden `workspaceSlug` input through every form to
 * re-assert something the org predicate already settles would be ceremony, and
 * ceremony is where authorization bugs hide.
 *
 * The returned ctx still carries the workspace, so `projectPath` and every
 * revalidation target built from it are complete.
 */
export async function findProjectByKeyInOrg(
  orgSlug: string,
  projectKey: string,
): Promise<ProjectCtx | null> {
  const user = await requireUser();
  const row = await prisma.project.findFirst({
    where: {
      key: projectKey,
      workspace: {
        organization: { slug: orgSlug, memberships: { some: { userId: user.id } } },
      },
    },
    select: projectSelect(user.id),
  });
  return row ? toProjectCtx(user, row) : null;
}

export async function requireProjectByKeyInOrg(
  orgSlug: string,
  projectKey: string,
): Promise<ProjectCtx> {
  const ctx = await findProjectByKeyInOrg(orgSlug, projectKey);
  if (!ctx) throw new AuthzError('NOT_FOUND');
  return ctx;
}

export async function requireBoardInPath(
  orgSlug: string,
  workspaceSlug: string,
  projectKey: string,
  boardId: string,
): Promise<BoardCtx> {
  const user = await requireUser();
  const row = await prisma.board.findFirst({
    where: {
      id: boardId,
      project: {
        key: projectKey,
        workspace: {
          slug: workspaceSlug,
          organization: { slug: orgSlug, memberships: { some: { userId: user.id } } },
        },
      },
    },
    select: { id: true, name: true, project: { select: projectSelect(user.id) } },
  });
  if (!row) throw new AuthzError('NOT_FOUND');
  return toBoardCtx(user, row);
}

/**
 * An issue by its PROJECT-scoped number: `/orgs/acme/VED/issue/153`.
 *
 * The board is no longer part of the tuple. It could not be -- a board-less
 * issue has no board segment to match, and requiring one would make those
 * issues permanently unreachable.
 */
export async function requireTicketInPath(
  orgSlug: string,
  workspaceSlug: string,
  projectKey: string,
  ticketNumber: number,
): Promise<TicketCtx> {
  const user = await requireUser();
  const row = await prisma.ticket.findFirst({
    where: {
      number: ticketNumber,
      project: {
        key: projectKey,
        workspace: {
          slug: workspaceSlug,
          organization: { slug: orgSlug, memberships: { some: { userId: user.id } } },
        },
      },
    },
    select: ticketSelect(user.id),
  });
  if (!row) throw new AuthzError('NOT_FOUND');
  return toTicketCtx(user, row);
}

export async function requireCycleInPath(
  orgSlug: string,
  workspaceSlug: string,
  projectKey: string,
  cycleNumber: number,
): Promise<CycleCtx> {
  const user = await requireUser();
  const row = await prisma.cycle.findFirst({
    where: {
      number: cycleNumber,
      project: {
        key: projectKey,
        workspace: {
          slug: workspaceSlug,
          organization: { slug: orgSlug, memberships: { some: { userId: user.id } } },
        },
      },
    },
    select: {
      id: true,
      number: true,
      name: true,
      startsAt: true,
      endsAt: true,
      project: { select: projectSelect(user.id) },
    },
  });
  if (!row) throw new AuthzError('NOT_FOUND');
  return toCycleCtx(user, row);
}

/* -------------------------------------------------------------------------- */
/* Leaf-id loaders (Server Actions)                                            */
/*                                                                             */
/* Each walks UP to the organization in one query and returns the whole chain,  */
/* so the caller never has to re-fetch an ancestor to build a revalidate path.  */
/* -------------------------------------------------------------------------- */

export async function requireProject(projectId: string): Promise<ProjectCtx> {
  const user = await requireUser();
  const row = await prisma.project.findFirst({
    where: {
      id: projectId,
      organization: { memberships: { some: { userId: user.id } } },
    },
    select: projectSelect(user.id),
  });
  if (!row) throw new AuthzError('NOT_FOUND');
  return toProjectCtx(user, row);
}

export async function requireBoard(boardId: string): Promise<BoardCtx> {
  const user = await requireUser();
  const row = await prisma.board.findFirst({
    where: {
      id: boardId,
      project: { organization: { memberships: { some: { userId: user.id } } } },
    },
    select: { id: true, name: true, project: { select: projectSelect(user.id) } },
  });
  if (!row) throw new AuthzError('NOT_FOUND');
  return toBoardCtx(user, row);
}

export async function requireTicket(ticketId: string): Promise<TicketCtx> {
  const user = await requireUser();
  const row = await prisma.ticket.findFirst({
    where: {
      id: ticketId,
      project: { organization: { memberships: { some: { userId: user.id } } } },
    },
    select: ticketSelect(user.id),
  });
  if (!row) throw new AuthzError('NOT_FOUND');
  return toTicketCtx(user, row);
}

export async function requireComment(commentId: string): Promise<CommentCtx> {
  const user = await requireUser();
  const row = await prisma.comment.findFirst({
    where: {
      id: commentId,
      ticket: { project: { organization: { memberships: { some: { userId: user.id } } } } },
    },
    select: {
      id: true,
      ticketId: true,
      authorId: true,
      body: true,
      ticket: { select: ticketSelect(user.id) },
    },
  });
  if (!row) throw new AuthzError('NOT_FOUND');
  return toCommentCtx(user, row);
}

/**
 * An image attachment, for `GET /api/attachments/[id]`.
 *
 * The walk is the whole authorization for serving a private object: attachment ->
 * project -> organization, with the membership predicate in the SAME query. A
 * signed-out caller, a caller in another tenant and a deleted row all produce the
 * same `null` and therefore the same 404, so an image id cannot be used to probe
 * for anything.
 *
 * THROUGH THE PROJECT, NOT THE TICKET, and deliberately: `Attachment.ticketId` is
 * null for an image pasted into an issue that has not been created yet, and a walk
 * rooted at the ticket would make those permanently unservable -- the same hole
 * `requireTicketInPath` avoids by not walking through the optional board. It gives
 * nothing away, because every member of an organization can already read every
 * issue in every one of its projects.
 */
export async function requireAttachment(attachmentId: string): Promise<AttachmentCtx> {
  const user = await requireUser();
  const row = await prisma.attachment.findFirst({
    where: {
      id: attachmentId,
      project: { organization: { memberships: { some: { userId: user.id } } } },
    },
    select: {
      id: true,
      projectId: true,
      ticketId: true,
      key: true,
      filename: true,
      mimeType: true,
      project: { select: projectSelect(user.id) },
    },
  });
  if (!row) throw new AuthzError('NOT_FOUND');
  return toAttachmentCtx(user, row);
}

/* -------------------------------------------------------------------------- */
/* Intra-resource integrity guards                                             */
/*                                                                             */
/* Each of these takes an id that came from an AUTHORIZED context as its scope  */
/* and a CLIENT-SUPPLIED id as its subject, and proves the second belongs to    */
/* the first. Nothing in the schema forces the relationship; these are the only */
/* thing standing between the app and a cross-project write.                    */
/* -------------------------------------------------------------------------- */

/**
 * MANDATORY before any write of `Ticket.stateId`.
 *
 * The successor to `requireColumnInBoard`. A forged state id can no longer drop
 * an issue into another board's column, because it would have to be a state of
 * this PROJECT -- and the project id always comes from the upward walk.
 */
export async function requireStateInProject(
  projectId: string,
  stateId: string,
): Promise<StateRef> {
  const state = await prisma.workflowState.findFirst({
    where: { id: stateId, projectId },
    select: { id: true, name: true, type: true, position: true },
  });
  if (!state) throw new AuthzError('NOT_FOUND');
  return state;
}

/**
 * MANDATORY before storing a client-supplied `projectId` against an
 * already-authorized organization -- the reminder scope selector is the only
 * caller today. Returns the same `ProjectRef` shape the path builders take, so
 * a scoped reminder can be linked without a second query.
 */
export async function requireProjectInOrg(
  organizationId: string,
  projectId: string,
): Promise<ProjectRef> {
  const project = await prisma.project.findFirst({
    where: { id: projectId, organizationId },
    select: {
      id: true,
      name: true,
      key: true,
      description: true,
      workspace: { select: { slug: true } },
    },
  });
  if (!project) throw new AuthzError('NOT_FOUND');
  return {
    id: project.id,
    name: project.name,
    key: project.key,
    description: project.description,
    workspaceSlug: project.workspace.slug,
  };
}

/** MANDATORY before any write of `Ticket.boardId` to a non-null value. */
export async function requireBoardInProject(
  projectId: string,
  boardId: string,
): Promise<BoardRef> {
  const board = await prisma.board.findFirst({
    where: { id: boardId, projectId },
    select: { id: true, name: true },
  });
  if (!board) throw new AuthzError('NOT_FOUND');
  return board;
}

/** MANDATORY before any write of `Ticket.cycleId` to a non-null value. */
export async function requireCycleInProject(
  projectId: string,
  cycleId: string,
): Promise<CycleRef> {
  const cycle = await prisma.cycle.findFirst({
    where: { id: cycleId, projectId },
    select: { id: true, number: true, name: true, startsAt: true, endsAt: true },
  });
  if (!cycle) throw new AuthzError('NOT_FOUND');
  return cycle;
}

/**
 * MANDATORY before any write of `Ticket.parentId`.
 *
 * Refuses to make an issue its own parent, and refuses a parent that already
 * has one -- Linear allows exactly one level of sub-issue, and a cycle in the
 * parent chain would make the progress rollup below recurse forever.
 */
export async function requireParentInProject(
  projectId: string,
  childId: string,
  parentId: string,
): Promise<{ id: string; number: number }> {
  if (childId === parentId) throw new AuthzError('NOT_FOUND');
  const parent = await prisma.ticket.findFirst({
    where: { id: parentId, projectId, parentId: null },
    select: { id: true, number: true },
  });
  if (!parent) throw new AuthzError('NOT_FOUND');
  return parent;
}

/**
 * MANDATORY before writing a ticket's label set. Returns the ids that survived,
 * so a forged one is dropped rather than rejected -- the caller has already
 * decided the rest of the edit is valid.
 */
export async function filterLabelsInProject(
  projectId: string,
  labelIds: string[],
): Promise<string[]> {
  if (labelIds.length === 0) return [];
  const rows = await prisma.label.findMany({
    where: { projectId, id: { in: labelIds } },
    select: { id: true },
  });
  return rows.map((row) => row.id);
}

/**
 * MANDATORY before any write of `Ticket.assigneeId`. NOT_FOUND if the candidate
 * has no Membership in this organization, so assignment cannot be used to probe
 * for user ids across the tenant boundary.
 */
export async function assertOrgMember(
  organizationId: string,
  candidateUserId: string,
): Promise<void> {
  const membership = await prisma.membership.findFirst({
    where: { organizationId, userId: candidateUserId },
    select: { id: true },
  });
  if (!membership) throw new AuthzError('NOT_FOUND');
}

/** Target membership for member-management actions, scoped to an already-authorized org. */
export async function requireMembershipInOrg(
  organizationId: string,
  membershipId: string,
): Promise<{
  id: string;
  userId: string;
  role: Role;
  user: { id: string; name: string; email: string };
}> {
  const membership = await prisma.membership.findFirst({
    where: { id: membershipId, organizationId },
    select: {
      id: true,
      userId: true,
      role: true,
      user: { select: { id: true, name: true, email: true } },
    },
  });
  if (!membership) throw new AuthzError('NOT_FOUND');
  return membership;
}

/* -------------------------------------------------------------------------- */
/* Roles                                                                       */
/* -------------------------------------------------------------------------- */

export const ROLE_RANK: Record<Role, number> = {
  MEMBER: 1,
  ADMIN: 2,
  OWNER: 3,
};

export function atLeast(role: Role, min: Role): boolean {
  return ROLE_RANK[role] >= ROLE_RANK[min];
}

/** Throws FORBIDDEN. Only ever raised on a resource the caller can already see. */
export function requireRole(ctx: { role: Role }, min: Role): void {
  if (!atLeast(ctx.role, min)) throw new AuthzError('FORBIDDEN');
}

/**
 * Author-or-privileged. Used for comment edit/delete and for ticket delete:
 * a MEMBER may act on their own row, ADMIN and OWNER on anyone's.
 */
export function requireAuthorOrRole(
  ctx: { user: SessionUser; role: Role },
  authorId: string,
  min: Role,
): void {
  if (ctx.user.id === authorId) return;
  requireRole(ctx, min);
}

/* -------------------------------------------------------------------------- */
/* Path builders                                                               */
/*                                                                             */
/* Always built from the upward walk; NEVER from a client-submitted path.       */
/* -------------------------------------------------------------------------- */

export function orgPath(org: OrgRef): string {
  return `/orgs/${encodeURIComponent(org.slug)}`;
}

export function orgSettingsPath(org: OrgRef): string {
  return `${orgPath(org)}/settings`;
}

/**
 * The signed-in user's Daily Challenges board, at ORGANIZATION scope.
 *
 * It sits beside workspace slugs rather than under one, because a pick may name
 * an issue from any project in the organization. `challenges` is in
 * `RESERVED_SLUGS` for exactly that reason -- otherwise a workspace could be
 * created at this path and shadow it.
 */
export function challengesPath(org: OrgRef): string {
  return `${orgPath(org)}/challenges`;
}

/**
 * Scheduled reminders, at ORGANIZATION scope for the same reason the challenges
 * board is: a reminder may name any project in the organization, or none at
 * all, so there is no one workspace it belongs under. `reminders` is in
 * `RESERVED_SLUGS` so a workspace cannot be created at this path and shadow it.
 */
export function remindersPath(org: OrgRef): string {
  return `${orgPath(org)}/reminders`;
}

export function workspacePath(org: OrgRef, workspace: WorkspaceRef): string {
  return `${orgPath(org)}/${encodeURIComponent(workspace.slug)}`;
}

export function workspaceSettingsPath(org: OrgRef, workspace: WorkspaceRef): string {
  return `${workspacePath(org, workspace)}/settings`;
}

/**
 * The project's home -- Linear's team overview.
 *
 * Every other project-scoped path below is built from this one, so the
 * workspace segment was added here and nowhere else. The slug rides on
 * `ProjectRef` for exactly that reason; see the type.
 */
export function projectPath(org: OrgRef, project: ProjectRef): string {
  return `${orgPath(org)}/${encodeURIComponent(project.workspaceSlug)}/${encodeURIComponent(project.key)}`;
}

export function issuesPath(org: OrgRef, project: ProjectRef): string {
  return `${projectPath(org, project)}/issues`;
}

export function cyclesPath(org: OrgRef, project: ProjectRef): string {
  return `${projectPath(org, project)}/cycles`;
}

export function cyclePath(org: OrgRef, project: ProjectRef, cycleNumber: number): string {
  return `${cyclesPath(org, project)}/${cycleNumber}`;
}

export function boardsPath(org: OrgRef, project: ProjectRef): string {
  return `${projectPath(org, project)}/boards`;
}

export function boardPath(org: OrgRef, project: ProjectRef, board: BoardRef): string {
  return `${boardsPath(org, project)}/${encodeURIComponent(board.id)}`;
}

/**
 * Recurring ticket templates, at PROJECT scope -- unlike `remindersPath`, which
 * is organization-scoped. Everything the page offers belongs to one project:
 * its labels, and the Todo-type state a spawned ticket lands in.
 *
 * NO `RESERVED_SLUGS` ENTRY, deliberately. That denylist protects segments that
 * sit where a user-chosen SLUG could be created. This one sits under a project
 * KEY, and `projectKeySchema` admits uppercase only, so a lowercase static
 * segment cannot collide with a key -- the same argument that let `issues`,
 * `boards` and `cycles` stay off the list.
 */
export function recurringPath(org: OrgRef, project: ProjectRef): string {
  return `${projectPath(org, project)}/recurring`;
}

/** An issue lives at the PROJECT, not under a board. */
export function ticketPath(org: OrgRef, project: ProjectRef, ticketNumber: number): string {
  return `${projectPath(org, project)}/issue/${ticketNumber}`;
}

export function viewsPath(org: OrgRef, project: ProjectRef): string {
  return `${projectPath(org, project)}/views`;
}

export function projectSettingsPath(org: OrgRef, project: ProjectRef): string {
  return `${projectPath(org, project)}/settings`;
}

/**
 * Every surface an issue can appear on, for revalidation after a write.
 *
 * Collected in one place because an issue is now visible from five routes at
 * once: forgetting one leaves a stale list that looks like a lost write. The
 * board path is included only when the issue is actually on a board.
 */
export function ticketSurfaces(ctx: {
  org: OrgRef;
  project: ProjectRef;
  board: BoardRef | null;
  ticket: { number: number };
}): string[] {
  const paths = [
    projectPath(ctx.org, ctx.project),
    issuesPath(ctx.org, ctx.project),
    cyclesPath(ctx.org, ctx.project),
    ticketPath(ctx.org, ctx.project, ctx.ticket.number),
  ];
  if (ctx.board) paths.push(boardPath(ctx.org, ctx.project, ctx.board));
  return paths;
}

/* -------------------------------------------------------------------------- */
/* Adapters -- the ONLY places AuthzError is translated                        */
/* -------------------------------------------------------------------------- */

/**
 * For RSC pages and layouts.
 *   UNAUTHENTICATED -> redirect('/login')
 *   NOT_FOUND, FORBIDDEN -> notFound()
 *
 * FORBIDDEN renders identically to NOT_FOUND at the HTTP level, so the two are
 * indistinguishable to a caller who should not know the resource exists.
 */
export async function loadPage<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    if (isNextControlFlowError(e)) throw e;
    if (e instanceof AuthzError) {
      if (e.kind === 'UNAUTHENTICATED') redirect('/login');
      notFound();
    }
    throw e;
  }
}

/**
 * For Server Actions. Maps AuthzError to a fixed literal, logs anything else
 * server-side behind a correlation id, and returns ERRORS.UNEXPECTED.
 *
 * Next control-flow errors MUST be re-thrown: `redirect()` and `notFound()`
 * signal by throwing, and swallowing them would turn a successful mutation into
 * "Something went wrong."
 */
export async function runAction(fn: () => Promise<ActionResult>): Promise<ActionResult> {
  try {
    return await fn();
  } catch (e) {
    if (isNextControlFlowError(e)) throw e;

    if (e instanceof AuthzError) {
      switch (e.kind) {
        case 'UNAUTHENTICATED':
          return { ok: false, error: ERRORS.UNAUTHENTICATED };
        case 'FORBIDDEN':
          return { ok: false, error: ERRORS.FORBIDDEN };
        default:
          return { ok: false, error: ERRORS.NOT_FOUND };
      }
    }

    // A short code plus a random correlation id -- never `e.message`, never the
    // input object, never a Prisma message (SPEC 4.7).
    const ref = randomUUID().slice(0, 8);
    console.error(`[action] unexpected_failure ref=${ref}`);
    return { ok: false, error: ERRORS.UNEXPECTED };
  }
}
