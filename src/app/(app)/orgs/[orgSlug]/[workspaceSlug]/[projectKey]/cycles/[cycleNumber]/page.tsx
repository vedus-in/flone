import { notFound } from 'next/navigation';

import { Burndown } from '@/components/burndown';
import { projectCrumb } from '@/components/crumbs';
import { IconCycle } from '@/components/icons';
import { PageBar } from '@/components/page-bar';
import { Assignee, IssueListView } from '@/components/issue-row';
import { cyclesPath, loadPage, requireCycleInPath, requireProjectByKey, visibleProject } from '@/lib/authz';
import { ensureCycles } from '@/lib/cycles';
import { prisma } from '@/lib/db';
import { loadCycleProgress, loadIssues, parseIssueFilters } from '@/lib/issues';
import { defaultComposeState } from '@/lib/states';
import { cycleNumberSchema } from '@/lib/validation';
import { loadWorkspace } from '@/lib/workspace';

import { IssueComposer } from '../../issue-composer';
import { RowBoardMenu } from '../../row-board-menu';

/**
 * One cycle: its issues grouped by state, and a progress panel beside them.
 *
 * `requireCycleInPath` constrains the cycle number, the project key AND the org
 * slug in one query together with the caller's membership, so a mismatch
 * anywhere in the tuple is a plain 404.
 *
 * `ensureCycles` runs first so that opening a cycle that has just begun
 * materializes it rather than 404ing on a row nobody has caused to exist yet.
 */

type Params = { orgSlug: string; workspaceSlug: string; projectKey: string; cycleNumber: string };

const RANGE = new Intl.DateTimeFormat('en-US', {
  day: 'numeric',
  month: 'short',
  timeZone: 'UTC',
});

export default async function CyclePage({
  params,
  searchParams,
}: {
  params: Promise<Params>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { orgSlug, workspaceSlug, projectKey, cycleNumber } = await params;
  const search = await searchParams;

  // A segment that fails to parse is a 404, never a Prisma error.
  const parsedNumber = cycleNumberSchema.safeParse(cycleNumber);
  if (!parsedNumber.success) notFound();

  // Materialize before the lookup, so a cycle that has only just started still
  // resolves on the first visit.
  const project = await loadPage(() => requireProjectByKey(orgSlug, workspaceSlug, projectKey.toUpperCase()));
  const generated = await ensureCycles(project.project.id);

  const ctx = await loadPage(() =>
    requireCycleInPath(orgSlug, workspaceSlug, projectKey.toUpperCase(), parsedNumber.data),
  );

  const now = new Date();
  const filters = parseIssueFilters(search, 'all');

  const [workspace, loaded, progress, assignees] = await Promise.all([
    loadWorkspace(ctx),
    loadIssues(ctx, { filters, scope: { cycleId: ctx.cycle.id } }),
    loadCycleProgress(ctx.project.id, ctx.cycle.id),
    prisma.ticket.findMany({
      where: {
        projectId: ctx.project.id,
        cycleId: ctx.cycle.id,
        assigneeId: { not: null },
        project: visibleProject(ctx.user.id),
      },
      distinct: ['assigneeId'],
      select: { assignee: { select: { id: true, name: true } } },
      orderBy: { assigneeId: 'asc' },
    }),
  ]);

  const composeState = defaultComposeState(workspace.states);
  const isCurrent = generated?.current === ctx.cycle.number;
  const remaining = Math.max(0, progress.scope - progress.completed);

  return (
    <>
      <PageBar
        crumbs={[
          projectCrumb(ctx.org, ctx.project),
          { label: 'Cycles', href: cyclesPath(ctx.org, ctx.project) },
          {
            label: ctx.cycle.name ?? `Cycle ${ctx.cycle.number}`,
            icon: <IconCycle className="size-3.5 text-tertiary" />,
          },
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
              defaultCycleId={ctx.cycle.id}
            />
          ) : null
        }
      >
        {isCurrent ? (
          <span className="rounded-full bg-brand-primary px-2 py-px text-[0.6875rem] font-medium text-brand-secondary">
            Current
          </span>
        ) : null}
        <span className="hidden px-1 text-xs text-tertiary tabular-nums sm:block">
          {RANGE.format(ctx.cycle.startsAt)} – {RANGE.format(ctx.cycle.endsAt)}
        </span>
      </PageBar>

      <div className="flex items-start">
        <div className="min-w-0 flex-1 py-2">
          <IssueListView
            groups={loaded.groups}
            renderAction={(row) => (
              <RowBoardMenu
                ticketId={row.id}
                issueLabel={row.label}
                boardId={row.board?.id ?? null}
                boards={workspace.boards}
              />
            )}
            emptyMessage="No issues in this cycle yet."
          />
        </div>

        {/* Linear's cycle side panel: a raised card inset in the page, pinned
            under the header while the list scrolls past it. */}
        <aside className="sticky top-13 m-2 hidden w-[300px] shrink-0 flex-col gap-5 rounded-lg border border-secondary_alt bg-secondary p-4 lg:flex">
          <h2 className="text-sm font-medium text-primary">Progress</h2>

          <dl className="grid grid-cols-3 gap-2">
            <Stat term="Scope" value={progress.scope} />
            <Stat term="Done" value={progress.completed} />
            <Stat term="Left" value={remaining} />
          </dl>

          <Burndown
            scope={progress.scope}
            completions={progress.completions}
            startsAt={ctx.cycle.startsAt}
            endsAt={ctx.cycle.endsAt}
            now={now}
          />

          <div className="flex flex-col gap-1">
            <h3 className="pb-1 text-xs font-medium text-tertiary">Assignees</h3>
            {assignees.length === 0 ? (
              <p className="text-sm text-tertiary">Nobody assigned yet.</p>
            ) : (
              <ul className="flex flex-col">
                {assignees.map(({ assignee }) =>
                  assignee ? (
                    <li key={assignee.id} className="flex h-8 items-center gap-2">
                      <Assignee name={assignee.name} />
                      <span className="min-w-0 truncate text-sm text-secondary">
                        {assignee.name}
                      </span>
                    </li>
                  ) : null,
                )}
              </ul>
            )}
          </div>
        </aside>
      </div>
    </>
  );
}

function Stat({ term, value }: { term: string; value: number }) {
  return (
    <div className="flex flex-col gap-0.5">
      <dt className="text-xs text-tertiary">{term}</dt>
      <dd className="text-lg font-medium text-primary tabular-nums">{value}</dd>
    </div>
  );
}
