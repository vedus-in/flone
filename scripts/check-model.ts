/**
 * Asserts the four things in this model that rot silently.
 *
 *   1. State TYPE -> tab and group mapping. The type is what decides which tab
 *      an issue appears under and whether it counts as done. A sixth state type
 *      added to the Prisma enum without touching `TAB_STATE_TYPES` would fall
 *      out of every tab and the issue would simply vanish from the UI.
 *
 *   2. The migration's name -> type inference. The SQL in
 *      `20260805000000_linear_project_workspace` has to duplicate
 *      `inferStateType` because it runs before any application code exists.
 *      Nothing but this check stops the two drifting.
 *
 *   3. Cycle arithmetic. Cycles are materialized lazily with
 *      `createMany({ skipDuplicates })`, which is only idempotent because
 *      `cycleNumberAt` is an exact inverse of `cycleWindow` and consecutive
 *      windows tile without gap or overlap. If that stops holding, the same
 *      sprint gets two rows and every burndown splits in half.
 *
 *   4. The Daily Challenges columns. They are state TYPES, because a board
 *      spanning projects has no state id that means the same thing twice. Every
 *      type must be admitted by exactly one column or a picked issue becomes
 *      invisible on a board it cannot be removed from, and exactly one column
 *      must write no status at all -- if Completed ever gained one, clearing a
 *      card off your own board would silently change it on everyone else's.
 *
 *   5. Reminder recurrence. The scheduler advances a reminder with the value
 *      `nextRun` returns and sends nothing else until that instant passes, so
 *      a result that is not STRICTLY in the future is a mail loop: the row
 *      stays due, and every tick sends another copy. Nothing else catches it --
 *      a duplicate email is not a failing type, a failing page or a failing
 *      query, it is just a person receiving the same nudge nine times.
 *
 * Runs on plain Node — 22 strips the types. No test framework, no fixtures:
 *
 *   node scripts/check-model.ts
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { z } from 'zod';

import {
  ISSUE_TABS,
  STATE_GROUP_RANK,
  TAB_STATE_TYPES,
  inferStateType,
  isAbandoned,
  isDone,
  isOpen,
  sortStatesForBoard,
  sortStatesForList,
  stampsFor,
} from '../src/lib/model.ts';
import {
  cycleAnchor,
  cycleNumberAt,
  cycleProgress,
  cycleWindow,
  isoWeekday,
  DAY_MS,
} from '../src/lib/cycle-math.ts';
import {
  CHALLENGE_COLUMNS,
  challengeColumn,
  columnForStateType,
  isClearingColumn,
} from '../src/lib/challenges.ts';
import {
  REPEAT_LABEL,
  formatLocalDateTime,
  formatOffset,
  formatWhen,
  nextRun,
  stepClock,
  toInstant,
  typeClockDigit,
} from '../src/lib/reminder-math.ts';

const ALL_TYPES = ['BACKLOG', 'UNSTARTED', 'STARTED', 'COMPLETED', 'CANCELED'] as const;
let checks = 0;

function ok(what: string, run: () => void) {
  run();
  checks += 1;
  console.log(`  ok  ${what}`);
}

console.log('\nstate types');

ok('every state type falls under at least one tab', () => {
  for (const type of ALL_TYPES) {
    const tabs = ISSUE_TABS.filter((tab) => TAB_STATE_TYPES[tab].includes(type));
    assert.ok(
      tabs.length > 0,
      `${type} appears in no tab, so issues in it would be invisible everywhere`,
    );
  }
});

ok('"all" really means all', () => {
  for (const type of ALL_TYPES) {
    assert.ok(TAB_STATE_TYPES.all.includes(type), `${type} missing from the All issues tab`);
  }
});

ok('active is exactly unstarted + started', () => {
  assert.deepEqual([...TAB_STATE_TYPES.active].sort(), ['STARTED', 'UNSTARTED']);
});

ok('backlog is exactly backlog', () => {
  assert.deepEqual([...TAB_STATE_TYPES.backlog], ['BACKLOG']);
});

ok('active and backlog do not overlap', () => {
  const overlap = TAB_STATE_TYPES.active.filter((type) => TAB_STATE_TYPES.backlog.includes(type));
  assert.deepEqual(overlap, [], 'an issue would appear under two tabs at once');
});

ok('the group rank is a total order over every type', () => {
  const ranks = ALL_TYPES.map((type) => STATE_GROUP_RANK[type]);
  assert.equal(new Set(ranks).size, ALL_TYPES.length, 'two types share a rank');
  for (const rank of ranks) assert.equal(typeof rank, 'number');
});

ok('work in flight sorts above the backlog in a list', () => {
  assert.ok(STATE_GROUP_RANK.STARTED < STATE_GROUP_RANK.UNSTARTED);
  assert.ok(STATE_GROUP_RANK.UNSTARTED < STATE_GROUP_RANK.BACKLOG);
  assert.ok(STATE_GROUP_RANK.BACKLOG < STATE_GROUP_RANK.COMPLETED);
});

ok('canceled is neither done nor open', () => {
  assert.equal(isDone('CANCELED'), false, 'a canceled issue must not inflate a burndown');
  assert.equal(isOpen('CANCELED'), false, 'a canceled issue must not roll into the next cycle');
  assert.equal(isAbandoned('CANCELED'), true);
});

ok('completed is done, everything else open', () => {
  assert.equal(isDone('COMPLETED'), true);
  for (const type of ['BACKLOG', 'UNSTARTED', 'STARTED'] as const) {
    assert.equal(isOpen(type), true, `${type} must count as outstanding work`);
    assert.equal(isDone(type), false);
  }
});

ok('list order and board order genuinely differ', () => {
  const states = [
    { id: 'a', name: 'Backlog', type: 'BACKLOG' as const, position: 0 },
    { id: 'b', name: 'Todo', type: 'UNSTARTED' as const, position: 1 },
    { id: 'c', name: 'In Progress', type: 'STARTED' as const, position: 2 },
    { id: 'd', name: 'Done', type: 'COMPLETED' as const, position: 3 },
  ];
  assert.deepEqual(
    sortStatesForBoard(states).map((s) => s.name),
    ['Backlog', 'Todo', 'In Progress', 'Done'],
    'a board reads left to right from the backlog',
  );
  assert.deepEqual(
    sortStatesForList(states).map((s) => s.name),
    ['In Progress', 'Todo', 'Backlog', 'Done'],
    'a list leads with what is moving',
  );
});

ok('sorting does not mutate its input', () => {
  const states = [
    { id: 'b', name: 'Todo', type: 'UNSTARTED' as const, position: 1 },
    { id: 'a', name: 'Backlog', type: 'BACKLOG' as const, position: 0 },
  ];
  sortStatesForList(states);
  assert.equal(states[0].name, 'Todo', 'sortStatesForList sorted in place');
});

/* -------------------------------------------------------------------------- */

