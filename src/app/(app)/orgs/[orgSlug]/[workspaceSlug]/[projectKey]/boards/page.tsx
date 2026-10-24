import Link from 'next/link';
import { BoardStatus, Role } from '@prisma/client';

import { boardPath, issuesPath, loadPage, requireProjectByKey, visibleProject, atLeast } from '@/lib/authz';
import { prisma } from '@/lib/db';
import { colorClass, isDone } from '@/lib/model';
import { cx } from '@/lib/utils/cx';
import { projectCrumb } from '@/components/crumbs';
import { IconBoard, IconPlus } from '@/components/icons';
import { PAGE_BAR_ACTION, PageBar } from '@/components/page-bar';

import { ActionForm } from '../../../../../action-form';
import { createBoard } from '../actions';

/**
 * Boards -- what Linear calls projects: a named grouping of issues inside the
 * team, rendered as the chip on an issue row.
 *
 * Optional by design. An issue need not be on one, so this page is a place to
 * organize work rather than a gate every issue has to pass through.
 */

type Params = { orgSlug: string; workspaceSlug: string; projectKey: string };

const STATUS_LABEL: Record<BoardStatus, string> = {
  [BoardStatus.BACKLOG]: 'Backlog',
  [BoardStatus.PLANNED]: 'Planned',
  [BoardStatus.STARTED]: 'In progress',
  [BoardStatus.PAUSED]: 'Paused',
  [BoardStatus.COMPLETED]: 'Completed',
  [BoardStatus.CANCELED]: 'Canceled',
};

const STATUS_TONE: Record<BoardStatus, string> = {
  [BoardStatus.BACKLOG]: 'text-tertiary',
  [BoardStatus.PLANNED]: 'text-tertiary',
  [BoardStatus.STARTED]: 'text-warning-primary',
  [BoardStatus.PAUSED]: 'text-tertiary',
  [BoardStatus.COMPLETED]: 'text-success-primary',
  [BoardStatus.CANCELED]: 'text-tertiary',
};

const DATE = new Intl.DateTimeFormat('en-US', { day: 'numeric', month: 'short', timeZone: 'UTC' });

export default async function BoardsPage({ params }: { params: Promise<Params> }) {
  const { orgSlug, workspaceSlug, projectKey } = await params;
  const ctx = await loadPage(() => requireProjectByKey(orgSlug, workspaceSlug, projectKey.toUpperCase()));

  const [boards, doneStates, unfiled] = await Promise.all([
    prisma.board.findMany({
      where: {
        projectId: ctx.project.id,
        project: visibleProject(ctx.user.id),
      },
      orderBy: [{ name: 'asc' }, { id: 'asc' }],
      select: {
        id: true,
        name: true,
        description: true,
        status: true,
        color: true,
        targetDate: true,
        lead: { select: { name: true } },
        _count: { select: { tickets: true } },
      },
    }),
    prisma.workflowState.findMany({
      where: { projectId: ctx.project.id },
      select: { id: true, type: true },
    }),
    prisma.ticket.count({ where: { projectId: ctx.project.id, boardId: null } }),
  ]);

  const doneIds = doneStates.filter((state) => isDone(state.type)).map((state) => state.id);
  const completed =
    doneIds.length > 0 && boards.length > 0
      ? await prisma.ticket.groupBy({
          by: ['boardId'],
          where: {
            projectId: ctx.project.id,
            boardId: { in: boards.map((board) => board.id) },
            stateId: { in: doneIds },
          },
          _count: { _all: true },
        })
      : [];
  const doneByBoard = new Map(
    completed.map((row) => [row.boardId ?? '', row._count._all] as const),
  );

  const canManage = atLeast(ctx.role, Role.ADMIN);

  return (
    <>
      <PageBar
        crumbs={[projectCrumb(ctx.org, ctx.project), { label: 'Boards' }]}
        actions={
          unfiled > 0 ? (
            <Link href={`${issuesPath(ctx.org, ctx.project)}?tab=all`} className={PAGE_BAR_ACTION}>
              {unfiled} {unfiled === 1 ? 'issue is' : 'issues are'} on no board
            </Link>
          ) : null
        }
      />

      {boards.length === 0 ? (
        <p className="px-4.5 py-10 text-center text-sm text-tertiary">
          No boards yet. A board groups related issues — you do not need one to start working.
        </p>
      ) : (
        <ul className="flex flex-col py-2">
          {boards.map((board) => {
            const total = board._count.tickets;
            const done = doneByBoard.get(board.id) ?? 0;
            return (
              <li key={board.id} className="px-2">
                <Link
                  href={boardPath(ctx.org, ctx.project, board)}
                  className="flex h-11 items-center gap-3 rounded-md px-2.5 text-sm no-underline transition-colors hover:bg-secondary"
                >
                  <IconBoard className={cx('size-4', colorClass(board.color).text)} />

                  <span className="flex min-w-0 flex-1 items-baseline gap-2">
                    <span className="truncate font-medium text-primary">{board.name}</span>
                    {board.description ? (
                      <span className="hidden truncate text-xs text-tertiary sm:block">
                        {board.description}
                      </span>
                    ) : null}
                  </span>

                  <span className={cx('hidden w-24 shrink-0 text-xs sm:block', STATUS_TONE[board.status])}>
                    {STATUS_LABEL[board.status]}
                  </span>

                  <span className="hidden w-28 shrink-0 truncate text-xs text-tertiary md:block">
                    {board.lead?.name ?? ''}
                  </span>

                  <span className="hidden w-20 shrink-0 text-xs text-tertiary tabular-nums md:block">
                    {board.targetDate ? DATE.format(board.targetDate) : ''}
                  </span>

                  <span className="w-12 shrink-0 text-right text-xs text-tertiary tabular-nums">
                    {done}/{total}
                  </span>
                </Link>
              </li>
            );
          })}
        </ul>
      )}

      {canManage ? (
        <details className="group w-fit px-4.5 pb-6" open={boards.length === 0}>
          <summary className={cx(PAGE_BAR_ACTION, 'w-fit cursor-pointer list-none')}>
            <IconPlus className="size-3.5" />
            New board
          </summary>
          <div className="pt-2">
            <ActionForm
              action={createBoard}
              className="flex flex-wrap items-center gap-2"
              aria-label="New board"
            >
              <input type="hidden" name="orgSlug" value={ctx.org.slug} />
              <input type="hidden" name="projectKey" value={ctx.project.key} />
              <input
                name="name"
                required
                maxLength={80}
                autoComplete="off"
                placeholder="Board name"
                aria-label="Board name"
                className="h-8 rounded-md border border-primary bg-secondary_subtle px-2.5 text-sm text-primary placeholder:text-placeholder focus:border-brand focus:outline-none"
              />
              <button
                type="submit"
                className="h-8 rounded-md bg-brand-solid px-3 text-sm font-medium text-white transition-colors hover:bg-brand-solid_hover"
              >
                Create
              </button>
            </ActionForm>
          </div>
        </details>
      ) : null}
    </>
  );
}
