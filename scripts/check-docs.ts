/**
 * Asserts the document tree's one load-bearing invariant: the parent chain stays
 * acyclic, and nothing is lost when it is walked.
 *
 * `src/lib/documents.ts` is the only logic in the documents feature -- everything
 * else is a query, a form, or a delegation to a Server Action that already has its
 * own rules. What can go wrong here cannot go wrong quietly:
 *
 *   1. A MOVE INTO A DESCENDANT DETACHES A BRANCH. Filing a page under its own
 *      child leaves that subtree pointing only at itself: it disappears from the
 *      tree page, from every breadcrumb, and from the MCP list -- while still
 *      occupying rows and still cascading a delete. `wouldCycle` is what refuses
 *      it, and `parentOptions` is what keeps the picker from offering it.
 *
 *   2. A CYCLE HANGS THE REQUEST. `ancestorChain` and `flattenTree` both walk the
 *      chain, so if a cycle ever does reach the database (a manual UPDATE, a
 *      restored dump) these must terminate rather than spin forever inside a page
 *      render. Their `seen` / `placed` sets are the only reason they do.
 *
 *   3. A ROW MUST NEVER VANISH FROM THE TREE. `flattenTree` places orphans and
 *      unreachable rows at the top level instead of dropping them, because a page
 *      that exists but renders nowhere is unrecoverable through the UI.
 *
 * Runs on Bun, no database:
 *
 *   bun scripts/check-docs.ts
 */

import assert from 'node:assert/strict';

import {
  ancestorChain,
  descendantIds,
  flattenTree,
  parentOptions,
  wouldCycle,
  type DocNode,
} from '../src/lib/documents';

let passed = 0;
function check(name: string, run: () => void) {
  run();
  passed += 1;
  void name;
}

const doc = (id: string, parentId: string | null, title = id): DocNode => ({ id, parentId, title });

/*
 * handbook
 *   onboarding
 *     day-one
 *   security
 * runbook
 */
const TREE: DocNode[] = [
  doc('handbook', null),
  doc('onboarding', 'handbook'),
  doc('day-one', 'onboarding'),
  doc('security', 'handbook'),
  doc('runbook', null),
];

/* 1. The move guard. */

check('a document cannot be moved under itself', () => {
  assert.equal(wouldCycle(TREE, 'handbook', 'handbook'), true);
});

check('a document cannot be moved under its own child', () => {
  assert.equal(wouldCycle(TREE, 'handbook', 'onboarding'), true);
});

check('a document cannot be moved under a deeper descendant', () => {
  assert.equal(wouldCycle(TREE, 'handbook', 'day-one'), true);
});

check('a move under an unrelated document is allowed', () => {
  assert.equal(wouldCycle(TREE, 'handbook', 'runbook'), false);
  assert.equal(wouldCycle(TREE, 'day-one', 'runbook'), false);
});

check('a move to the top level is always allowed', () => {
  assert.equal(wouldCycle(TREE, 'day-one', null), false);
});

check('descendants are transitive and exclude the root', () => {
  assert.deepEqual([...descendantIds(TREE, 'handbook')].sort(), [
    'day-one',
    'onboarding',
    'security',
  ]);
  assert.equal(descendantIds(TREE, 'day-one').size, 0);
});

/* 2. The picker offers exactly the legal parents. */

check('parent options exclude self and descendants', () => {
  assert.deepEqual(
    parentOptions(TREE, 'handbook').map((row) => row.id),
    ['runbook'],
  );
  assert.deepEqual(
    parentOptions(TREE, 'runbook').map((row) => row.id),
    ['handbook', 'onboarding', 'day-one', 'security'],
  );
});

/* 3. Breadcrumbs. */

check('the ancestor chain runs root-first and includes the document', () => {
  assert.deepEqual(
    ancestorChain(TREE, 'day-one').map((row) => row.id),
    ['handbook', 'onboarding', 'day-one'],
  );
  assert.deepEqual(
    ancestorChain(TREE, 'runbook').map((row) => row.id),
    ['runbook'],
  );
});

/* 4. Flattening: order, depth, and nothing lost. */

check('the tree flattens depth-first with depths', () => {
  assert.deepEqual(
    flattenTree(TREE).map((row) => [row.id, row.depth]),
    [
      ['handbook', 0],
      ['onboarding', 1],
      ['day-one', 2],
      ['security', 1],
      ['runbook', 0],
    ],
  );
});

check('a row whose parent is absent is shown at the top level', () => {
  // The subtree of a document the caller cannot see -- or a partial read.
  const orphan = flattenTree([doc('day-one', 'onboarding'), doc('runbook', null)]);
  assert.deepEqual(
    orphan.map((row) => [row.id, row.depth]),
    [
      ['day-one', 0],
      ['runbook', 0],
    ],
  );
});

/*
 * 5. Corrupt data terminates. Not reachable through the app -- `wouldCycle`
 *    refuses it -- but these are the two functions a hand-written UPDATE would
 *    hang, and a hung render takes the whole route with it.
 */

const CYCLE: DocNode[] = [doc('a', 'b'), doc('b', 'a'), doc('c', null)];

check('a cycle does not hang the ancestor walk', () => {
  const chain = ancestorChain(CYCLE, 'a').map((row) => row.id);
  assert.equal(chain.includes('a'), true);
  assert.equal(chain.length <= CYCLE.length, true);
});

check('a cycle does not hang the flatten, and still lists every row', () => {
  const flat = flattenTree(CYCLE);
  assert.deepEqual(
    flat.map((row) => row.id).sort(),
    ['a', 'b', 'c'],
  );
});

check('a cycle does not hang the descendant walk', () => {
  assert.deepEqual([...descendantIds(CYCLE, 'a')].sort(), ['a', 'b']);
});

console.log(`check-docs: ${passed} checks passed`);
