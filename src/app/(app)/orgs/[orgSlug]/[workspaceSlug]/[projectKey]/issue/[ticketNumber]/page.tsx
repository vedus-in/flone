import type { ReactNode } from 'react';
import Link from 'next/link';
import { notFound } from 'next/navigation';

import { Card, Separator } from '@/components/ui';
import { StateIcon } from '@/components/issue-row';
import {
  atLeast,
  issuesPath,
  loadPage,
  projectPath,
  requireTicketInPath,
  ticketPath,
} from '@/lib/authz';
import { prisma } from '@/lib/db';
import { isDone, sortStatesForBoard } from '@/lib/model';
import { ticketNumberSchema } from '@/lib/validation';
import { loadWorkspace } from '@/lib/workspace';

import { CommentThread, TicketDeleteForm, type CommentItem } from './comments';
import { InlineDescription, InlineTitle, PropertiesPanel } from './properties';

/**
 * Issue detail + comment thread, laid out the way Linear does it: the title
 * and description edit in place in the main column, and the right-hand
 * "Properties" sidebar changes status, priority, assignee, cycle, labels and
 * board through popup pickers.
 *
 * The URL is `/orgs/<org>/<KEY>/issue/<number>` -- no board segment, because an
 * issue need not be on a board and requiring one would make those permanently
 * unreachable. `requireTicketInPath` still constrains the issue number, the
 * project key AND the org slug in one query together with the caller's
 * membership, so a mismatch anywhere in the tuple returns `null`, which
 * `loadPage` renders as a plain 404.
 *
 * Presentation only: this page stays a Server Component. The interactive parts
 * of the route live in `properties.tsx` (editors and pickers) and
 * `comments.tsx` (thread and delete).
 */

type TicketParams = { orgSlug: string; workspaceSlug: string; projectKey: string; ticketNumber: string };

/**
 * Formatted on the server with an explicit locale and timezone so the rendered
 * string is deterministic instead of depending on the machine that ran it.
 */
const DATE_TIME = new Intl.DateTimeFormat('en-GB', {
  dateStyle: 'medium',
  timeStyle: 'short',
  timeZone: 'UTC',
});
const DATE = new Intl.DateTimeFormat('en-GB', { dateStyle: 'medium', timeZone: 'UTC' });

function formatDateTime(value: Date): string {
  return `${DATE_TIME.format(value)} UTC`;
}

/** A one-second window absorbs the write-time skew between the two columns. */
function wasEdited(createdAt: Date, updatedAt: Date): boolean {
  return updatedAt.getTime() - createdAt.getTime() > 1000;
}

function SectionHeading({ children }: { children: ReactNode }) {
  return <h2 className="text-sm leading-6 font-medium text-primary">{children}</h2>;
}

function Fact({ term, children }: { term: string; children: ReactNode }) {
  return (
    <>
      <dt className="text-tertiary">{term}</dt>
      <dd className="min-w-0 text-primary">{children}</dd>
    </>
  );
}

