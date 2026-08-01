import 'server-only';
import { randomUUID } from 'node:crypto';
import { notFound, redirect } from 'next/navigation';
import { Role } from '@prisma/client';
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
 * Membership, Project, Board, BoardColumn, Ticket, Comment) must NEVER be
 * reached with `findUnique({ where: { id } })` or any `findFirst` / `count` /
 * `aggregate` lacking a tenant predicate. Fetch through a `require*` helper, or
 * via a nested `select` rooted at an already-authorized entity.
 */

/* -------------------------------------------------------------------------- */
/* Context shapes                                                              */
/* -------------------------------------------------------------------------- */

export type SessionUser = { id: string; email: string; name: string; sessionId: string };

export type OrgRef = { id: string; name: string; slug: string };
export type ProjectRef = { id: string; name: string; key: string; description: string | null };
export type BoardRef = { id: string; name: string };
export type TicketRef = {
  id: string;
  number: number;
  boardId: string;
  columnId: string;
  position: number;
  title: string;
  description: string | null;
  createdById: string;
  assigneeId: string | null;
};
export type CommentRef = { id: string; ticketId: string; authorId: string; body: string };

export type OrgCtx = { user: SessionUser; org: OrgRef; role: Role };
export type ProjectCtx = OrgCtx & { project: ProjectRef };
export type BoardCtx = ProjectCtx & { board: BoardRef };
export type TicketCtx = BoardCtx & { ticket: TicketRef };
export type CommentCtx = TicketCtx & { comment: CommentRef };

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
/* Row shapes returned by the upward-walk queries                              */
/* -------------------------------------------------------------------------- */

type OrgRow = { id: string; name: string; slug: string; memberships: Array<{ role: Role }> };
type ProjectRow = ProjectRef & { organization: OrgRow };
type BoardRow = BoardRef & { project: ProjectRow };
type TicketRow = TicketRef & { board: BoardRow };
type CommentRow = CommentRef & { ticket: TicketRow };

function toOrgCtx(user: SessionUser, row: OrgRow): OrgCtx {
  const role = row.memberships[0]?.role;
  // Belt and braces: the `where` clause already proved membership, so an empty
  // array here means the query was edited wrongly. Fail closed and indistinguishably.
  if (!role) throw new AuthzError('NOT_FOUND');
  return { user, org: { id: row.id, name: row.name, slug: row.slug }, role };
}

function toProjectCtx(user: SessionUser, row: ProjectRow): ProjectCtx {
  return {
    ...toOrgCtx(user, row.organization),
    project: { id: row.id, name: row.name, key: row.key, description: row.description },
  };
}

function toBoardCtx(user: SessionUser, row: BoardRow): BoardCtx {
  return {
    ...toProjectCtx(user, row.project),
    board: { id: row.id, name: row.name },
  };
}

function toTicketCtx(user: SessionUser, row: TicketRow): TicketCtx {
  return {
    ...toBoardCtx(user, row.board),
    ticket: {
      id: row.id,
      number: row.number,
      boardId: row.boardId,
      columnId: row.columnId,
      position: row.position,
      title: row.title,
      description: row.description,
      createdById: row.createdById,
      assigneeId: row.assigneeId,
    },
  };
}

function toCommentCtx(user: SessionUser, row: CommentRow): CommentCtx {
  return {
    ...toTicketCtx(user, row.ticket),
    comment: { id: row.id, ticketId: row.ticketId, authorId: row.authorId, body: row.body },
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

/** Memberships of the caller only. Used by `/` to dispatch and by the org picker. */
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
    select: {
      id: true,
      name: true,
      slug: true,
      memberships: { where: { userId: user.id }, select: { role: true }, take: 1 },
    },
  });
  if (!row) throw new AuthzError('NOT_FOUND');
  return toOrgCtx(user, row);
}

export async function requireProjectByKey(
  orgSlug: string,
  projectKey: string,
): Promise<ProjectCtx> {
  const user = await requireUser();
  const row = await prisma.project.findFirst({
    where: {
      key: projectKey,
      organization: { slug: orgSlug, memberships: { some: { userId: user.id } } },
    },
    select: {
      id: true,
      name: true,
      key: true,
      description: true,
      organization: {
        select: {
          id: true,
          name: true,
          slug: true,
          memberships: { where: { userId: user.id }, select: { role: true }, take: 1 },
        },
      },
    },
  });
  if (!row) throw new AuthzError('NOT_FOUND');
  return toProjectCtx(user, row);
}

export async function requireBoardInPath(
  orgSlug: string,
  projectKey: string,
  boardId: string,
): Promise<BoardCtx> {
  const user = await requireUser();
  const row = await prisma.board.findFirst({
    where: {
      id: boardId,
      project: {
        key: projectKey,
        organization: { slug: orgSlug, memberships: { some: { userId: user.id } } },
      },
    },
    select: {
      id: true,
      name: true,
      project: {
        select: {
          id: true,
          name: true,
          key: true,
          description: true,
          organization: {
            select: {
              id: true,
              name: true,
              slug: true,
              memberships: { where: { userId: user.id }, select: { role: true }, take: 1 },
            },
          },
        },
      },
    },
  });
  if (!row) throw new AuthzError('NOT_FOUND');
  return toBoardCtx(user, row);
}