console.log('\nlifecycle stamps');

const T0 = new Date('2026-01-01T00:00:00Z');
const NOW = new Date('2026-08-05T12:00:00Z');
const BLANK = { startedAt: null, completedAt: null };

ok('entering a COMPLETED state stamps both, once', () => {
  const first = stampsFor('COMPLETED', BLANK, NOW);
  assert.equal(first.completedAt?.getTime(), NOW.getTime());
  assert.equal(first.startedAt?.getTime(), NOW.getTime(), 'work that finishes must have started');

  // Re-entering Done must NOT move the stamp, or a burndown jumps every time
  // somebody toggles a state twice.
  const again = stampsFor('COMPLETED', { startedAt: T0, completedAt: T0 }, NOW);
  assert.equal(again.completedAt?.getTime(), T0.getTime());
  assert.equal(again.startedAt?.getTime(), T0.getTime());
});

ok('reopening into STARTED withdraws the completion', () => {
  const stamps = stampsFor('STARTED', { startedAt: T0, completedAt: T0 }, NOW);
  assert.equal(stamps.completedAt, null, 'reopened work is not complete');
  assert.equal(stamps.startedAt?.getTime(), T0.getTime(), 'the original start survives');
});

ok('cancelling keeps the start but is not a completion', () => {
  const stamps = stampsFor('CANCELED', { startedAt: T0, completedAt: T0 }, NOW);
  assert.equal(stamps.startedAt?.getTime(), T0.getTime());
  assert.equal(stamps.completedAt, null, 'a canceled issue must never read as completed');
});