export default async function TicketPage({ params }: { params: Promise<TicketParams> }) {
  const { orgSlug, workspaceSlug, projectKey, ticketNumber } = await params;
  if (!orgSlug || !projectKey || !ticketNumber) notFound();

  // A segment that fails to parse is a 404, never a Prisma error.
  const parsedNumber = ticketNumberSchema.safeParse(ticketNumber);
  if (!parsedNumber.success) notFound();

  const ctx = await loadPage(() =>
    requireTicketInPath(orgSlug, workspaceSlug, projectKey.toUpperCase(), parsedNumber.data),
  );

  const [detail, workspace, children] = await Promise.all([
    prisma.ticket.findFirst({
      where: {
        id: ctx.ticket.id,
        // Repeated rather than trusting the id alone, so this read is safe on
        // its own terms.
        project: { organization: { memberships: { some: { userId: ctx.user.id } } } },
      },
      select: {
        createdAt: true,
        updatedAt: true,
        priority: true,
        dueDate: true,
        startedAt: true,
        completedAt: true,
        createdBy: { select: { id: true, name: true } },
        assignee: { select: { id: true, name: true } },
        state: { select: { id: true, name: true, type: true, color: true } },
        board: { select: { id: true, name: true, color: true } },
        cycle: { select: { id: true, number: true, name: true } },
        parent: { select: { number: true, title: true } },
        labels: { orderBy: [{ name: 'asc' }], select: { id: true, name: true, color: true } },
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
    loadWorkspace(ctx),
    prisma.ticket.findMany({
      where: {
        parentId: ctx.ticket.id,
        project: { organization: { memberships: { some: { userId: ctx.user.id } } } },
      },
      orderBy: [{ number: 'asc' }],
      select: {
        id: true,
        number: true,
        title: true,
        state: { select: { name: true, type: true, color: true } },
      },
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

  const label = `${ctx.project.key}-${ctx.ticket.number}`;
  const doneChildren = children.filter((child) => isDone(child.state.type)).length;

  return (
    <div className="flex flex-col gap-6">
      <nav aria-label="Breadcrumb" className="flex flex-wrap items-center gap-1.5 text-sm text-tertiary">
        <Link href={projectPath(ctx.org, ctx.project)} className="no-underline hover:text-primary">
          {ctx.project.name}
        </Link>
        <span aria-hidden="true" className="opacity-60">
          /
        </span>
        <Link href={issuesPath(ctx.org, ctx.project)} className="no-underline hover:text-primary">
          Issues
        </Link>
        <span aria-hidden="true" className="opacity-60">
          /
        </span>
        <span aria-current="page" className="font-mono font-medium text-primary">
          {label}
        </span>
      </nav>

      {detail.parent ? (
        <Link
          href={ticketPath(ctx.org, ctx.project, detail.parent.number)}
          className="flex w-fit items-center gap-1.5 rounded-lg border border-secondary px-2 py-1 text-[0.8125rem] text-tertiary no-underline transition-colors hover:bg-secondary hover:text-primary"
        >
          <span className="font-mono text-[0.6875rem]">
            {ctx.project.key}-{detail.parent.number}
          </span>
          <span className="max-w-80 truncate">{detail.parent.title}</span>
        </Link>
      ) : null}

      <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,1fr)_20rem]">
        <div className="flex min-w-0 flex-col gap-6">
          <div className="flex flex-col gap-3">
            <InlineTitle
              ticketId={ctx.ticket.id}
              title={ctx.ticket.title}
              description={ctx.ticket.description ?? ''}
            />
            <InlineDescription
              ticketId={ctx.ticket.id}
              title={ctx.ticket.title}
              description={ctx.ticket.description ?? ''}
            />
          </div>

          {children.length > 0 ? (
            <Card>
              <Card.Header>
                <SectionHeading>Sub-issues</SectionHeading>
                <Card.Description>
                  {doneChildren} of {children.length} done
                </Card.Description>
              </Card.Header>
              <Card.Content className="gap-0">
                {children.map((child) => (
                  <Link
                    key={child.id}
                    href={ticketPath(ctx.org, ctx.project, child.number)}
                    className="flex items-center gap-2 border-b border-secondary py-2 text-[0.8125rem] no-underline last:border-b-0 hover:bg-secondary/60"
                  >
                    <StateIcon type={child.state.type} color={child.state.color} />
                    <span className="w-16 shrink-0 font-mono text-[0.6875rem] text-tertiary tabular-nums">
                      {ctx.project.key}-{child.number}
                    </span>
                    <span className="min-w-0 flex-1 truncate text-primary">{child.title}</span>
                  </Link>
                ))}
              </Card.Content>
            </Card>
          ) : null}

          <Card>
            <Card.Header>
              <SectionHeading>Activity</SectionHeading>
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

        <aside className="flex min-w-0 flex-col gap-5">
          <PropertiesPanel
            ticketId={ctx.ticket.id}
            stateId={detail.state.id}
            priority={detail.priority}
            assigneeId={detail.assignee?.id ?? null}
            boardId={detail.board?.id ?? null}
            cycleId={detail.cycle?.id ?? null}
            labelIds={detail.labels.map((item) => item.id)}
            states={sortStatesForBoard(workspace.states)}
            members={workspace.members}
            boards={workspace.boards}
            cycles={workspace.cycles.map(({ id, number, name }) => ({ id, number, name }))}
            labels={workspace.labels}
          />

          <Separator />

          <dl className="grid grid-cols-[auto_minmax(0,1fr)] items-baseline gap-x-4 gap-y-2 text-sm">
            <Fact term="Reporter">{detail.createdBy.name}</Fact>
            <Fact term="Due">
              {detail.dueDate ? (
                <time dateTime={detail.dueDate.toISOString()}>{DATE.format(detail.dueDate)}</time>
              ) : (
                <span className="text-tertiary">No due date</span>
              )}
            </Fact>
            {detail.startedAt ? (
              <Fact term="Started">
                <time dateTime={detail.startedAt.toISOString()}>
                  {DATE.format(detail.startedAt)}
                </time>
              </Fact>
            ) : null}
            {detail.completedAt ? (
              <Fact term="Completed">
                <time dateTime={detail.completedAt.toISOString()}>
                  {DATE.format(detail.completedAt)}
                </time>
              </Fact>
            ) : null}
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
