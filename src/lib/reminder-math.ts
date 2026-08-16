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

import type { ReminderChannel, ReminderRepeat, TicketRepeat } from '@prisma/client';

const MINUTE_MS = 60_000;
const DAY_MS = 86_400_000;

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

export const CHANNEL_LABEL: Record<ReminderChannel, string> = {
  EMAIL: 'Email',
  CALL: 'Phone call',
  BOTH: 'Email and call',
};

/** Total `Record`s again, so a new enum value is a type error, not a silent skip. */
export const CHANNEL_EMAILS: Record<ReminderChannel, boolean> = {
  EMAIL: true,
  CALL: false,
  BOTH: true,
};

export const CHANNEL_CALLS: Record<ReminderChannel, boolean> = {
  EMAIL: false,
  CALL: true,
  BOTH: true,
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

/* -------------------------------------------------------------------------- */
/* Clock-box arithmetic (the "First send" hours and minutes boxes)             */
/*                                                                             */
/* Lives here rather than in the component so it can be asserted from Node --  */
/* it is fiddly, and every way it can go wrong is silent: a reminder set for a */
/* time nobody chose still sends perfectly happily.                            */
/* -------------------------------------------------------------------------- */

const pad2 = (value: number) => String(value).padStart(2, '0');

/**
 * One press of an arrow key. WRAPS, so holding Up on the hours box runs 23 -> 00
 * rather than sticking, which is what makes it usable for a time near midnight.
 */
export function stepClock(current: number, by: number, max: number): number {
  const next = current + by;
  if (next > max) return 0;
  if (next < 0) return max;
  return next;
}

/**
 * One digit typed into a two-digit box.
 *
 * `continuing` is true when this is the second digit of a pair, in which case it
 * joins the first; otherwise it starts over. Typing CLAMPS where the arrows
 * wrap: `5` then `9` in the hours box is 23, not an hour later. That asymmetry
 * is deliberate and is the behaviour of openstatusHQ/time-picker, which the
 * field follows.
 */
export function typeClockDigit(
  current: number,
  digit: number,
  continuing: boolean,
  max: number,
): number {
  if (!continuing) return Math.min(digit, max);
  return Math.min(Number(pad2(current).slice(1) + String(digit)), max);
}

/**
 * The `YYYY-MM-DDTHH:mm` the form submits, from anything carrying the five
 * parts -- `CalendarDateTime` satisfies this structurally, which is what keeps
 * this module free of a runtime dependency on `@internationalized/date`.
 *
 * Exactly the inverse of `toInstant`'s parsing, and asserted to round-trip.
 * `CalendarDateTime.toString()` is NOT usable here: it appends seconds, which
 * `localDateTimeSchema` deliberately rejects.
 */
export function formatLocalDateTime(parts: {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
}): string {
  return `${String(parts.year).padStart(4, '0')}-${pad2(parts.month)}-${pad2(parts.day)}T${pad2(parts.hour)}:${pad2(parts.minute)}`;
}

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

/** Back from a shifted wall clock to the real instant. Inverse of `wallClock`. */
function fromWallClock(wall: Date, tzOffsetMinutes: number): Date {
  return new Date(wall.getTime() + tzOffsetMinutes * MINUTE_MS);
}

/* -------------------------------------------------------------------------- */
/* Recurring tickets                                                           */
/*                                                                             */
/* A second cadence vocabulary, for `RecurringTicket` rather than `Reminder`.  */
/* Everything below computes an occurrence from the template's IMMUTABLE       */
/* anchor, never from the previous occurrence -- see `nextOccurrence` for what  */
/* that buys and what breaks without it.                                       */
/* -------------------------------------------------------------------------- */

export const TICKET_REPEAT_LABEL: Record<TicketRepeat, string> = {
  DAILY: 'Every day',
  WEEKDAYS: 'Every weekday',
  WEEKLY: 'Every week',
  MONTHLY: 'Every month',
};

/**
 * Saturday or Sunday ON THE TEMPLATE'S OWN CLOCK.
 *
 * The shift is not cosmetic here. A Monday 08:00 Tokyo spawn is Sunday 23:00 in
 * UTC, so testing the raw instant would skip every Monday and happily spawn
 * every Sunday -- a bug nobody would see until a template crossed the date
 * line.
 */
function isWeekend(instant: Date, tzOffsetMinutes: number): boolean {
  const day = wallClock(instant, tzOffsetMinutes).getUTCDay();
  return day === 0 || day === 6;
}

/**
 * The same instant, moved forward to Monday if it lands on a weekend.
 *
 * At most two steps by construction (Saturday -> Sunday -> Monday), so this is
 * a bounded roll and not a search. Used twice: once by the create action, so a
 * WEEKDAYS template whose first run was picked on a Saturday starts on the
 * Monday rather than silently skipping its first occurrence, and once per
 * spawn inside `nextOccurrence`.
 */
export function rollToWeekday(instant: Date, tzOffsetMinutes: number): Date {
  let out = instant;
  for (let step = 0; step < 2 && isWeekend(out, tzOffsetMinutes); step += 1) {
    out = new Date(out.getTime() + DAY_MS);
  }
  return out;
}

/** Whole fixed-length periods on from the anchor, always strictly after `after`. */
function afterAnchor(anchorAt: Date, stepMs: number, after: Date): Date {
  const elapsed = after.getTime() - anchorAt.getTime();
  // A negative elapsed means the anchor is itself still ahead of `after` -- a
  // resumed template whose anchor was moved forward. Period 0 is then the
  // answer, and clamping to 1 here would silently skip it.
  const periods = Math.max(0, Math.floor(elapsed / stepMs) + 1);
  return new Date(anchorAt.getTime() + periods * stepMs);
}

/**
 * The `k`th monthly occurrence, on the template's wall clock.
 *
 * The day is CLAMPED to the target month's length, so a template anchored on
 * the 31st resolves to the 28th in a non-leap February. The clamp applies to
 * this occurrence only and never feeds the next one, which is the entire reason
 * every occurrence is computed from the anchor: chaining would turn one
 * February into a permanent move to the 28th.
 */
function monthlyWall(anchorWall: Date, k: number): Date {
  const months = anchorWall.getUTCMonth() + k;
  const year = anchorWall.getUTCFullYear() + Math.floor(months / 12);
  const month = ((months % 12) + 12) % 12;
  // Day 0 of the following month is the last day of this one.
  const lastDay = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  return new Date(
    Date.UTC(
      year,
      month,
      Math.min(anchorWall.getUTCDate(), lastDay),
      anchorWall.getUTCHours(),
      anchorWall.getUTCMinutes(),
    ),
  );
}

/**
 * When a recurring ticket next spawns, given the occurrence that just fired.
 *
 * ALWAYS STRICTLY AFTER `after`, and computed from `anchorAt` rather than from
 * the previous occurrence. Both properties are load-bearing and both are
 * asserted in `scripts/check-model.ts`:
 *
 *   - Not strictly after would be a spawn loop. The row stays due, and every
 *     tick creates another copy of the same ticket -- the board fills up with
 *     duplicates of the one thing somebody actually has to do.
 *   - Anchored rather than chained is what makes MONTHLY correct: the 31st runs
 *     Jan 31 -> Feb 28 -> Mar 31, where chaining would clamp once in February
 *     and never come back.
 *
 * Missed occurrences are SKIPPED, not replayed, exactly as `nextRun` skips
 * missed reminders. A scheduler down for a week spawns one ticket per template
 * rather than seven: six stale review tickets are noise that buries the one
 * that matters, and the work they stand for did not happen anyway.
 */
export function nextOccurrence(
  anchorAt: Date,
  repeat: TicketRepeat,
  after: Date,
  tzOffsetMinutes: number,
): Date {
  if (repeat === 'MONTHLY') {
    const anchorWall = wallClock(anchorAt, tzOffsetMinutes);
    const afterWall = wallClock(after, tzOffsetMinutes);

    // Whole calendar months between the two, which is a LOWER BOUND on the
    // answer: occurrence k-1 falls in the month before `after`'s, so it cannot
    // be later than `after`. Starting there makes the loop below run once or
    // twice whatever the gap, so a template unfired for a year costs the same
    // as one unfired for a minute.
    let k =
      (afterWall.getUTCFullYear() - anchorWall.getUTCFullYear()) * 12 +
      (afterWall.getUTCMonth() - anchorWall.getUTCMonth());
    if (k < 0) k = 0;
    while (monthlyWall(anchorWall, k).getTime() <= afterWall.getTime()) k += 1;

    return fromWallClock(monthlyWall(anchorWall, k), tzOffsetMinutes);
  }

  if (repeat === 'WEEKLY') return afterAnchor(anchorAt, 7 * DAY_MS, after);

  // DAILY and WEEKDAYS share the daily step; WEEKDAYS then rolls off the
  // weekend. The roll only ever moves forward, so the result stays strictly
  // after `after`.
  const daily = afterAnchor(anchorAt, DAY_MS, after);
  return repeat === 'WEEKDAYS' ? rollToWeekday(daily, tzOffsetMinutes) : daily;
}

/**
 * `16 Aug 2026` -- the date stamped onto every spawned ticket's title.
 *
 * Fixed locale and UTC-formatted on an already-shifted instant, the same rule
 * every other formatter here follows, so the title a cron process in another
 * country writes is the date the person who set the template would have named.
 */
const DATE_STAMP = new Intl.DateTimeFormat('en-GB', {
  day: 'numeric',
  month: 'short',
  year: 'numeric',
  timeZone: 'UTC',
});

export function formatDateStamp(instant: Date, tzOffsetMinutes: number): string {
  return DATE_STAMP.format(wallClock(instant, tzOffsetMinutes));
}

/**
 * The spawned ticket's due date: midnight UTC on the occurrence's own day.
 *
 * UTC midnight is the convention `isoDateSchema` and every other due date in
 * the app already stores, so a spawned ticket sorts and renders beside a
 * hand-filed one instead of an hour off it.
 */
export function dueDateFor(instant: Date, tzOffsetMinutes: number): Date {
  const wall = wallClock(instant, tzOffsetMinutes);
  return new Date(Date.UTC(wall.getUTCFullYear(), wall.getUTCMonth(), wall.getUTCDate()));
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

/* -------------------------------------------------------------------------- */
/* Speech                                                                      */
/*                                                                             */
/* What a phone call actually says. Pure and here rather than in `voice.ts` so  */
/* `scripts/check-model.ts` can assert it from plain Node -- the wording is the */
/* entire user-visible product of a call, and every way it can go wrong is      */
/* silent to everyone except the person whose phone just rang.                  */
/* -------------------------------------------------------------------------- */

/**
 * Collapses whitespace and guarantees a sentence ends in a full stop.
 *
 * The full stop is not punctuation, it is TIMING: Amazon Polly pauses at one,
 * and without it two clauses run together into a single unintelligible breath.
 * Newlines in a title would otherwise be read as nothing at all.
 */
function sentence(text: string): string {
  const clean = text.replace(/\s+/g, ' ').trim();
  if (!clean) return '';
  return /[.!?]$/.test(clean) ? clean : `${clean}.`;
}

/**
 * The script for a reminder call.
 *
 * THE TITLE IS SPOKEN TWICE, with the second pass introduced by "Again". The
 * first second or so of a Twilio call is routinely clipped by the carrier while
 * the audio path settles, so a message that opens with the important part
 * reliably loses it. The preamble is there to be sacrificed; the repeat is there
 * because a person who missed it has no way to ask.
 */
export function speechFor(input: {
  title: string;
  /** Project or organization name -- the reason the nudge exists. */
  scope: string;
  /** Null when the recipient scheduled it themselves, which drops the clause. */
  setBy: string | null;
}): string {
  return [
    'Hello. This is a reminder from Flone.',
    `Your reminder is. ${sentence(input.title)}`,
    sentence(`This is about ${input.scope}`),
    input.setBy ? sentence(`It was scheduled for you by ${input.setBy}`) : '',
    `Again. ${sentence(input.title)}`,
    'Goodbye.',
  ]
    .filter(Boolean)
    .join(' ');
}

/**
 * A verification code, read one digit at a time.
 *
 * `123456` spoken as a number is "one hundred twenty-three thousand four hundred
 * fifty-six", which nobody can type. The full stops force a pause between
 * digits, and the code is repeated for the same reason a reminder's title is.
 */
export function speechForCode(code: string): string {
  const digits = code.split('').join('. ');
  return `Hello. This is Flone with your phone verification code. ${digits}. Again. ${digits}. Goodbye.`;
}
