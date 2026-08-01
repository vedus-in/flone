import type { ReactNode } from 'react';
import Link from 'next/link';
import { notFound } from 'next/navigation';

import { Badge, ButtonLink, Card, PageHeader, Prose, Separator } from '@/components/ui';
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
 *
 * Presentation only: this page stays a Server Component. Every HeroUI module
 * ships its own `'use client'`, and the one genuinely interactive part of the
 * route lives in `comments.tsx`.
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

/* -------------------------------------------------------------------------- */
/* Local presentation helpers                                                  */
/* -------------------------------------------------------------------------- */

function CrumbSeparator() {
  return (
    <svg viewBox="0 0 16 16" fill="none" aria-hidden="true" className="size-3 shrink-0 opacity-50">
      <path
        d="M6 3.5 10.5 8 6 12.5"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function Crumb({ href, children }: { href: string; children: ReactNode }) {
  return (
    <Link
      href={href}
      className="rounded-sm px-0.5 font-medium no-underline hover:text-foreground hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
    >
      {children}
    </Link>
  );
}

function SectionHeading({ children }: { children: ReactNode }) {
  return <h2 className="text-sm leading-6 font-medium text-foreground">{children}</h2>;
}

function Fact({ term, children }: { term: string; children: ReactNode }) {
  return (
    <>
      <dt className="text-muted">{term}</dt>
      <dd className="min-w-0 text-foreground">{children}</dd>
    </>
  );
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
    <div className="flex flex-col gap-6">
      <nav aria-label="Breadcrumb" className="flex flex-wrap items-center gap-1 text-sm text-muted">
        <Crumb href={orgPath(ctx.org)}>{ctx.org.name}</Crumb>
        <CrumbSeparator />
        <Crumb href={projectPath(ctx.org, ctx.project)}>{ctx.project.name}</Crumb>
        <CrumbSeparator />
        <Crumb href={boardPath(ctx.org, ctx.project, ctx.board)}>{ctx.board.name}</Crumb>
        <CrumbSeparator />
        <span aria-current="page" className="px-0.5 font-mono font-medium text-foreground">
          {label}
        </span>
      </nav>

      <PageHeader
        title={ctx.ticket.title}
        actions={
          <ButtonLink
            href={boardPath(ctx.org, ctx.project, ctx.board)}
            variant="secondary"
            size="sm"
          >
            Back to board
          </ButtonLink>
        }
      >
        <Badge className="font-mono">{label}</Badge>
        <Badge tone="accent">{detail.column.name}</Badge>
        <span className="text-sm text-muted">
          Opened by {detail.createdBy.name} on{' '}
          <time dateTime={detail.createdAt.toISOString()}>{formatDateTime(detail.createdAt)}</time>
        </span>
      </PageHeader>

      <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,1fr)_20rem]">
        <div className="flex min-w-0 flex-col gap-6">
          <Card>
            <Card.Header>
              <SectionHeading>Description</SectionHeading>
            </Card.Header>
            <Card.Content className="gap-4">
              {ctx.ticket.description ? (
                <Prose>{ctx.ticket.description}</Prose>
              ) : (
                <p className="text-sm text-muted">No description yet.</p>
              )}

              <Separator />

              <TicketEditForm
                ticketId={ctx.ticket.id}
                title={ctx.ticket.title}
                description={ctx.ticket.description ?? ''}
              />
            </Card.Content>
          </Card>

          <Card>
            <Card.Header>
              <SectionHeading>Comments</SectionHeading>
              <Card.Description>
                {comments.length === 0
                  ? 'Nothing here yet'
                  : `${comments.length} ${comments.length === 1 ? 'comment' : 'comments'}`}
              </Card.Description>
            </Card.Header>
            <Card.Content className="gap-4">
              <CommentThread
                ticketId={ctx.ticket.id}
                comments={comments}
                currentUserName={ctx.user.name}
              />
            </Card.Content>
          </Card>
        </div>

        <aside className="flex min-w-0 flex-col gap-4">
          <Card>
            <Card.Header>
              <SectionHeading>Details</SectionHeading>
            </Card.Header>
            <Card.Content className="gap-4">
              <TicketMoveForm
                ticketId={ctx.ticket.id}
                columnId={detail.column.id}
                columns={columns}
              />

              <TicketAssignForm
                ticketId={ctx.ticket.id}
                assigneeId={detail.assignee?.id ?? null}
                members={members}
              />

              <Separator />

              <dl className="grid grid-cols-[auto_minmax(0,1fr)] items-baseline gap-x-4 gap-y-2 text-sm">
                <Fact term="Assignee">{detail.assignee?.name ?? 'Unassigned'}</Fact>
                <Fact term="Reporter">{detail.createdBy.name}</Fact>
                <Fact term="Created">
                  <time dateTime={detail.createdAt.toISOString()}>
                    {formatDateTime(detail.createdAt)}
                  </time>
                </Fact>
                <Fact term="Updated">
                  <time dateTime={detail.updatedAt.toISOString()}>
                    {formatDateTime(detail.updatedAt)}
                  </time>
                </Fact>
              </dl>
            </Card.Content>
          </Card>

          {canDeleteTicket ? (
            <Card>
              <Card.Content>
                <TicketDeleteForm ticketId={ctx.ticket.id} />
              </Card.Content>
            </Card>
          ) : null}
        </aside>
      </div>
    </div>
  );
}
