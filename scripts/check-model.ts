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
 *   6. Recurring ticket occurrence arithmetic. The tick advances a template
 *      with the value `nextOccurrence` returns, exactly as reminders do with
 *      `nextRun`, so a result that is not STRICTLY after `after` is the same
 *      failure mode with a different face: the row stays due and every tick
 *      spawns another copy of the same ticket onto the board. MONTHLY adds a
 *      second way to fail silently -- every occurrence must be derived from
 *      the immutable anchor, never the previous occurrence, or a template
 *      anchored past the 28th clamps once in February and never lets go, a
 *      bug invisible until the second month after the first short one.
 *      WEEKDAYS must roll on the template's OWN wall clock, not the server's,
 *      or a template on the far side of the date line spawns on the wrong
 *      days with nothing in the UI able to tell you. None of this fails a
 *      type, a page or a query -- it is a board quietly growing duplicate
 *      tickets, or a review nobody notices went missing.
 *
 *   7. Project visibility. `visibleProject` in `src/lib/authz.ts` is the ONE
 *      predicate deciding who may see a project, and it works by being in every
 *      project-rooted `where`. A new loader that spells the old organization
 *      membership check out by hand instead compiles, type-checks, renders, and
 *      quietly serves private projects to the whole organization -- nothing
 *      fails, because a read returning MORE rows than it should looks exactly
 *      like a read that works. So the check is textual: the old hand-written
 *      shape must not reappear outside `authz.ts`, and the caller's scope must
 *      keep being spread FIRST inside the predicate, or an `organization`
 *      clause passed in silently overwrites the membership one.
 *
 * Runs on plain Node — 22 strips the types. No test framework, no fixtures:
 *
 *   node scripts/check-model.ts
 */

