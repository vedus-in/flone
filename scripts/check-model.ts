/**
 * Asserts the three things in the Linear rework that rot silently.
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

console.log(`\nAll good — ${checks} checks.\n`);
