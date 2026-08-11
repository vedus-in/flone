/**
 * Reminder scheduling arithmetic. Pure, and deliberately import-free.
 *
 * No `server-only`, no Prisma runtime import, no path aliases -- same contract
 * as `cycle-math.ts`, and for the same reason: `scripts/check-model.ts` imports
 * it straight from Node and actually exercises it. Everything that touches the
 * database lives in `src/lib/reminders.ts` instead.
 *
 * Every stored instant is UTC. A reminder's wall-clock time is reconstructed
 * from `tzOffsetMinutes`, captured from the recipient's browser when the
 * reminder was created, so a message composed by a cron tick on a server in
 * another country still says the time the person actually chose.
 *
 * ponytail: the offset is a snapshot, not a zone. A daily reminder created in
 * summer keeps summer's offset, so it shifts by an hour when the clocks change.
 * Store the IANA zone (`Intl.DateTimeFormat().resolvedOptions().timeZone`) and
 * recompute the local wall time per occurrence if that hour ever matters.
 */

import type { ReminderRepeat } from '@prisma/client';

const MINUTE_MS = 60_000;

/**
 * How far apart two sends are. `ONCE` is zero, which is what makes it the
 * terminal case in `nextRun` rather than a branch anyone has to remember.
 *
 * Typed as a total `Record`, so adding a value to the Prisma enum without a
 * cadence here is a type error rather than a reminder that silently stops.
 */
const STEP_MS: Record<ReminderRepeat, number> = {
  ONCE: 0,
  DAILY: 86_400_000,
  WEEKLY: 7 * 86_400_000,
};

export const REPEAT_LABEL: Record<ReminderRepeat, string> = {
  ONCE: 'Once',
  DAILY: 'Every day',
  WEEKLY: 'Every week',
};

/* -------------------------------------------------------------------------- */
/* Recurrence                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * The next send after the one that just went out, or null when there is none.
 *
 * `after` is normally "now", and the result is ALWAYS strictly greater than it.
 * That is the whole no-duplicates guarantee: a reminder whose next run is still
 * in the past would be picked up again by the very next tick, so a scheduler
 * that had been down for three days would send three copies of a daily reminder
 * in three minutes. Skipping straight past the missed occurrences sends exactly
 * one -- a reminder is a nudge, and four stale nudges are worse than one late.
 *
 * Computed rather than looped: `k` is the number of whole periods that have
 * elapsed, so a reminder left unfired for a year costs the same one multiply as
 * one left unfired for a minute.
 */
export function nextRun(from: Date, repeat: ReminderRepeat, after: Date): Date | null {
  const step = STEP_MS[repeat];
  if (step === 0) return null;

  const elapsed = after.getTime() - from.getTime();
  const periods = Math.max(1, Math.floor(elapsed / step) + 1);
  return new Date(from.getTime() + periods * step);
}

/* -------------------------------------------------------------------------- */
/* Local time <-> stored instant                                               */
/*                                                                             */
/* `tzOffsetMinutes` is exactly what `Date.prototype.getTimezoneOffset()`       */
/* returns: UTC MINUS local, in minutes. Berlin in summer is -120. So           */
/*                                                                             */
/*     instant = wall clock + offset          (09:00 Berlin -> 07:00Z)         */
/*     wall clock = instant - offset                                           */
/*                                                                             */
/* Storing the offset rather than the zone is what lets the cron process, the   */
/* server-rendered page and the email all agree on one string without a         */
/* timezone database.                                                          */
/* -------------------------------------------------------------------------- */

/** The bound the form and the schema both enforce: real offsets are within +-14h. */
export const MAX_TZ_OFFSET_MINUTES = 840;

/**
 * `YYYY-MM-DDTHH:mm` from an `<input type="datetime-local">` to a UTC instant.
 *
 * Returns null for anything that is not a real date and time, including the
 * well-formed impossibilities -- `2026-02-31T09:00` -- that `Date.UTC` would
 * otherwise roll silently forward into March.
 */
export function toInstant(local: string, tzOffsetMinutes: number): Date | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(local);
  if (!match) return null;

  const [year, month, day, hour, minute] = match.slice(1).map(Number);
  const wall = new Date(Date.UTC(year, month - 1, day, hour, minute));
  if (Number.isNaN(wall.getTime())) return null;

  const rolled =
    wall.getUTCFullYear() !== year ||
    wall.getUTCMonth() !== month - 1 ||
    wall.getUTCDate() !== day ||
    wall.getUTCHours() !== hour ||
    wall.getUTCMinutes() !== minute;
  if (rolled) return null;

  return new Date(wall.getTime() + tzOffsetMinutes * MINUTE_MS);
}

/** The inverse: the instant shifted so UTC getters read the recipient's clock. */
function wallClock(instant: Date, tzOffsetMinutes: number): Date {
  return new Date(instant.getTime() - tzOffsetMinutes * MINUTE_MS);
}

/**
 * Fixed locale, and formatted in UTC on an already-shifted instant -- so the
 * server, the cron process and the browser hydrating the markup cannot disagree
 * about what a reminder says. Same rule as `formatDay` in `src/lib/issues.ts`.
 */
const WHEN = new Intl.DateTimeFormat('en-GB', {
  weekday: 'short',
  day: 'numeric',
  month: 'short',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
  timeZone: 'UTC',
});

/** e.g. `Wed 12 Aug, 09:00`. */
export function formatLocal(instant: Date, tzOffsetMinutes: number): string {
  return WHEN.format(wallClock(instant, tzOffsetMinutes));
}

/** e.g. `UTC+02:00`. Rendered beside every time, because a bare 09:00 is a guess. */
export function formatOffset(tzOffsetMinutes: number): string {
  // The sign flips: getTimezoneOffset() is UTC minus local, the label is not.
  const minutes = -tzOffsetMinutes;
  const sign = minutes < 0 ? '-' : '+';
  const abs = Math.abs(minutes);
  const hh = String(Math.floor(abs / 60)).padStart(2, '0');
  const mm = String(abs % 60).padStart(2, '0');
  return `UTC${sign}${hh}:${mm}`;
}

/** The two together, which is how every surface actually shows a time. */
export function formatWhen(instant: Date, tzOffsetMinutes: number): string {
  return `${formatLocal(instant, tzOffsetMinutes)} (${formatOffset(tzOffsetMinutes)})`;
}