export async function requireTicketInPath(
  orgSlug: string,
  projectKey: string,
  boardId: string,
  ticketNumber: number,
): Promise<TicketCtx> {
  const user = await requireUser();
  const row = await prisma.ticket.findFirst({
    where: {
      number: ticketNumber,
      boardId,
      board: {
        id: boardId,
        project: {
          key: projectKey,
          organization: { slug: orgSlug, memberships: { some: { userId: user.id } } },
        },
      },
    },
    select: {
      id: true,
      number: true,
      boardId: true,
      columnId: true,
      position: true,
      title: true,
      description: true,
      createdById: true,
      assigneeId: true,
      board: {
        select: {
          id: true,
          name: true,
          project: {
            select: {
              id: true,
              name: true,
              key: true,
              description: true,
              organization: {
                select: {
                  id: true,
                  name: true,
                  slug: true,
                  memberships: { where: { userId: user.id }, select: { role: true }, take: 1 },
                },
              },
            },
          },
        },
      },
    },
  });
  if (!row) throw new AuthzError('NOT_FOUND');
  return toTicketCtx(user, row);
}

/* -------------------------------------------------------------------------- */
/* Leaf-id loaders (Server Actions)                                            */
/*                                                                             */
/* Each walks UP to the organization in one query and returns the whole chain,  */
/* so the caller never has to re-fetch an ancestor to build a revalidate path.  */
/* -------------------------------------------------------------------------- */

export async function requireBoard(boardId: string): Promise<BoardCtx> {
  const user = await requireUser();
  const row = await prisma.board.findFirst({
    where: {
      id: boardId,
      project: { organization: { memberships: { some: { userId: user.id } } } },
    },
    select: {
      id: true,
      name: true,
      project: {
        select: {
          id: true,
          name: true,
          key: true,
          description: true,
          organization: {
            select: {
              id: true,
              name: true,
              slug: true,
              memberships: { where: { userId: user.id }, select: { role: true }, take: 1 },
            },
          },
        },
      },
    },
  });
  if (!row) throw new AuthzError('NOT_FOUND');
  return toBoardCtx(user, row);
}

export async function requireTicket(ticketId: string): Promise<TicketCtx> {
  const user = await requireUser();
  const row = await prisma.ticket.findFirst({
    where: {
      id: ticketId,
      board: { project: { organization: { memberships: { some: { userId: user.id } } } } },
    },
    select: {
      id: true,
      number: true,
      boardId: true,
      columnId: true,
      position: true,
      title: true,
      description: true,
      createdById: true,
      assigneeId: true,
      board: {
        select: {
          id: true,
          name: true,
          project: {
            select: {
              id: true,
              name: true,
              key: true,
              description: true,
              organization: {
                select: {
                  id: true,
                  name: true,
                  slug: true,
                  memberships: { where: { userId: user.id }, select: { role: true }, take: 1 },
                },
              },
            },
          },
        },
      },
    },
  });
  if (!row) throw new AuthzError('NOT_FOUND');
  return toTicketCtx(user, row);
}

export async function requireComment(commentId: string): Promise<CommentCtx> {
  const user = await requireUser();
  const row = await prisma.comment.findFirst({
    where: {
      id: commentId,
      ticket: {
        board: { project: { organization: { memberships: { some: { userId: user.id } } } } },
      },
    },
    select: {
      id: true,
      ticketId: true,
      authorId: true,
      body: true,
      ticket: {
        select: {
          id: true,
          number: true,
          boardId: true,
          columnId: true,
          position: true,
          title: true,
          description: true,
          createdById: true,
          assigneeId: true,
          board: {
            select: {
              id: true,
              name: true,
              project: {
                select: {
                  id: true,
                  name: true,
                  key: true,
                  description: true,
                  organization: {
                    select: {
                      id: true,
                      name: true,
                      slug: true,
                      memberships: {
                        where: { userId: user.id },
                        select: { role: true },
                        take: 1,
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
    },
  });
  if (!row) throw new AuthzError('NOT_FOUND');
  return toCommentCtx(user, row);
}

/* -------------------------------------------------------------------------- */
/* Intra-resource integrity guards                                             */
/* -------------------------------------------------------------------------- */

/**
 * MANDATORY before any write of `Ticket.columnId` (createTicket, moveTicket).
 *
 * Nothing in the schema forces a column to belong to the board (SPEC 8.7); this
 * helper is the ONLY thing standing between the app and a ticket whose
 * `boardId` and `columnId` disagree. `boardId` must come from an already
 * authorized context, never from the form.
 */
export async function requireColumnInBoard(
  boardId: string,
  columnId: string,
): Promise<{ id: string; boardId: string; name: string; position: number }> {
  const column = await prisma.boardColumn.findFirst({
    where: { id: columnId, boardId },
    select: { id: true, boardId: true, name: true, position: true },
  });
  if (!column) throw new AuthzError('NOT_FOUND');
  return column;
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

export function projectPath(org: OrgRef, project: ProjectRef): string {
  return `${orgPath(org)}/${encodeURIComponent(project.key)}`;
}

export function boardPath(org: OrgRef, project: ProjectRef, board: BoardRef): string {
  return `${projectPath(org, project)}/${encodeURIComponent(board.id)}`;
}

export function ticketPath(
  org: OrgRef,
  project: ProjectRef,
  board: BoardRef,
  ticketNumber: number,
): string {
  return `${boardPath(org, project, board)}/${ticketNumber}`;
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
