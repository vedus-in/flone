import Link from 'next/link';

import { cyclePath, loadPage, projectSettingsPath, requireProjectByKey } from '@/lib/authz';
import { ensureCycles, listCycles } from '@/lib/cycles';
import { prisma } from '@/lib/db';
import { isDone } from '@/lib/model';
import { cx } from '@/lib/utils/cx';
import { projectCrumb } from '@/components/crumbs';
import { IconCycle } from '@/components/icons';
import { PageBar } from '@/components/page-bar';

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

const RANGE = new Intl.DateTimeFormat('en-US', {
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
      <>
        <PageBar crumbs={[projectCrumb(ctx.org, ctx.project), { label: 'Cycles' }]} />
        <p className="px-4.5 py-10 text-center text-sm text-tertiary">
          Cycles are switched off for {ctx.project.key}.{' '}
          <Link href={projectSettingsPath(ctx.org, ctx.project)} className="text-secondary underline">
            Turn them on in settings
          </Link>
          .
        </p>
      </>
    );
  }

  const cycles = await listCycles(ctx.project.id, state.current);
  const counts = await countByCycle(
    ctx.project.id,
    cycles.map((cycle) => cycle.id),
  );

  return (
    <>
      <PageBar
        crumbs={[projectCrumb(ctx.org, ctx.project), { label: 'Cycles' }]}
        actions={
          <span className="px-2 text-xs text-tertiary">{state.cadence.cycleWeeks}-week cycles</span>
        }
      />

      <ul className="flex flex-col py-2">
        {cycles.map((cycle) => {
          const current = cycle.number === state.current;
          const tally = counts.get(cycle.id) ?? { total: 0, done: 0 };
          const percent = tally.total === 0 ? 0 : Math.round((tally.done / tally.total) * 100);
          return (
            <li key={cycle.id} className="px-2">
              <Link
                href={cyclePath(ctx.org, ctx.project, cycle.number)}
                className="flex h-11 items-center gap-3 rounded-md px-2.5 text-sm no-underline transition-colors hover:bg-secondary"
              >
                <IconCycle className={cx('size-4', current ? 'text-brand-secondary' : 'text-tertiary')} />

                <span className="min-w-0 truncate font-medium text-primary">
                  {cycle.name ?? `Cycle ${cycle.number}`}
                </span>

                {current ? (
                  <span className="shrink-0 rounded-full bg-brand-primary px-2 py-px text-[0.6875rem] font-medium text-brand-secondary">
                    Current
                  </span>
                ) : null}

                <span className="ms-auto shrink-0 text-xs text-tertiary tabular-nums">
                  {RANGE.format(cycle.startsAt)} – {RANGE.format(cycle.endsAt)}
                </span>

                <span className="hidden w-16 shrink-0 text-right text-xs text-tertiary tabular-nums sm:block">
                  {tally.done}/{tally.total}
                </span>

                <span className="w-10 shrink-0 text-right text-xs text-tertiary tabular-nums">
                  {percent}%
                </span>
              </Link>
            </li>
          );
        })}
      </ul>
    </>
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
