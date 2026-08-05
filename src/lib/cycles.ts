import 'server-only';

import { prisma } from '@/lib/db';
import { cycleAnchor, cycleNumberAt, cycleWindow } from '@/lib/cycle-math';
import { isOpen } from '@/lib/model';
import type { WorkflowStateType } from '@prisma/client';

/**
 * Cycles are materialized LAZILY, on any read of a cycles route.
 *
 * The alternative is a scheduler, which on Railway means another service to
 * deploy, watch and pay for, to write a handful of rows a fortnight. Instead the
 * cadence on the Project is the source of truth and the rows are caught up
 * whenever somebody looks. A project nobody opens has no cycle rows and loses
 * nothing by it, because the numbering is derived from the anchor rather than
 * from how many rows happen to exist.
 *
 * ponytail: this writes during a GET. It is idempotent and bounded
 * (`upcomingCycles` is capped at 12 by validation), so the cost is one
 * `createMany` that usually inserts nothing. Move it to a job if a project ever
 * gets hot enough for the write to show up in the page's latency.
 *
 * `projectId` must come from an authorized upward walk, exactly like
 * `requireStateInProject`. Nothing here re-checks membership, so passing a
 * client-supplied id would be a cross-tenant write.
 */

export type CycleRow = {
  id: string;
  number: number;
  name: string | null;
  startsAt: Date;
  endsAt: Date;
};

type Cadence = {
  createdAt: Date;
  cyclesEnabled: boolean;
  cycleWeeks: number;
  cycleStartDay: number;
  upcomingCycles: number;
};

/**
 * Bring a project's cycle rows up to date and answer which number is current.
 *
 * Returns `null` when the project has cycles switched off, which is the signal
 * for the pages to render the "cycles are disabled" state rather than an empty
 * list that looks like a bug.
 */
export async function ensureCycles(
  projectId: string,
  now: Date = new Date(),
): Promise<{ current: number; cadence: Cadence } | null> {
  const cadence = await prisma.project.findUnique({
    where: { id: projectId },
    select: {
      createdAt: true,
      cyclesEnabled: true,
      cycleWeeks: true,
      cycleStartDay: true,
      upcomingCycles: true,
    },
  });
  if (!cadence || !cadence.cyclesEnabled) return null;

  const anchor = cycleAnchor(cadence.createdAt, cadence.cycleStartDay);
  const current = cycleNumberAt(anchor, cadence.cycleWeeks, now);
  const last = current + cadence.upcomingCycles;

  const wanted = [];
  for (let number = current; number <= last; number += 1) {
    const window = cycleWindow(anchor, cadence.cycleWeeks, number);
    wanted.push({ projectId, number, startsAt: window.startsAt, endsAt: window.endsAt });
  }

  // `skipDuplicates` rather than an upsert loop: two page loads racing on the
  // same project must not turn into a unique-violation 500 for whichever lost.
  await prisma.cycle.createMany({ data: wanted, skipDuplicates: true });

  await rollForward(projectId, current, now);

  return { current, cadence };
}

/**
 * Move still-open issues out of cycles that have ended and into the current one.
 *
 * Everything ended lands in the CURRENT cycle rather than each hopping one step,
 * so a project reopened after months away converges in a single pass instead of
 * needing one page load per elapsed cycle. Completed and canceled issues stay
 * where they were -- that is what makes a past cycle's burndown still true.
 */
async function rollForward(projectId: string, current: number, now: Date): Promise<void> {
  const [target, ended, openStates] = await Promise.all([
    prisma.cycle.findFirst({
      where: { projectId, number: current },
      select: { id: true },
    }),
    prisma.cycle.findMany({
      where: { projectId, endsAt: { lte: now } },
      select: { id: true },
    }),
    prisma.workflowState.findMany({ where: { projectId }, select: { id: true, type: true } }),
  ]);

  if (!target || ended.length === 0) return;

  // `updateMany` cannot filter through a relation, so the open states are
  // resolved to ids first rather than expressed as `state: { type: ... }`.
  const openStateIds = openStates
    .filter((state) => isOpen(state.type as WorkflowStateType))
    .map((state) => state.id);
  if (openStateIds.length === 0) return;

  await prisma.ticket.updateMany({
    where: {
      projectId,
      cycleId: { in: ended.map((cycle) => cycle.id) },
      stateId: { in: openStateIds },
    },
    data: { cycleId: target.id },
  });
}

/**
 * The materialized cycles from the current one onward, current first.
 *
 * Past cycles are reachable by number but are not listed: Linear's sidebar
 * offers Current and Upcoming, and a list that grows without bound every
 * fortnight is not navigation.
 */
export async function listCycles(
  projectId: string,
  from: number,
): Promise<CycleRow[]> {
  return prisma.cycle.findMany({
    where: { projectId, number: { gte: from } },
    orderBy: { number: 'asc' },
    select: { id: true, number: true, name: true, startsAt: true, endsAt: true },
  });
}