ok('going back to the backlog clears both stamps', () => {
  for (const type of ['BACKLOG', 'UNSTARTED'] as const) {
    const stamps = stampsFor(type, { startedAt: T0, completedAt: T0 }, NOW);
    assert.deepEqual(stamps, BLANK, `${type} must reset the lifecycle`);
  }
});

ok('a completed issue always carries the stamp the burndown reads', () => {
  for (const type of ALL_TYPES) {
    const stamps = stampsFor(type, BLANK, NOW);
    assert.equal(
      stamps.completedAt !== null,
      isDone(type),
      `completedAt must be set exactly when isDone(${type})`,
    );
  }
});

/* -------------------------------------------------------------------------- */

console.log('\nmigration name inference');

const NAMES: Array<[string, (typeof ALL_TYPES)[number]]> = [
  ['Backlog', 'BACKLOG'],
  ['Product backlog', 'BACKLOG'],
  ['To Do', 'UNSTARTED'],
  ['todo', 'UNSTARTED'],
  ['Open', 'UNSTARTED'],
  ['Triage', 'UNSTARTED'],
  ['In Progress', 'STARTED'],
  ['In Review', 'STARTED'],
  ['Blocked', 'STARTED'],
  ['Done', 'COMPLETED'],
  ['Completed', 'COMPLETED'],
  ['Closed', 'COMPLETED'],
  ['Shipped', 'COMPLETED'],
  ['Canceled', 'CANCELED'],
  ['Cancelled', 'CANCELED'],
  ['Duplicate', 'CANCELED'],
];

ok('inferStateType maps the names the migration will meet', () => {
  for (const [name, expected] of NAMES) {
    assert.equal(inferStateType(name), expected, `"${name}" should infer ${expected}`);
  }
});

ok('an unrecognised name lands in STARTED, not hidden in a backlog', () => {
  assert.equal(inferStateType('Zzzz'), 'STARTED');
  assert.equal(inferStateType(''), 'STARTED');
});

