import Link from 'next/link';

import { projectCrumb } from '@/components/crumbs';
import { IconCycle } from '@/components/icons';
import { IssueListView } from '@/components/issue-row';
import { PageBar } from '@/components/page-bar';
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

type Params = { orgSlug: string; workspaceSlug: string; projectKey: string };

const RANGE = new Intl.DateTimeFormat('en-US', { day: 'numeric', month: 'short', timeZone: 'UTC' });

export default async function UpcomingCyclesPage({ params }: { params: Promise<Params> }) {
  const { orgSlug, workspaceSlug, projectKey } = await params;
  const ctx = await loadPage(() => requireProjectByKey(orgSlug, workspaceSlug, projectKey.toUpperCase()));

  const state = await ensureCycles(ctx.project.id);
  const crumbs = [
    projectCrumb(ctx.org, ctx.project),
    { label: 'Cycles', href: cyclesPath(ctx.org, ctx.project) },
    { label: 'Upcoming' },
  ];

  if (!state) {
    return (
      <>
        <PageBar crumbs={crumbs} />
        <p className="px-4.5 py-10 text-center text-sm text-tertiary">
          Cycles are switched off for {ctx.project.key}.
        </p>
      </>
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
    <>
      <PageBar crumbs={crumbs} />

      {sections.length === 0 ? (
        <p className="px-4.5 py-10 text-center text-sm text-tertiary">Nothing queued yet.</p>
      ) : (
        sections.map(({ cycle, loaded }) => (
          <section key={cycle.id} className="flex flex-col pt-2 pb-4">
            <header className="flex h-10 items-center gap-2 px-4.5">
              <IconCycle className="size-4 text-tertiary" />
              <Link
                href={cyclePath(ctx.org, ctx.project, cycle.number)}
                className="text-sm font-medium text-primary no-underline hover:underline"
              >
                {cycle.name ?? `Cycle ${cycle.number}`}
              </Link>
              <span className="text-xs text-tertiary tabular-nums">
                {RANGE.format(cycle.startsAt)} – {RANGE.format(cycle.endsAt)}
              </span>
              <span className="ms-auto text-xs text-tertiary tabular-nums">
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
    </>
  );
}
