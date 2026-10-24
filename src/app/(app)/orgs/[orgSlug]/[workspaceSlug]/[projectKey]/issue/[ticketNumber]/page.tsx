import type { ReactNode } from 'react';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { WorkflowStateType } from '@prisma/client';

import { projectCrumb } from '@/components/crumbs';
import { PageBar } from '@/components/page-bar';
import { IconChevronRight } from '@/components/icons';
import { Assignee, StateIcon } from '@/components/issue-row';
import {
  atLeast,
  issuesPath,
  loadPage,
  requireTicketInPath,
  ticketPath,
  visibleProject,
} from '@/lib/authz';
import { prisma } from '@/lib/db';
import { isDone, sortStatesForBoard } from '@/lib/model';
import { ticketNumberSchema } from '@/lib/validation';
import { relativeTime } from '@/lib/relative-time';
import { loadWorkspace } from '@/lib/workspace';

import { CommentThread, type ActivityEvent, type CommentItem } from './comments';
import { IssueMoreMenu } from './issue-more-menu';
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
const DATE_TIME = new Intl.DateTimeFormat('en-US', {
  dateStyle: 'medium',
  timeStyle: 'short',
  timeZone: 'UTC',
});
const DATE = new Intl.DateTimeFormat('en-US', { dateStyle: 'medium', timeZone: 'UTC' });

function formatDateTime(value: Date): string {
  return `${DATE_TIME.format(value)} UTC`;
}

/** A one-second window absorbs the write-time skew between the two columns. */
function wasEdited(createdAt: Date, updatedAt: Date): boolean {
  return updatedAt.getTime() - createdAt.getTime() > 1000;
}

