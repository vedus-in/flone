import { notFound } from 'next/navigation';

import { projectCrumb } from '@/components/crumbs';
import { IconBoard } from '@/components/icons';
import { PageBar, PageToolbar } from '@/components/page-bar';
import { boardsPath, loadPage, requireBoardInPath, ticketPath, visibleProject } from '@/lib/authz';
import { prisma } from '@/lib/db';
import { sortStatesForBoard } from '@/lib/model';
import { defaultComposeState } from '@/lib/states';
import { TICKET_ORDER } from '@/lib/validation';
import { loadWorkspace } from '@/lib/workspace';

import { IssueComposer } from '../../issue-composer';
import { BoardView, type BoardStateColumn } from './board-view';

/**
 * A board's kanban.
 *
 * Its columns are the PROJECT's workflow states, in board order (backlog on the
 * left). The board owns no columns of its own -- that is what the Linear rework
 * removed -- so this page reads the states from the project and the issues from
 * the board.
 *
 * `requireBoardInPath` puts EVERY ancestor segment of the URL into the same
 * `where` clause, so a mismatched org slug or project key yields `null` --
 * indistinguishable from "does not exist". `loadPage` turns that into
 * `notFound()`; there is no separate 403 to leak from.
 *
 * This stays a Server Component: every Untitled UI module carries its own
 * `'use client'`, so the only client code shipped from this route is
 * `board-view.tsx` and the compose dialog, which genuinely need hooks.
 */

type BoardParams = { orgSlug: string; workspaceSlug: string; projectKey: string; boardId: string };

export default async function BoardPage({ params }: { params: Promise<BoardParams> }) {
  // Next 15: params is a Promise. A query must never be built from an undefined
  // segment -- that would turn the membership predicate into match-anything.
  const { orgSlug, workspaceSlug, projectKey, boardId } = await params;
  if (!orgSlug || !projectKey || !boardId) notFound();

  const ctx = await loadPage(() => requireBoardInPath(orgSlug, workspaceSlug, projectKey.toUpperCase(), boardId));
  const workspace = await loadWorkspace(ctx);

  const issues = await prisma.ticket.findMany({
    where: {
      projectId: ctx.project.id,
      boardId: ctx.board.id,
      // Repeated rather than trusting the ids alone, so this read is safe on its
      // own terms.
      project: visibleProject(ctx.user.id),
    },
    orderBy: TICKET_ORDER,
    select: {
      id: true,
      number: true,
      title: true,
      priority: true,
      dueDate: true,
      createdAt: true,
      updatedAt: true,
      createdById: true,
      stateId: true,
      cycleId: true,
      assignee: { select: { id: true, name: true } },
      parent: { select: { title: true } },
      labels: { orderBy: [{ name: 'asc' }], select: { id: true, name: true, color: true } },
      _count: { select: { comments: true } },
    },
  });

  /**
   * Dates are formatted HERE, with a fixed locale and UTC, so the server-rendered
   * markup and the client's first render agree. Deriving them in the browser
   * would produce a hydration mismatch on any machine not on this locale.
   */
  const dayFormat = new Intl.DateTimeFormat('en-GB', {
    day: 'numeric',
    month: 'short',
    timeZone: 'UTC',
  });
  const stampFormat = new Intl.DateTimeFormat('en-GB', {
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
    timeZone: 'UTC',
  });
  const startOfToday = new Date();
  startOfToday.setUTCHours(0, 0, 0, 0);

  // Author-or-privileged, the same rule `deleteIssue` enforces. Computed here so
  // the card menu does not offer an action that is certain to be refused.
  const isPrivileged = ctx.role === 'ADMIN' || ctx.role === 'OWNER';

  const columns: BoardStateColumn[] = sortStatesForBoard(workspace.states).map((state) => ({
    id: state.id,
    name: state.name,
    type: state.type,
    color: state.color,
    issues: issues
      .filter((issue) => issue.stateId === state.id)
      .map((issue) => ({
        id: issue.id,
        number: issue.number,
        title: issue.title,
        href: ticketPath(ctx.org, ctx.project, issue.number),
        assigneeId: issue.assignee?.id ?? null,
        assigneeName: issue.assignee?.name ?? null,
        parentTitle: issue.parent?.title ?? null,
        commentCount: issue._count.comments,
        priority: issue.priority,
        labels: issue.labels,
        cycleId: issue.cycleId,
        dueDateLabel: issue.dueDate ? dayFormat.format(issue.dueDate) : null,
        overdue: issue.dueDate ? issue.dueDate < startOfToday : false,
        createdAtLabel: dayFormat.format(issue.createdAt),
        updatedAtLabel: stampFormat.format(issue.updatedAt),
        canDelete: isPrivileged || issue.createdById === ctx.user.id,
      })),
  }));

  const composeState = defaultComposeState(workspace.states);

  return (
    <>
      <PageBar
        crumbs={[
          projectCrumb(ctx.org, ctx.project),
          { label: 'Boards', href: boardsPath(ctx.org, ctx.project) },
          { label: ctx.board.name, icon: <IconBoard className="size-3.5 text-tertiary" /> },
        ]}
        actions={
          composeState ? (
            <IssueComposer
              projectId={ctx.project.id}
              projectKey={ctx.project.key}
              states={workspace.states}
              boards={workspace.boards}
              cycles={workspace.cycles}
              labels={workspace.labels}
              members={workspace.members}
              defaultStateId={composeState.id}
              defaultBoardId={ctx.board.id}
            />
          ) : null
        }
      />

      <PageToolbar>
        <span className="px-2 text-xs text-tertiary tabular-nums">
          {issues.length} {issues.length === 1 ? 'issue' : 'issues'}
        </span>
      </PageToolbar>

      <BoardView
        projectKey={ctx.project.key}
        columns={columns}
        members={workspace.members}
        boards={workspace.boards}
        labels={workspace.labels}
        cycles={workspace.cycles}
        boardId={ctx.board.id}
      />
    </>
  );
}
