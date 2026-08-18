/**
 * The document tree, as pure functions over the flat rows Prisma returns.
 *
 * NO PRISMA, NO `server-only`, NO SESSION -- deliberately. A project's documents
 * are a handful of short rows, so every surface here (the tree page, the
 * breadcrumbs, the parent picker, the move guard, the MCP list tool) reads the
 * whole set once and shapes it in memory rather than issuing a recursive query
 * per node. Keeping the shaping pure is what lets `scripts/check-docs.ts` assert
 * the one invariant that matters without a database.
 *
 * THE INVARIANT: the parent chain is acyclic. Postgres will store a -> b -> a
 * happily, and both readers below walk that chain -- so a cycle is not a wrong
 * answer, it is a page render that never returns. `moveDocument` is the only
 * writer of `parentId`, and `wouldCycle` is the only thing standing between it
 * and a hung request.
 */

/** The minimum every helper here needs. Callers pass their own richer rows. */
export type DocNode = {
  id: string;
  parentId: string | null;
  title: string;
};

/**
 * Every descendant of `rootId`, the root itself excluded.
 *
 * Breadth-first over a children index, with a `seen` set that doubles as the
 * result: a row already visited is never queued again, so this terminates even
 * on data that should be impossible (a cycle written directly into the database,
 * or a subtree whose parent link was corrupted).
 */
export function descendantIds(rows: readonly DocNode[], rootId: string): Set<string> {
  const byParent = new Map<string, DocNode[]>();
  for (const row of rows) {
    if (row.parentId === null) continue;
    const siblings = byParent.get(row.parentId);
    if (siblings) siblings.push(row);
    else byParent.set(row.parentId, [row]);
  }

  const found = new Set<string>();
  const queue = [rootId];
  while (queue.length > 0) {
    for (const child of byParent.get(queue.pop()!) ?? []) {
      if (found.has(child.id)) continue;
      found.add(child.id);
      queue.push(child.id);
    }
  }
  return found;
}

/**
 * MANDATORY before any write of `Document.parentId`.
 *
 * True when filing `movedId` under `parentId` would put the document inside its
 * own subtree -- either directly (its own parent) or transitively (under one of
 * its descendants). Both are the same mistake: the branch would detach from every
 * root and point only at itself.
 *
 * `parentId` of null is always fine: top level is by definition not inside
 * anything.
 */
export function wouldCycle(
  rows: readonly DocNode[],
  movedId: string,
  parentId: string | null,
): boolean {
  if (parentId === null) return false;
  if (parentId === movedId) return true;
  return descendantIds(rows, movedId).has(parentId);
}

/**
 * The rows a document may legally be filed under: everything in the project
 * except itself and its own descendants.
 *
 * This is what the parent picker renders, so the UI cannot even OFFER a cycle --
 * and `moveDocument` still calls `wouldCycle`, because a form field is a
 * suggestion and a POST body is whatever the caller typed.
 */
export function parentOptions<T extends DocNode>(rows: readonly T[], movedId: string): T[] {
  const forbidden = descendantIds(rows, movedId);
  return rows.filter((row) => row.id !== movedId && !forbidden.has(row.id));
}

/**
 * The chain from the root down to `id`, inclusive -- the breadcrumbs.
 *
 * Bounded by the row count via a `seen` set, for the same reason `descendantIds`
 * is: this must terminate on corrupt data rather than hang the request that would
 * have revealed the corruption.
 */
export function ancestorChain<T extends DocNode>(rows: readonly T[], id: string): T[] {
  const byId = new Map(rows.map((row) => [row.id, row]));
  const chain: T[] = [];
  const seen = new Set<string>();

  let cursor: string | null = id;
  while (cursor !== null && !seen.has(cursor)) {
    seen.add(cursor);
    const row: T | undefined = byId.get(cursor);
    if (!row) break;
    chain.unshift(row);
    cursor = row.parentId;
  }
  return chain;
}

/**
 * The whole tree flattened back into a list, each row carrying its `depth`.
 *
 * A flat list is what both surfaces actually want: the page indents by depth and
 * the MCP tool reports it as a number. Neither needs a recursive component or a
 * nested JSON shape, and this way the sibling order is simply the caller's row
 * order -- sorted by title in the query, so nothing here re-sorts.
 *
 * NOTHING IS EVER DROPPED. A row whose parent is missing from `rows` is treated
 * as a root, and any row left unvisited after the walk (only reachable if the
 * database somehow holds a cycle) is appended at depth 0. A tree builder that
 * silently loses a page is worse than one that renders it in the wrong place.
 */
export function flattenTree<T extends DocNode>(rows: readonly T[]): Array<T & { depth: number }> {
  const ids = new Set(rows.map((row) => row.id));
  const byParent = new Map<string | null, T[]>();
  for (const row of rows) {
    // A parent outside this set cannot be walked to, so the row is a root.
    const key = row.parentId !== null && ids.has(row.parentId) ? row.parentId : null;
    const siblings = byParent.get(key);
    if (siblings) siblings.push(row);
    else byParent.set(key, [row]);
  }

  const out: Array<T & { depth: number }> = [];
  const placed = new Set<string>();

  const walk = (parentId: string | null, depth: number): void => {
    for (const row of byParent.get(parentId) ?? []) {
      if (placed.has(row.id)) continue;
      placed.add(row.id);
      out.push({ ...row, depth });
      walk(row.id, depth + 1);
    }
  };
  walk(null, 0);

  for (const row of rows) {
    if (!placed.has(row.id)) out.push({ ...row, depth: 0 });
  }
  return out;
}
