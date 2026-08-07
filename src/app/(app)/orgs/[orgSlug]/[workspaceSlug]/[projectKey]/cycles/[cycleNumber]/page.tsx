import Link from 'next/link';
import { notFound } from 'next/navigation';

import { Burndown } from '@/components/burndown';
import { Assignee, IssueListView } from '@/components/issue-row';
import { cyclesPath, loadPage, requireCycleInPath, requireProjectByKey } from '@/lib/authz';
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

const RANGE = new Intl.DateTimeFormat('en-GB', {
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
        project: { organization: { memberships: { some: { userId: ctx.user.id } } } },
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
    <div className="flex flex-col gap-4">
      <nav aria-label="Breadcrumb" className="flex items-center gap-1.5 text-[0.8125rem]">
        <Link
          href={cyclesPath(ctx.org, ctx.project)}
          className="text-tertiary no-underline hover:text-primary"
        >
          Cycles
        </Link>
        <span aria-hidden="true" className="text-tertiary opacity-60">
          /
        </span>
        <span aria-current="page" className="font-medium text-primary">
          Cycle {ctx.cycle.number}
        </span>
      </nav>

      <header className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <h1 className="text-lg font-semibold text-primary">
            {ctx.cycle.name ?? `Cycle ${ctx.cycle.number}`}
          </h1>
          {isCurrent ? (
            <span className="rounded-full bg-brand-primary px-2 py-px text-[0.6875rem] font-medium text-brand-secondary">
              Current
            </span>
          ) : null}
          <span className="text-[0.8125rem] text-tertiary tabular-nums">
            {RANGE.format(ctx.cycle.startsAt)} – {RANGE.format(ctx.cycle.endsAt)}
          </span>
        </div>
        {composeState ? (
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
        ) : null}
      </header>

      <div className="grid items-start gap-4 lg:grid-cols-[minmax(0,1fr)_17rem]">
        <div className="min-w-0">
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

        <aside className="flex flex-col gap-4 rounded-xl border border-secondary p-4">
          <h2 className="text-[0.8125rem] font-medium text-primary">Progress</h2>

          <dl className="grid grid-cols-3 gap-2 text-center">
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

          <div className="flex flex-col gap-2">
            <h3 className="text-[0.6875rem] font-medium tracking-wide text-tertiary uppercase">
              Assignees
            </h3>
            {assignees.length === 0 ? (
              <p className="text-[0.8125rem] text-tertiary">Nobody assigned yet.</p>
            ) : (
              <ul className="flex flex-col gap-1.5">
                {assignees.map(({ assignee }) =>
                  assignee ? (
                    <li key={assignee.id} className="flex items-center gap-2">
                      <Assignee name={assignee.name} />
                      <span className="min-w-0 truncate text-[0.8125rem] text-tertiary">
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
    </div>
  );
}

function Stat({ term, value }: { term: string; value: number }) {
  return (
    <div className="rounded-lg bg-secondary/60 py-2">
      <dt className="text-[0.625rem] tracking-wide text-tertiary uppercase">{term}</dt>
      <dd className="text-base font-semibold text-primary tabular-nums">{value}</dd>
    </div>
  );
}