function Fact({ term, children }: { term: string; children: ReactNode }) {
  return (
    <>
      <dt className="text-tertiary">{term}</dt>
      <dd className="min-w-0 text-secondary">{children}</dd>
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
        project: visibleProject(ctx.user.id),
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
        project: visibleProject(ctx.user.id),
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
  const now = new Date();

  const comments: CommentItem[] = detail.comments.map((comment) => ({
    id: comment.id,
    body: comment.body,
    authorName: comment.author.name,
    createdAtLabel: formatDateTime(comment.createdAt),
    createdAtRelative: relativeTime(comment.createdAt, now),
    createdAtIso: comment.createdAt.toISOString(),
    edited: wasEdited(comment.createdAt, comment.updatedAt),
    canManage: isPrivileged || comment.authorId === ctx.user.id,
  }));

  // The lifecycle stamps the issue carries, as timeline entries. There is no
  // change log behind them -- these are the moments the row itself records.
  const events: ActivityEvent[] = [
    {
      id: 'created',
      atIso: detail.createdAt.toISOString(),
      icon: <Assignee name={detail.createdBy.name} size="xs" />,
      content: (
        <>
          <span className="font-medium text-secondary">{detail.createdBy.name}</span> created the issue
          <Stamp at={detail.createdAt} now={now} />
        </>
      ),
    },
  ];
  if (detail.startedAt) {
    events.push({
      id: 'started',
      atIso: detail.startedAt.toISOString(),
      icon: <StateIcon type={WorkflowStateType.STARTED} color="warning" className="size-3" />,
      content: (
        <>
          Work started
          <Stamp at={detail.startedAt} now={now} />
        </>
      ),
    });
  }
  if (detail.completedAt) {
    events.push({
      id: 'completed',
      atIso: detail.completedAt.toISOString(),
      icon: <StateIcon type={WorkflowStateType.COMPLETED} color="brand" className="size-3" />,
      content: (
        <>
          Marked as done
          <Stamp at={detail.completedAt} now={now} />
        </>
      ),
    });
  }

  const label = `${ctx.project.key}-${ctx.ticket.number}`;
  const doneChildren = children.filter((child) => isDone(child.state.type)).length;

  return (
    <>
      <PageBar
        crumbHeading={false}
        crumbs={[
          projectCrumb(ctx.org, ctx.project),
          { label: 'Issues', href: issuesPath(ctx.org, ctx.project) },
          {
            label: (
              <>
                <span className="text-tertiary">{label}</span> {ctx.ticket.title}
              </>
            ),
          },
        ]}
      >
        <IssueMoreMenu ticketId={ctx.ticket.id} issueKey={label} canDelete={canDeleteTicket} />
      </PageBar>

      {/* Linear's issue view: the reading column and the properties beside it,
          centred together in the panel. */}
      <div className="mx-auto grid w-full max-w-[1200px] items-start gap-x-16 gap-y-10 px-4 py-8 sm:px-8 lg:grid-cols-[minmax(0,790px)_minmax(240px,300px)] lg:justify-center lg:px-12 lg:py-12">
        <div className="flex min-w-0 flex-col">
          {detail.parent ? (
            <Link
              href={ticketPath(ctx.org, ctx.project, detail.parent.number)}
              className="mb-3 flex w-fit max-w-full items-center gap-1.5 text-xs text-tertiary no-underline transition-colors hover:text-primary"
            >
              <span className="shrink-0 tabular-nums">
                {ctx.project.key}-{detail.parent.number}
              </span>
              <IconChevronRight className="size-3 shrink-0 text-quaternary" />
              <span className="truncate">{detail.parent.title}</span>
            </Link>
          ) : null}

          <div className="flex flex-col gap-4">
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
            <section aria-labelledby="sub-issues-heading" className="mt-10 flex flex-col">
              <h2 id="sub-issues-heading" className="mb-2 flex items-center gap-2 text-sm font-medium text-primary">
                Sub-issues
                <span className="text-xs font-normal text-tertiary tabular-nums">
                  {doneChildren}/{children.length}
                </span>
              </h2>
              <ul className="-mx-2 flex flex-col">
                {children.map((child) => (
                  <li key={child.id}>
                    <Link
                      href={ticketPath(ctx.org, ctx.project, child.number)}
                      className="flex h-9 items-center gap-2.5 rounded-md px-2 text-sm no-underline transition-colors hover:bg-secondary"
                    >
                      <StateIcon type={child.state.type} color={child.state.color} />
                      <span className="w-16 shrink-0 text-tertiary tabular-nums">
                        {ctx.project.key}-{child.number}
                      </span>
                      <span className="min-w-0 flex-1 truncate font-medium text-primary">{child.title}</span>
                    </Link>
                  </li>
                ))}
              </ul>
            </section>
          ) : null}

          <section aria-labelledby="activity-heading" className="mt-10 flex flex-col gap-4 border-t border-secondary pt-8">
            <h2 id="activity-heading" className="text-md font-semibold text-primary">
              Activity
            </h2>
            <CommentThread
              ticketId={ctx.ticket.id}
              comments={comments}
              events={events}
              // Everyone a comment may @mention. The same list the assignee
              // picker uses -- the organization's members, and nobody else.
              members={workspace.members}
              currentUserName={ctx.user.name}
            />
          </section>
        </div>

        <aside className="flex min-w-0 flex-col gap-7 lg:sticky lg:top-[92px]">
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

          <section className="flex flex-col">
            <h2 className="mb-1 px-2 text-xs font-medium text-tertiary">Details</h2>
            <dl className="grid grid-cols-[auto_minmax(0,1fr)] items-baseline gap-x-4 gap-y-2 px-2 text-xs">
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
                  <time dateTime={detail.startedAt.toISOString()}>{DATE.format(detail.startedAt)}</time>
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
                <time dateTime={detail.createdAt.toISOString()}>{DATE.format(detail.createdAt)}</time>
              </Fact>
              <Fact term="Updated">
                <time dateTime={detail.updatedAt.toISOString()} title={formatDateTime(detail.updatedAt)}>
                  {relativeTime(detail.updatedAt, now)}
                </time>
              </Fact>
            </dl>
          </section>
        </aside>
      </div>
    </>
  );
}

/** " · 5mo ago", with the full date on hover. */
function Stamp({ at, now }: { at: Date; now: Date }) {
  return (
    <>
      {' · '}
      <time dateTime={at.toISOString()} title={formatDateTime(at)}>
        {relativeTime(at, now)}
      </time>
    </>
  );
}
