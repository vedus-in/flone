/**
 * Cycle date arithmetic. Pure, and deliberately import-free.
 *
 * No `server-only`, no Prisma, no path aliases -- so `scripts/check-model.ts`
 * can import it straight from Node and actually exercise it. Everything that
 * touches the database lives in `src/lib/cycles.ts` instead.
 *
 * Every instant here is UTC. A cycle boundary must not shift by an hour twice a
 * year because the server happens to sit in a country that observes DST, and
 * adding days as milliseconds is only exact in UTC.
 */

export const DAY_MS = 86_400_000;

/** ISO weekday of an instant, in UTC: 1 = Monday .. 7 = Sunday. */
export function isoWeekday(at: Date): number {
  const day = at.getUTCDay();
  return day === 0 ? 7 : day;
}

/** UTC midnight of the day an instant falls in. */
export function startOfUtcDay(at: Date): Date {
  return new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate()));
}

/**
 * Where cycle 1 begins: the first `startDay` weekday on or after `from`, at UTC
 * midnight. Derived from the project's creation date rather than stored, so
 * changing the cadence re-derives the whole series instead of leaving a stale
 * anchor nothing points at.
 */
export function cycleAnchor(from: Date, startDay: number): Date {
  const base = startOfUtcDay(from);
  const shift = (startDay - isoWeekday(base) + 7) % 7;
  return new Date(base.getTime() + shift * DAY_MS);
}

export type CycleWindow = { startsAt: Date; endsAt: Date };

/** The half-open window [startsAt, endsAt) of a 1-based cycle number. */
export function cycleWindow(anchor: Date, weeks: number, number: number): CycleWindow {
  const span = weeks * 7 * DAY_MS;
  const startsAt = new Date(anchor.getTime() + (number - 1) * span);
  return { startsAt, endsAt: new Date(startsAt.getTime() + span) };
}

/**
 * Which cycle number covers an instant. Anything before the anchor answers 1,
 * so a project whose cadence was just widened never reports cycle 0 or a
 * negative number.
 */
export function cycleNumberAt(anchor: Date, weeks: number, at: Date): number {
  const span = weeks * 7 * DAY_MS;
  const delta = at.getTime() - anchor.getTime();
  if (delta < 0) return 1;
  return Math.floor(delta / span) + 1;
}

/**
 * Fraction of a cycle elapsed at an instant, clamped to [0, 1]. Drives the
 * "ideal" line on the burndown.
 */
export function cycleProgress(window: CycleWindow, at: Date): number {
  const span = window.endsAt.getTime() - window.startsAt.getTime();
  if (span <= 0) return 1;
  const elapsed = at.getTime() - window.startsAt.getTime();
  return Math.min(1, Math.max(0, elapsed / span));
}