ok('every id the migration mints survives zod .cuid()', () => {
  // Comments are stripped first: the migration's own prose explains why a bare
  // `gen_random_uuid()` is wrong, and scanning the raw text would flag that
  // explanation as the very thing it warns about.
  const sql = readFileSync(
    'prisma/migrations/20260805000000_linear_project_workspace/migration.sql',
    'utf8',
  )
    .replace(/^\s*--.*$/gm, '')
    .replace(/\/\*[\s\S]*?\*\//g, '');

  // The migration has to mint its own ids: `cuid()` is a client-side Prisma
  // default. But every Server Action validates ids with zod's `.cuid()`, so a
  // bare `gen_random_uuid()` produces rows the UI can READ and no action can
  // ever WRITE — the failure looks like a validation error on a form the user
  // never filled in. Every generator must therefore be wrapped.
  const total = [...sql.matchAll(/gen_random_uuid\(\)/g)].length;
  const wrapped = [...sql.matchAll(/'c' \|\| replace\(gen_random_uuid\(\)::text, '-', ''\)/g)].length;
  assert.ok(total > 0, 'the migration mints no ids at all — has it been rewritten?');
  assert.equal(
    wrapped,
    total,
    `${total - wrapped} raw gen_random_uuid() call(s) would produce ids no Server Action accepts`,
  );

  // And the shape that wrapper produces really does pass, checked against the
  // actual validator rather than a hand-copied regex.
  const simulated = 'c' + '0123456789abcdef0123456789abcdef';
  assert.ok(
    z.string().cuid().safeParse(simulated).success,
    'the migration id shape no longer satisfies the id validator',
  );
  assert.ok(
    !z.string().cuid().safeParse('0123456789ab-cdef').success,
    'sanity: a hyphenated uuid must still be rejected',
  );
});

ok('the migration SQL uses the same keywords', () => {
  const sql = readFileSync(
    'prisma/migrations/20260805000000_linear_project_workspace/migration.sql',
    'utf8',
  ).toLowerCase();

  // Every keyword `inferStateType` branches on must appear in the SQL's CASE,
  // or the two will classify the same column name differently.
  const keywords = [
    'backlog',
    'cancel',
    'duplicate',
    'done',
    'complete',
    'closed',
    'shipped',
    'to do',
    'todo',
    'triage',
  ];
  for (const keyword of keywords) {
    assert.ok(sql.includes(keyword), `migration SQL never mentions "${keyword}"`);
  }
});

/* -------------------------------------------------------------------------- */

console.log('\ncycle arithmetic');

const MONDAY = 1;

ok('the anchor lands on the requested weekday', () => {
  for (let day = 1; day <= 7; day += 1) {
    for (let offset = 0; offset < 14; offset += 1) {
      const from = new Date(Date.UTC(2026, 0, 1 + offset, 13, 45));
      const anchor = cycleAnchor(from, day);
      assert.equal(isoWeekday(anchor), day, `anchor for weekday ${day} landed wrong`);
      assert.ok(anchor.getTime() >= Date.UTC(2026, 0, 1 + offset), 'anchor moved backwards');
      assert.ok(
        anchor.getTime() - Date.UTC(2026, 0, 1 + offset) < 7 * DAY_MS,
        'anchor skipped a whole week ahead',
      );
    }
  }
});

ok('the anchor is UTC midnight', () => {
  const anchor = cycleAnchor(new Date('2026-08-05T23:59:59.999Z'), MONDAY);
  assert.equal(anchor.getUTCHours(), 0);
  assert.equal(anchor.getUTCMinutes(), 0);
  assert.equal(anchor.getUTCSeconds(), 0);
  assert.equal(anchor.getUTCMilliseconds(), 0);
});

ok('consecutive windows tile with no gap and no overlap', () => {
  for (const weeks of [1, 2, 3, 4, 8]) {
    const anchor = cycleAnchor(new Date('2026-01-01T00:00:00Z'), MONDAY);
    for (let n = 1; n < 40; n += 1) {
      const a = cycleWindow(anchor, weeks, n);
      const b = cycleWindow(anchor, weeks, n + 1);
      assert.equal(
        a.endsAt.getTime(),
        b.startsAt.getTime(),
        `a ${weeks}-week cycle ${n} does not meet ${n + 1}`,
      );
      assert.equal(a.endsAt.getTime() - a.startsAt.getTime(), weeks * 7 * DAY_MS);
    }
  }
});

ok('cycleNumberAt inverts cycleWindow — the idempotency invariant', () => {
  for (const weeks of [1, 2, 3, 4]) {
    const anchor = cycleAnchor(new Date('2025-03-17T00:00:00Z'), MONDAY);
    for (let n = 1; n < 60; n += 1) {
      const { startsAt, endsAt } = cycleWindow(anchor, weeks, n);
      assert.equal(cycleNumberAt(anchor, weeks, startsAt), n, `start of cycle ${n} resolved wrong`);
      // The window is half-open, so the last instant inside it is still cycle n
      // and the first instant of the next is n+1. Getting this off by one is how
      // a project ends up with two rows for the same fortnight.
      assert.equal(cycleNumberAt(anchor, weeks, new Date(endsAt.getTime() - 1)), n);
      assert.equal(cycleNumberAt(anchor, weeks, endsAt), n + 1);
    }
  }
});

ok('anything before the anchor is cycle 1, never 0 or negative', () => {
  const anchor = cycleAnchor(new Date('2026-06-01T00:00:00Z'), MONDAY);
  assert.equal(cycleNumberAt(anchor, 2, new Date('2020-01-01T00:00:00Z')), 1);
  assert.equal(cycleNumberAt(anchor, 2, new Date(anchor.getTime() - 1)), 1);
});

ok('a cycle spanning a DST changeover is still exactly N days', () => {
  // Europe/London springs forward on 2026-03-29. In UTC that must not matter --
  // which is the entire reason this arithmetic is UTC-only.
  const anchor = cycleAnchor(new Date('2026-03-23T00:00:00Z'), MONDAY);
  const window = cycleWindow(anchor, 2, 1);
  assert.equal((window.endsAt.getTime() - window.startsAt.getTime()) / DAY_MS, 14);
});

ok('progress is clamped to [0, 1]', () => {
  const window = { startsAt: new Date('2026-08-03T00:00:00Z'), endsAt: new Date('2026-08-17T00:00:00Z') };
  assert.equal(cycleProgress(window, new Date('2026-07-01T00:00:00Z')), 0);
  assert.equal(cycleProgress(window, new Date('2026-08-10T00:00:00Z')), 0.5);
  assert.equal(cycleProgress(window, new Date('2027-01-01T00:00:00Z')), 1);
});

ok('a zero-length window reports complete rather than dividing by zero', () => {
  const instant = new Date('2026-08-03T00:00:00Z');
  assert.equal(cycleProgress({ startsAt: instant, endsAt: instant }, instant), 1);
});

console.log('\ndaily challenges');

ok('every state type is admitted by exactly one column', () => {
  // The invariant the whole board rests on. A type admitted by NO column would
  // strand a picked issue -- invisible, and so impossible to clear -- and a type
  // admitted by two would make the same card appear twice.
  for (const type of ALL_TYPES) {
    const admitting = CHALLENGE_COLUMNS.filter((column) => column.admits.includes(type));
    assert.equal(admitting.length, 1, `${type} is admitted by ${admitting.length} columns`);
    assert.equal(columnForStateType(type), admitting[0].id);
  }
});

ok('exactly one column writes no status, and it is Completed', () => {
  // If Completed ever gained a `sets`, dropping a card there would silently
  // change the issue on its own project's board -- the one thing this feature
  // promises it will not do.
  const clearing = CHALLENGE_COLUMNS.filter(isClearingColumn);
  assert.equal(clearing.length, 1);
  assert.equal(clearing[0].id, 'completed');
  assert.deepEqual(clearing[0].admits, []);
});

ok('a column that sets a type also admits it, so a card lands where it was dropped', () => {
  for (const column of CHALLENGE_COLUMNS) {
    if (column.sets === null) continue;
    assert.ok(
      column.admits.includes(column.sets),
      `${column.id} writes ${column.sets} but does not show it`,
    );
  }
});

ok('the status a column writes is a real state type', () => {
  for (const column of CHALLENGE_COLUMNS) {
    if (column.sets === null) continue;
    assert.ok((ALL_TYPES as readonly string[]).includes(column.sets));
  }
});

ok('challengeColumn accepts every id and rejects anything else', () => {
  for (const column of CHALLENGE_COLUMNS) {
    assert.equal(challengeColumn(column.id)?.id, column.id);
  }
  // A forged column id from the drop handler must not resolve to a real column.
  assert.equal(challengeColumn('COMPLETED'), null);
  assert.equal(challengeColumn(''), null);
  assert.equal(challengeColumn('__proto__'), null);
});

console.log('\nreminders');

const NINE_AM = new Date('2026-08-12T07:00:00Z'); // 09:00 in Berlin summer time.
const BERLIN_SUMMER = -120;

ok('a one-time reminder has no next run', () => {
  // Null is what ends it. Anything else and it would send forever.
  assert.equal(nextRun(NINE_AM, 'ONCE', NINE_AM), null);
});

ok('a daily reminder that fired on time moves exactly one day', () => {
  const next = nextRun(NINE_AM, 'DAILY', NINE_AM);
  assert.equal(next?.toISOString(), '2026-08-13T07:00:00.000Z');
});

ok('a weekly reminder moves exactly seven days', () => {
  const next = nextRun(NINE_AM, 'WEEKLY', NINE_AM);
  assert.equal(next?.toISOString(), '2026-08-19T07:00:00.000Z');
});

ok('the wall-clock time survives every recurrence', () => {
  // The whole point of adding whole days in UTC: 09:00 stays 09:00 rather than
  // drifting by the minutes a month-based calculation would introduce.
  let at: Date | null = NINE_AM;
  for (let i = 0; i < 400 && at; i += 1) {
    assert.ok(formatWhen(at, BERLIN_SUMMER).endsWith('09:00 (UTC+02:00)'), at.toISOString());
    at = nextRun(at, 'DAILY', at);
  }
});

ok('a scheduler that was down for days sends once, not once per missed day', () => {
  // Three days late. The next run must be tomorrow, not three sends today --
  // and above all it must not still be in the past, or the next tick sends
  // again, and the one after that, until the backlog is exhausted at one email
  // per tick.
  const now = new Date('2026-08-15T07:30:00Z');
  const next = nextRun(NINE_AM, 'DAILY', now);
  assert.equal(next?.toISOString(), '2026-08-16T07:00:00.000Z');
  assert.ok(next!.getTime() > now.getTime(), 'the reminder would fire again immediately');
});

ok('the next run is strictly in the future however far behind the tick is', () => {
  const from = new Date('2026-01-01T09:00:00Z');
  for (const days of [0, 0.5, 1, 6.9, 7, 30, 365]) {
    for (const repeat of ['DAILY', 'WEEKLY'] as const) {
      const now = new Date(from.getTime() + days * 86_400_000);
      const next = nextRun(from, repeat, now);
      assert.ok(next!.getTime() > now.getTime(), `${repeat} +${days}d landed in the past`);
    }
  }
});

ok('a form value round-trips through the stored instant', () => {
  // What the user typed is what the email says, from a server in any timezone.
  const instant = toInstant('2026-08-12T09:00', BERLIN_SUMMER);
  assert.equal(instant?.toISOString(), '2026-08-12T07:00:00.000Z');
  assert.equal(formatWhen(instant!, BERLIN_SUMMER), 'Wed 12 Aug, 09:00 (UTC+02:00)');
});

ok('UTC and the far side of the date line both round-trip', () => {
  assert.equal(toInstant('2026-08-12T09:00', 0)?.toISOString(), '2026-08-12T09:00:00.000Z');
  // Chatham Islands: +12:45, and the only common offset that is not a whole hour.
  const chatham = -765;
  const instant = toInstant('2026-08-12T09:00', chatham);
  assert.equal(instant?.toISOString(), '2026-08-11T20:15:00.000Z');
  assert.equal(formatWhen(instant!, chatham), 'Wed 12 Aug, 09:00 (UTC+12:45)');
  assert.equal(formatOffset(0), 'UTC+00:00');
  assert.equal(formatOffset(300), 'UTC-05:00');
});

ok('an impossible date is rejected rather than rolled forward', () => {
  // `Date.UTC` turns 31 February into 3 March without complaint, which would
  // schedule a reminder for a day the user did not pick.
  assert.equal(toInstant('2026-02-31T09:00', 0), null);
  assert.equal(toInstant('2026-13-01T09:00', 0), null);
  assert.equal(toInstant('2026-08-12T25:00', 0), null);
  assert.equal(toInstant('2026-08-12', 0), null);
  assert.equal(toInstant('', 0), null);
  assert.equal(toInstant('2026-08-12T09:00:00', 0), null);
});

ok('every repeat has a label, so no email says undefined', () => {
  for (const repeat of ['ONCE', 'DAILY', 'WEEKLY'] as const) {
    assert.equal(typeof REPEAT_LABEL[repeat], 'string');
    assert.ok(REPEAT_LABEL[repeat].length > 0);
  }
});

console.log('\nreminder clock boxes');

ok('arrows wrap at both ends of both units', () => {
  // Wrapping is what makes a time near midnight reachable without 23 presses.
  assert.equal(stepClock(23, 1, 23), 0);
  assert.equal(stepClock(0, -1, 23), 23);
  assert.equal(stepClock(59, 1, 59), 0);
  assert.equal(stepClock(0, -1, 59), 59);
  assert.equal(stepClock(8, 1, 23), 9);
  assert.equal(stepClock(9, -1, 23), 8);
});

ok('typing builds the pair left to right', () => {
  // "1" then "4" is 14 -- not 1, and not 41.
  const first = typeClockDigit(0, 1, false, 23);
  assert.equal(first, 1);
  assert.equal(typeClockDigit(first, 4, true, 23), 14);
});

ok('typing clamps where the arrows wrap', () => {
  // "5" then "9" in the hours box is the latest legal hour, NOT 23:00 + 36h and
  // not a wrap round to 11. Getting this wrong sends the reminder on the wrong
  // day, which nothing downstream would flag.
  const started = typeClockDigit(0, 5, false, 23);
  assert.equal(started, 5);
  assert.equal(typeClockDigit(started, 9, true, 23), 23);
  // The same pair is perfectly legal in minutes.
  assert.equal(typeClockDigit(typeClockDigit(0, 5, false, 59), 9, true, 59), 59);
  // A lone first digit above the max is clamped too: "9" in hours is 9, but a
  // second "9" cannot take it to 99.
  assert.equal(typeClockDigit(9, 9, true, 23), 23);
});

ok('every reachable value stays inside its unit', () => {
  for (const max of [23, 59]) {
    for (let current = 0; current <= max; current += 1) {
      for (let digit = 0; digit <= 9; digit += 1) {
        for (const continuing of [true, false]) {
          const next = typeClockDigit(current, digit, continuing, max);
          assert.ok(
            Number.isInteger(next) && next >= 0 && next <= max,
            `typing ${digit} on ${current} (max ${max}) produced ${next}`,
          );
        }
      }
      for (const by of [1, -1]) {
        const next = stepClock(current, by, max);
        assert.ok(next >= 0 && next <= max, `stepping ${current} by ${by} produced ${next}`);
      }
    }
  }
});

ok('what the field submits is exactly what the action parses', () => {
  // The round trip that keeps the picker and `localDateTimeSchema` honest: the
  // schema rejects the seconds that CalendarDateTime.toString() would append,
  // so a drift here is a form that cannot be submitted at all.
  const parts = { year: 2026, month: 8, day: 12, hour: 9, minute: 5 };
  const submitted = formatLocalDateTime(parts);
  assert.equal(submitted, '2026-08-12T09:05');
  assert.ok(toInstant(submitted, 0) !== null, 'the action would reject its own form value');
  assert.equal(toInstant(submitted, 0)?.toISOString(), '2026-08-12T09:05:00.000Z');
  // Single digits pad, and a year below 1000 still fills four columns.
  assert.equal(
    formatLocalDateTime({ year: 999, month: 1, day: 2, hour: 3, minute: 4 }),
    '0999-01-02T03:04',
  );
});

console.log(`\nAll good — ${checks} checks.\n`);
