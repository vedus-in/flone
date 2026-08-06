import Link from 'next/link';

import { IssueListView } from '@/components/issue-row';
import { cyclePath, cyclesPath, loadPage, requireProjectByKey } from '@/lib/authz';
import { ensureCycles, listCycles } from '@/lib/cycles';
import { loadIssues, parseIssueFilters } from '@/lib/issues';
import { loadWorkspace } from '@/lib/workspace';

import { RowBoardMenu } from '../../row-board-menu';

/**
 * Everything queued behind the current cycle.
 *
 * One list per upcoming cycle rather than one combined list: the point of the
 * page is to see how the next few sprints are shaped, and merging them would
 * lose exactly the boundary you came to look at.
 */

type Params = { orgSlug: string; projectKey: string };

const RANGE = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' });

export default async function UpcomingCyclesPage({ params }: { params: Promise<Params> }) {
  const { orgSlug, projectKey } = await params;
  const ctx = await loadPage(() => requireProjectByKey(orgSlug, projectKey.toUpperCase()));

  const state = await ensureCycles(ctx.project.id);
  if (!state) {
    return (
      <div className="flex flex-col gap-4">
        <h1 className="text-lg font-semibold text-primary">Upcoming</h1>
        <div className="rounded-xl border border-secondary px-4 py-10 text-center text-sm text-tertiary">
          Cycles are switched off for {ctx.project.key}.
        </div>
      </div>
    );
  }

  const cycles = (await listCycles(ctx.project.id, state.current + 1)).slice(0, 6);
  const filters = parseIssueFilters({}, 'all');

  const [workspace, sections] = await Promise.all([
    loadWorkspace(ctx),
    Promise.all(
      cycles.map(async (cycle) => ({
        cycle,
        loaded: await loadIssues(ctx, { filters, scope: { cycleId: cycle.id } }),
      })),
    ),
  ]);

  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-lg font-semibold text-primary">Upcoming</h1>
        <Link
          href={cyclesPath(ctx.org, ctx.project)}
          className="text-[0.8125rem] text-tertiary no-underline hover:text-primary"
        >
          All cycles
        </Link>
      </header>

      {sections.length === 0 ? (
        <div className="rounded-xl border border-secondary px-4 py-10 text-center text-sm text-tertiary">
          Nothing queued yet.
        </div>
      ) : (
        sections.map(({ cycle, loaded }) => (
          <section key={cycle.id} className="flex flex-col gap-2">
            <header className="flex items-baseline gap-2">
              <Link
                href={cyclePath(ctx.org, ctx.project, cycle.number)}
                className="text-[0.8125rem] font-medium text-primary no-underline hover:underline"
              >
                {cycle.name ?? `Cycle ${cycle.number}`}
              </Link>
              <span className="text-[0.6875rem] text-tertiary tabular-nums">
                {RANGE.format(cycle.startsAt)} – {RANGE.format(cycle.endsAt)}
              </span>
              <span className="text-[0.6875rem] text-tertiary tabular-nums">
                {loaded.total} {loaded.total === 1 ? 'issue' : 'issues'}
              </span>
            </header>
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
              emptyMessage="Nothing planned for this cycle yet."
            />
          </section>
        ))
      )}
    </div>
  );
}