import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
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
  positionWrites,
  columnForStateType,
  isClearingColumn,
} from '../src/lib/challenges.ts';
import {
  CHANNEL_CALLS,
  CHANNEL_EMAILS,
  CHANNEL_LABEL,
  MAX_TZ_OFFSET_MINUTES,
  REPEAT_LABEL,
  TICKET_REPEAT_LABEL,
  dueDateFor,
  formatDateStamp,
  formatLocalDateTime,
  formatOffset,
  formatWhen,
  nextOccurrence,
  nextRun,
  rollToWeekday,
  speechFor,
  speechForCode,
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

ok('a reorder numbers by arrangement and writes in id order', () => {
  const writes = positionWrites(['c', 'a', 'b']);
  // Locked ascending by id, so two boards open at once cannot deadlock...
  assert.deepEqual(
    writes.map((write) => write.ticketId),
    ['a', 'b', 'c'],
  );
  // ...while each card keeps the number its place on the board gave it. Sorting
  // before numbering instead would silently alphabetize everyone's board.
  assert.deepEqual(
    writes.map((write) => `${write.ticketId}=${write.position}`),
    ['a=1', 'b=2', 'c=0'],
  );
  assert.deepEqual(positionWrites([]), []);
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

/* -------------------------------------------------------------------------- */
/* 7. Reminder channels and what a call actually says                          */
/*                                                                             */
/* A phone call has no scrollback. If the wording is wrong the recipient hears  */
/* it once, at whatever hour they asked to be reminded, and has no way to look  */
/* at it again -- so the script is asserted here rather than trusted.           */
/* -------------------------------------------------------------------------- */

console.log('\nreminder channels');

const CHANNELS = ['EMAIL', 'CALL', 'BOTH'] as const;

ok('every channel has a label and a delivery rule', () => {
  for (const channel of CHANNELS) {
    assert.ok(CHANNEL_LABEL[channel], `${channel} has no label`);
    assert.equal(typeof CHANNEL_EMAILS[channel], 'boolean');
    assert.equal(typeof CHANNEL_CALLS[channel], 'boolean');
  }
});

ok('no channel delivers nothing', () => {
  // A channel that neither emails nor calls would be claimed by the scheduler,
  // advanced, and silently dropped on every occurrence forever.
  for (const channel of CHANNELS) {
    assert.ok(
      CHANNEL_EMAILS[channel] || CHANNEL_CALLS[channel],
      `${channel} reaches nobody`,
    );
  }
});

ok('the channels do what their names say', () => {
  assert.deepEqual([CHANNEL_EMAILS.EMAIL, CHANNEL_CALLS.EMAIL], [true, false]);
  assert.deepEqual([CHANNEL_EMAILS.CALL, CHANNEL_CALLS.CALL], [false, true]);
  assert.deepEqual([CHANNEL_EMAILS.BOTH, CHANNEL_CALLS.BOTH], [true, true]);
});

console.log('\nreminder speech');

ok('the title is spoken twice, and never first', () => {
  const say = speechFor({ title: 'Post the deploy notes', scope: 'Engineering', setBy: null });

  // Twilio and the carrier routinely clip the opening moment of a call. A
  // script that leads with the important part reliably loses it, and the
  // recipient cannot ask for a replay.
  assert.ok(!say.startsWith('Post the deploy notes'), 'the title is exposed to the clip');
  assert.equal(say.match(/Post the deploy notes/g)?.length, 2, 'the title is not repeated');
  assert.ok(say.includes('Again.'), 'the repeat is not announced');
});

ok('a self-scheduled reminder drops the "scheduled by" clause', () => {
  const own = speechFor({ title: 'Water the plants', scope: 'Acme', setBy: null });
  const theirs = speechFor({ title: 'Water the plants', scope: 'Acme', setBy: 'Sam' });

  assert.ok(!own.includes('scheduled for you by'));
  assert.ok(theirs.includes('scheduled for you by Sam.'));
});

ok('every clause ends in a full stop, because Polly pauses at one', () => {
  // Without the stops the clauses run together into one unintelligible breath.
  const say = speechFor({ title: 'Ship it', scope: 'Acme', setBy: 'Sam' });
  for (const clause of say.split(' ').join(' ').split('. ')) {
    assert.ok(clause.trim().length > 0, 'an empty clause reached the script');
  }
  assert.ok(say.endsWith('Goodbye.'));
});

ok('a title with newlines or runs of space is flattened', () => {
  const say = speechFor({ title: 'Line one\n\n   Line two', scope: 'Acme', setBy: null });
  assert.ok(!say.includes('\n'), 'a newline reached the spoken text');
  assert.ok(!say.includes('  '), 'a double space reached the spoken text');
  assert.ok(say.includes('Line one Line two.'));
});

ok('a title that already ends in punctuation gains no second stop', () => {
  const say = speechFor({ title: 'Are we shipping?', scope: 'Acme', setBy: null });
  assert.ok(!say.includes('?.'), 'punctuation was doubled');
});

ok('the whole script fits the voice service bound', () => {
  // `services/voice` rejects anything over 1000 characters, and a rejected call
  // is a reminder that never rings. 200 is the schema cap on a title.
  const say = speechFor({
    title: 'x'.repeat(200),
    scope: 'y'.repeat(80),
    setBy: 'z'.repeat(80),
  });
  assert.ok(say.length <= 1000, `the longest possible script is ${say.length} characters`);
});

ok('a verification code is read one digit at a time, twice', () => {
  const say = speechForCode('102345');

  // "102345" spoken as a number is "one hundred two thousand three hundred
  // forty-five", which nobody can type back.
  assert.ok(!say.includes('102345'), 'the code was left as one number');
  assert.ok(say.includes('1. 0. 2. 3. 4. 5.'), 'the digits are not separated');
  assert.equal(say.match(/1\. 0\. 2\. 3\. 4\. 5/g)?.length, 2, 'the code is not repeated');
});

ok('a leading zero survives into the spoken code', () => {
  // `mintCode` pads to six, so `000123` is a real code and must not be read
  // as "one hundred twenty-three".
  const say = speechForCode('000123');
  assert.ok(say.includes('0. 0. 0. 1. 2. 3.'));
});

/* -------------------------------------------------------------------------- */
/* 8. Recurring ticket occurrence arithmetic                                   */
/*                                                                             */
/* `nextOccurrence` is the whole no-duplicate guarantee for RecurringTicket,   */
/* joining `nextRun` above -- see item 6 in the header for what each property  */
/* below protects against.                                                    */
/* -------------------------------------------------------------------------- */

console.log('\nrecurring tickets');

const TICKET_REPEATS = ['DAILY', 'WEEKDAYS', 'WEEKLY', 'MONTHLY'] as const;

/** ISO instant search rather than a hand-picked date -- a wrong guess at which
 * real-world date is a Saturday would make the weekday-roll checks below pass
 * for the wrong reason, which is worse than not having them. */
function findUtcDay(target: number, from: Date): Date {
  let at = from;
  while (at.getUTCDay() !== target) at = new Date(at.getTime() + DAY_MS);
  return at;
}

const A_SATURDAY = findUtcDay(6, new Date('2026-01-01T09:00:00Z'));
const A_SUNDAY = findUtcDay(0, new Date('2026-01-01T09:00:00Z'));

ok('every occurrence is strictly after `after`, whatever the anchor, cadence, offset or gap', () => {
  // Anchors chosen adversarially: an ordinary day, a month-end that clamps,
  // and a leap day, each of which has its own way to trip up the arithmetic.
  const anchors = [
    new Date('2026-01-15T09:00:00Z'),
    new Date('2026-01-31T09:00:00Z'),
    new Date('2028-02-29T09:00:00Z'),
  ];
  for (const anchor of anchors) {
    for (const repeat of TICKET_REPEATS) {
      for (const tz of [0, BERLIN_SUMMER, MAX_TZ_OFFSET_MINUTES, -MAX_TZ_OFFSET_MINUTES]) {
        for (const days of [-400, -30, -1, -0.5, 0, 0.5, 1, 6.9, 7, 30, 90, 400]) {
          const after = new Date(anchor.getTime() + days * DAY_MS);
          const next = nextOccurrence(anchor, repeat, after, tz);
          assert.ok(
            next.getTime() > after.getTime(),
            `${repeat} anchor=${anchor.toISOString()} tz=${tz} after=+${days}d landed at or before \`after\` -- a spawn loop`,
          );
        }
      }
    }
  }
});

ok('an `after` exactly on an occurrence still advances past it, for every cadence', () => {
  // The boundary case a half-open interval gets wrong: the tick calls this
  // with `now` at or after the occurrence it just claimed, never strictly
  // between two occurrences.
  const anchor = new Date('2026-01-15T09:00:00Z');
  for (const repeat of TICKET_REPEATS) {
    const first = nextOccurrence(anchor, repeat, anchor, 0);
    const second = nextOccurrence(anchor, repeat, first, 0);
    assert.ok(
      second.getTime() > first.getTime(),
      `${repeat}: \`after\` equal to an occurrence did not advance past it`,
    );
  }
});

console.log('\nrecurring tickets — monthly clamp never sticks');

ok('anchored on the 31st: Jan 31 -> Feb 28 -> Mar 31 -> Apr 30 -> May 31, feeding each result back as `after` the way the tick does', () => {
  const anchor = new Date('2026-01-31T09:00:00Z');
  const expected: Array<[number, number, number]> = [
    [2026, 0, 31], // Jan 31 -- the anchor itself
    [2026, 1, 28], // Feb 28 -- clamped, 2026 is not a leap year
    [2026, 2, 31], // Mar 31 -- the clamp did NOT stick
    [2026, 3, 30], // Apr 30 -- clamped again, independently
    [2026, 4, 31], // May 31
  ];
  let after = new Date(anchor.getTime() - DAY_MS);
  for (const [year, month, day] of expected) {
    const next = nextOccurrence(anchor, 'MONTHLY', after, 0);
    assert.equal(next.getUTCFullYear(), year, `year for ${year}-${month + 1}-${day}`);
    assert.equal(next.getUTCMonth(), month, `month for ${year}-${month + 1}-${day}`);
    assert.equal(
      next.getUTCDate(),
      day,
      `expected day ${day} in month ${month + 1} of ${year}, got ${next.getUTCDate()} -- ` +
        'a clamp that leaked into the next occurrence would show 28 every month from February on',
    );
    assert.equal(next.getUTCHours(), 9, 'the time of day must survive the clamp');
    after = next;
  }
});

ok('a leap February clamps to the 29th, not the 28th', () => {
  const anchor = new Date('2028-01-31T09:00:00Z'); // 2028 is a leap year
  const before = new Date(anchor.getTime() - DAY_MS);
  const first = nextOccurrence(anchor, 'MONTHLY', before, 0);
  const second = nextOccurrence(anchor, 'MONTHLY', first, 0);
  assert.equal(second.getUTCFullYear(), 2028);
  assert.equal(second.getUTCMonth(), 1, 'February');
  assert.equal(second.getUTCDate(), 29, 'a leap February must not be clamped down to 28');
});

ok('an anchor on 29 Feb falls back to 28 Feb in the very next non-leap year', () => {
  const anchor = new Date('2028-02-29T09:00:00Z'); // 2028 is a leap year, 2029 is not
  let after = new Date(anchor.getTime() - DAY_MS);
  let next = anchor;
  for (let k = 0; k <= 12; k += 1) {
    next = nextOccurrence(anchor, 'MONTHLY', after, 0);
    after = next;
  }
  assert.equal(next.getUTCFullYear(), 2029);
  assert.equal(next.getUTCMonth(), 1, 'February');
  assert.equal(next.getUTCDate(), 28, 'no 29th in 2029 -- the clamp must fall back, not skip ahead to March');
});

ok('monthly crosses a year boundary and still clamps correctly on the far side', () => {
  const anchor = new Date('2026-12-31T09:00:00Z');
  const expected: Array<[number, number, number]> = [
    [2026, 11, 31], // Dec 31 -- the anchor
    [2027, 0, 31], // Jan 31
    [2027, 1, 28], // Feb 28, 2027 -- not a leap year
  ];
  let after = new Date(anchor.getTime() - DAY_MS);
  for (const [year, month, day] of expected) {
    const next = nextOccurrence(anchor, 'MONTHLY', after, 0);
    assert.equal(next.getUTCFullYear(), year);
    assert.equal(next.getUTCMonth(), month);
    assert.equal(next.getUTCDate(), day, `year-boundary clamp failed for ${year}-${month + 1}`);
    after = next;
  }
});

console.log('\nrecurring tickets — weekday roll');

ok('rollToWeekday moves Saturday and Sunday to Monday and leaves Monday-Friday untouched', () => {
  assert.equal(rollToWeekday(A_SATURDAY, 0).getUTCDay(), 1);
  assert.equal(rollToWeekday(A_SATURDAY, 0).getTime(), A_SATURDAY.getTime() + 2 * DAY_MS);
  assert.equal(rollToWeekday(A_SUNDAY, 0).getUTCDay(), 1);
  assert.equal(rollToWeekday(A_SUNDAY, 0).getTime(), A_SUNDAY.getTime() + DAY_MS);

  for (let day = 1; day <= 5; day += 1) {
    const weekday = findUtcDay(day, new Date('2026-01-01T00:00:00Z'));
    assert.equal(
      rollToWeekday(weekday, 0).getTime(),
      weekday.getTime(),
      `${weekday.toISOString()} is Monday-Friday and must not move`,
    );
  }
});

ok('WEEKDAYS never lands on a weekend on the TEMPLATE wall clock, even across the date line', () => {
  // Formula lifted from the module's own header comment: wall clock = instant
  // minus the offset. Checking the raw UTC instant instead -- the bug this
  // guards against -- would pass at tz=0 and fail invisibly everywhere else.
  const wallClockDay = (instant: Date, tzOffsetMinutes: number) =>
    new Date(instant.getTime() - tzOffsetMinutes * 60_000).getUTCDay();

  const anchor = new Date('2026-01-05T09:00:00Z');
  // 0 is the control; the rest are large, and one of each sign, so a template
  // on the far side of the date line (a large negative offset shifts the wall
  // clock a day AHEAD of UTC; a large positive one shifts it a day behind) is
  // actually exercised, not just the common single-digit zones.
  for (const tz of [0, BERLIN_SUMMER, 720, -720, MAX_TZ_OFFSET_MINUTES, -MAX_TZ_OFFSET_MINUTES]) {
    let after = new Date(anchor.getTime() - DAY_MS);
    for (let i = 0; i < 60; i += 1) {
      const next = nextOccurrence(anchor, 'WEEKDAYS', after, tz);
      const day = wallClockDay(next, tz);
      assert.ok(
        day !== 0 && day !== 6,
        `tz=${tz}: occurrence ${next.toISOString()} is a weekend on the template's own wall clock (day=${day})`,
      );
      after = next;
    }
  }
});

console.log('\nrecurring tickets — missed occurrences are skipped, not replayed');

ok('a daily template down for a week fires once tomorrow, not seven times today', () => {
  const anchor = new Date('2026-01-05T09:00:00Z');
  const now = new Date('2026-01-12T09:30:00Z'); // 7 days and 30 minutes late
  const next = nextOccurrence(anchor, 'DAILY', now, 0);
  assert.equal(next.toISOString(), '2026-01-13T09:00:00.000Z');
  assert.ok(next.getTime() > now.getTime());
});

ok('an outage of several missed periods still yields exactly the immediate next occurrence, for every cadence', () => {
  const anchor = new Date('2026-01-05T09:00:00Z');
  // Each outage is sized to roughly seven periods of its own cadence -- "down
  // for a week" scaled to what a week actually means for that repeat, so
  // several real occurrences are missed in every case, not just DAILY's.
  const outageMs: Record<(typeof TICKET_REPEATS)[number], number> = {
    DAILY: 7 * DAY_MS,
    WEEKDAYS: 7 * DAY_MS,
    WEEKLY: 7 * 7 * DAY_MS,
    MONTHLY: 7 * 31 * DAY_MS,
  };
  // How far past `now` the single returned occurrence may legitimately land:
  // one cadence step, plus the WEEKDAYS roll's own two-day allowance. Replaying
  // even one extra missed period would blow straight through this bound.
  const stepBoundMs: Record<(typeof TICKET_REPEATS)[number], number> = {
    DAILY: DAY_MS,
    WEEKDAYS: 3 * DAY_MS,
    WEEKLY: 7 * DAY_MS,
    MONTHLY: 31 * DAY_MS,
  };
  for (const repeat of TICKET_REPEATS) {
    const now = new Date(anchor.getTime() + outageMs[repeat]);
    const next = nextOccurrence(anchor, repeat, now, 0);
    assert.ok(next.getTime() > now.getTime(), `${repeat}: still due after the outage -- a spawn loop`);
    const overshootDays = (next.getTime() - now.getTime()) / DAY_MS;
    assert.ok(
      next.getTime() - now.getTime() <= stepBoundMs[repeat],
      `${repeat}: next occurrence is ${overshootDays} days past the outage ending -- ` +
        'missed occurrences were skipped over rather than resuming at the very next one',
    );
  }
});

console.log('\nrecurring tickets — labels and date formatting');

ok('every ticket repeat has a label, so the recurring page never renders undefined', () => {
  for (const repeat of TICKET_REPEATS) {
    assert.equal(typeof TICKET_REPEAT_LABEL[repeat], 'string');
    assert.ok(TICKET_REPEAT_LABEL[repeat].length > 0);
  }
});

ok('formatDateStamp and dueDateFor agree on the occurrence day, even when the offset crosses a UTC date boundary', () => {
  // Tokyo, UTC+9 (tzOffsetMinutes -540): 2026-08-12T00:30 local is
  // 2026-08-11T15:30 UTC. The UTC calendar day is a day behind the wall-clock
  // day both the title stamp and the due date must use.
  const tokyo = -540;
  const instant = new Date('2026-08-11T15:30:00Z');
  assert.equal(formatDateStamp(instant, tokyo), '12 Aug 2026');
  assert.equal(dueDateFor(instant, tokyo).toISOString(), '2026-08-12T00:00:00.000Z');
});

ok('dueDateFor always returns exact UTC midnight, whatever the time of day or offset', () => {
  for (const tz of [0, BERLIN_SUMMER, 720, -720, MAX_TZ_OFFSET_MINUTES, -MAX_TZ_OFFSET_MINUTES]) {
    const due = dueDateFor(new Date('2026-08-11T23:59:59.999Z'), tz);
    assert.equal(due.getUTCHours(), 0);
    assert.equal(due.getUTCMinutes(), 0);
    assert.equal(due.getUTCSeconds(), 0);
    assert.equal(due.getUTCMilliseconds(), 0);
  }
});

console.log('\nproject visibility');

const AUTHZ = 'src/lib/authz.ts';

function sourceFiles(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...sourceFiles(path));
    else if (entry.name.endsWith('.ts') || entry.name.endsWith('.tsx')) found.push(path);
  }
  return found;
}

ok('no project-rooted read spells the membership predicate out by hand', () => {
  // The exact shape every loader used before `visibleProject` existed. Finding
  // it again means somebody copied a pre-existing query and got a read that is
  // scoped to the tenant but NOT to the project.
  const banned = /project:\s*\{\s*organization:\s*\{\s*memberships:/;
  const offenders = sourceFiles('src')
    .filter((file) => !file.replaceAll('\\', '/').endsWith(AUTHZ))
    .filter((file) => banned.test(readFileSync(file, 'utf8')));
  assert.deepEqual(offenders, [], `use visibleProject() instead: ${offenders.join(', ')}`);
});

ok('visibleProject spreads the caller scope FIRST, so it cannot overwrite the predicate', () => {
  const source = readFileSync(AUTHZ, 'utf8');
  const start = source.indexOf('export function visibleProject');
  const spread = source.indexOf('...scope,', start);
  const membership = source.indexOf('memberships: { some: { userId } }', start);
  const or = source.indexOf('OR: [', start);
  assert.ok(spread > start, 'visibleProject must spread the caller scope');
  assert.ok(membership > spread, 'the scope spread must come before the membership clause');
  assert.ok(or > spread, 'the scope spread must come before the OR');
});

ok('the three ways to see a project are all still there', () => {
  const source = readFileSync(AUTHZ, 'utf8');
  const body = source.slice(
    source.indexOf('export function visibleProject'),
    source.indexOf('export async function canSeeProject'),
  );
  // Open to the org, named on the project, or the org owner. Losing the first
  // hides every ordinary project; losing the last orphans one whose members
  // have all left.
  assert.match(body, /access: ProjectAccess\.OPEN/);
  assert.match(body, /members: \{ some: \{ userId \} \}/);
  assert.match(body, /role: Role\.OWNER/);
});

console.log(`\nAll good — ${checks} checks.\n`);
