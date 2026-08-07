import Link from 'next/link';

import { cyclePath, loadPage, projectSettingsPath, requireProjectByKey } from '@/lib/authz';
import { ensureCycles, listCycles } from '@/lib/cycles';
import { prisma } from '@/lib/db';
import { isDone } from '@/lib/model';
import { cx } from '@/lib/utils/cx';

/**
 * Cycles: the current one and what is queued behind it.
 *
 * Rows are MATERIALIZED on this read -- see `ensureCycles`. There is no
 * scheduler; the cadence on the project is the source of truth and the rows are
 * caught up whenever somebody looks.
 *
 * Past cycles are reachable by number but deliberately not listed. A list that
 * grows by one every fortnight forever is not navigation.
 */

type Params = { orgSlug: string; workspaceSlug: string; projectKey: string };

const RANGE = new Intl.DateTimeFormat('en-GB', {
  day: 'numeric',
  month: 'short',
  timeZone: 'UTC',
});

export default async function CyclesPage({ params }: { params: Promise<Params> }) {
  const { orgSlug, workspaceSlug, projectKey } = await params;
  const ctx = await loadPage(() => requireProjectByKey(orgSlug, workspaceSlug, projectKey.toUpperCase()));

  const now = new Date();
  const state = await ensureCycles(ctx.project.id, now);

  if (!state) {
    return (
      <div className="flex flex-col gap-4">
        <h1 className="text-lg font-semibold text-primary">Cycles</h1>
        <div className="rounded-xl border border-secondary px-4 py-10 text-center text-sm text-tertiary">
          Cycles are switched off for {ctx.project.key}.{' '}
          <Link href={projectSettingsPath(ctx.org, ctx.project)} className="underline">
            Turn them on in settings
          </Link>
          .
        </div>
      </div>
    );
  }

  const cycles = await listCycles(ctx.project.id, state.current);
  const counts = await countByCycle(
    ctx.project.id,
    cycles.map((cycle) => cycle.id),
  );

  return (
    <div className="flex flex-col gap-4">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-lg font-semibold text-primary">Cycles</h1>
        <span className="text-sm text-tertiary">
          {state.cadence.cycleWeeks}-week cycles
        </span>
      </header>

      <ul className="overflow-hidden rounded-xl border border-secondary">
        {cycles.map((cycle) => {
          const current = cycle.number === state.current;
          const tally = counts.get(cycle.id) ?? { total: 0, done: 0 };
          return (
            <li key={cycle.id}>
              <Link
                href={cyclePath(ctx.org, ctx.project, cycle.number)}
                className="flex items-center gap-3 border-b border-secondary px-3 py-2.5 no-underline last:border-b-0 hover:bg-secondary/60"
              >
                <span
                  className={cx(
                    'grid size-6 shrink-0 place-items-center rounded-full text-[0.6875rem] font-medium tabular-nums',
                    current ? 'bg-brand-solid text-white' : 'bg-secondary text-tertiary',
                  )}
                >
                  {cycle.number}
                </span>

                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[0.8125rem] font-medium text-primary">
                    {cycle.name ?? `Cycle ${cycle.number}`}
                  </span>
                  <span className="block text-[0.6875rem] text-tertiary tabular-nums">
                    {RANGE.format(cycle.startsAt)} – {RANGE.format(cycle.endsAt)}
                  </span>
                </span>

                {current ? (
                  <span className="shrink-0 rounded-full bg-brand-primary px-2 py-px text-[0.6875rem] font-medium text-brand-secondary">
                    Current
                  </span>
                ) : null}

                <span className="shrink-0 text-[0.6875rem] text-tertiary tabular-nums">
                  {tally.done}/{tally.total}
                </span>
              </Link>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/**
 * Issue tallies per cycle in two grouped counts, rather than one query per row.
 * A cadence of twelve upcoming cycles would otherwise be twenty-four queries to
 * render a list nobody scrolls.
 */
async function countByCycle(
  projectId: string,
  cycleIds: string[],
): Promise<Map<string, { total: number; done: number }>> {
  const out = new Map<string, { total: number; done: number }>();
  if (cycleIds.length === 0) return out;

  const states = await prisma.workflowState.findMany({
    where: { projectId },
    select: { id: true, type: true },
  });
  const doneIds = states.filter((state) => isDone(state.type)).map((state) => state.id);

  const [totals, dones] = await Promise.all([
    prisma.ticket.groupBy({
      by: ['cycleId'],
      where: { projectId, cycleId: { in: cycleIds } },
      _count: { _all: true },
    }),
    doneIds.length > 0
      ? prisma.ticket.groupBy({
          by: ['cycleId'],
          where: { projectId, cycleId: { in: cycleIds }, stateId: { in: doneIds } },
          _count: { _all: true },
        })
      : Promise.resolve([]),
  ]);

  for (const row of totals) {
    if (row.cycleId) out.set(row.cycleId, { total: row._count._all, done: 0 });
  }
  for (const row of dones) {
    if (!row.cycleId) continue;
    const entry = out.get(row.cycleId);
    if (entry) entry.done = row._count._all;
  }
  return out;
}
