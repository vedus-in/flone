import Link from 'next/link';
import { notFound } from 'next/navigation';

import { Badge, Card, Prose } from '@/components/ui';
import {
  atLeast,
  boardPath,
  loadPage,
  orgPath,
  projectPath,
  requireTicketInPath,
} from '@/lib/authz';
import { prisma } from '@/lib/db';
import { COLUMN_ORDER, ticketNumberSchema } from '@/lib/validation';
import {
  CommentThread,
  TicketAssignForm,
  TicketDeleteForm,
  TicketEditForm,
  TicketMoveForm,
  type CommentItem,
} from './comments';

/**
 * Ticket detail + comment thread (SPEC 5, 6.9).
 *
 * `requireTicketInPath` constrains the ticket number, the board id, the project
 * key AND the org slug in one query, together with the caller's membership. A
 * mismatch anywhere in the tuple returns `null`, which `loadPage` renders as a
 * plain 404 -- identical to "does not exist", so no existence oracle appears.
 *
 * The follow-up read below repeats the membership predicate rather than trusting
 * the id alone, so it is safe on its own terms.
 */

type TicketParams = {
  orgSlug: string;
  projectKey: string;
  boardId: string;
  ticketNumber: string;
};

/**
 * Formatted on the server with an explicit locale and timezone so the rendered
 * string is deterministic instead of depending on the machine that ran it.
 */
const DATE_TIME = new Intl.DateTimeFormat('en-GB', {
  dateStyle: 'medium',
  timeStyle: 'short',
  timeZone: 'UTC',
});

function formatDateTime(value: Date): string {
  return `${DATE_TIME.format(value)} UTC`;
}

/** A one-second window absorbs the write-time skew between the two columns. */
function wasEdited(createdAt: Date, updatedAt: Date): boolean {
  return updatedAt.getTime() - createdAt.getTime() > 1000;
}

export default async function TicketPage({ params }: { params: Promise<TicketParams> }) {
  const { orgSlug, projectKey, boardId, ticketNumber } = await params;
  if (!orgSlug || !projectKey || !boardId || !ticketNumber) notFound();

  // A segment that fails to parse is a 404, never a Prisma error.
  const parsedNumber = ticketNumberSchema.safeParse(ticketNumber);
  if (!parsedNumber.success) notFound();

  const ctx = await loadPage(() =>
    requireTicketInPath(orgSlug, projectKey.toUpperCase(), boardId, parsedNumber.data),
  );

  const [detail, columns, memberships] = await Promise.all([
    prisma.ticket.findFirst({
      where: {
        id: ctx.ticket.id,
        board: { project: { organization: { memberships: { some: { userId: ctx.user.id } } } } },
      },
      select: {
        createdAt: true,
        updatedAt: true,
        createdBy: { select: { id: true, name: true } },
        assignee: { select: { id: true, name: true } },
        column: { select: { id: true, name: true } },
        comments: {
          orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
          select: {
            id: true,
            body: true,
            createdAt: true,
            updatedAt: true,
            authorId: true,
            author: { select: { id: true, name: true } },
          },
        },
      },
    }),
    prisma.boardColumn.findMany({
      where: { boardId: ctx.board.id },
      orderBy: COLUMN_ORDER,
      select: { id: true, name: true },
    }),
    prisma.membership.findMany({
      where: { organizationId: ctx.org.id },
      orderBy: [{ user: { name: 'asc' } }, { userId: 'asc' }],
      select: { user: { select: { id: true, name: true } } },
    }),
  ]);

  if (!detail) notFound();

  const isPrivileged = atLeast(ctx.role, 'ADMIN');
  const canDeleteTicket = isPrivileged || ctx.ticket.createdById === ctx.user.id;

  const comments: CommentItem[] = detail.comments.map((comment) => ({
    id: comment.id,
    body: comment.body,
    authorName: comment.author.name,
    createdAtLabel: formatDateTime(comment.createdAt),
    createdAtIso: comment.createdAt.toISOString(),
    edited: wasEdited(comment.createdAt, comment.updatedAt),
    canManage: isPrivileged || comment.authorId === ctx.user.id,
  }));

  const members = memberships.map((membership) => ({
    id: membership.user.id,
    name: membership.user.name,
  }));

  const label = `${ctx.project.key}-${ctx.ticket.number}`;

  return (
    <div className="stack">
      <nav className="breadcrumb" aria-label="Breadcrumb">
        <Link href={orgPath(ctx.org)}>{ctx.org.name}</Link>
        <span className="sep" aria-hidden="true">
          /
        </span>
        <Link href={projectPath(ctx.org, ctx.project)}>{ctx.project.name}</Link>
        <span className="sep" aria-hidden="true">
          /
        </span>
        <Link href={boardPath(ctx.org, ctx.project, ctx.board)}>{ctx.board.name}</Link>
        <span className="sep" aria-hidden="true">
          /
        </span>
        <span aria-current="page" className="mono">
          {label}
        </span>
      </nav>

      <div className="page-head">
        <div className="stack-sm">
          <div className="row">
            <Badge className="mono">{label}</Badge>
            <Badge tone="accent">{detail.column.name}</Badge>
          </div>
          <h1>{ctx.ticket.title}</h1>
        </div>
      </div>

      <Card>
        <div className="stack">
          <h2>Description</h2>
          {ctx.ticket.description ? (
            <Prose>{ctx.ticket.description}</Prose>
          ) : (
            <p className="muted">No description.</p>
          )}

          <hr className="divider" />

          <div className="row">
            <div className="stack-sm">
              <span className="label">Assignee</span>
              <span>{detail.assignee?.name ?? 'Unassigned'}</span>
            </div>
            <div className="stack-sm">
              <span className="label">Reporter</span>
              <span>{detail.createdBy.name}</span>
            </div>
            <div className="stack-sm">
              <span className="label">Created</span>
              <time dateTime={detail.createdAt.toISOString()}>
                {formatDateTime(detail.createdAt)}
              </time>
            </div>
            <div className="stack-sm">
              <span className="label">Updated</span>
              <time dateTime={detail.updatedAt.toISOString()}>
                {formatDateTime(detail.updatedAt)}
              </time>
            </div>
          </div>

          <details>
            <summary>Edit ticket</summary>
            <TicketEditForm
              ticketId={ctx.ticket.id}
              title={ctx.ticket.title}
              description={ctx.ticket.description ?? ''}
            />
          </details>
        </div>
      </Card>

      <div className="grid">
        <Card tight>
          <TicketMoveForm
            ticketId={ctx.ticket.id}
            columnId={detail.column.id}
            columns={columns}
          />
        </Card>
        <Card tight>
          <TicketAssignForm
            ticketId={ctx.ticket.id}
            assigneeId={detail.assignee?.id ?? null}
            members={members}
          />
        </Card>
      </div>

      <Card>
        <div className="stack">
          <h2>
            Comments{' '}
            <span className="faint">
              ({comments.length})
            </span>
          </h2>
          <CommentThread ticketId={ctx.ticket.id} comments={comments} />
        </div>
      </Card>

      {canDeleteTicket ? (
        <Card className="danger-zone" tight>
          <TicketDeleteForm ticketId={ctx.ticket.id} />
        </Card>
      ) : null}
    </div>
  );
}
