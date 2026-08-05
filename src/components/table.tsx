'use client';

import { Table } from '@/components/application/table/table';

/**
 * Untitled UI's table, flattened into one named export per part.
 *
 * `Table.Header` and friends are properties ASSIGNED to the `Table` function at
 * runtime, not module exports. A Server Component never runs a `'use client'`
 * module -- it only gets a client *reference* per export -- so `Table.Header`
 * read from a server file is `undefined`, and React fails at render with error
 * #130 ("element type is invalid"). Nothing catches it earlier: types are fine,
 * and the build only prerenders static routes, so a dynamic page like `/tokens`
 * fails the first time a human opens it.
 *
 * This module IS a client module, so the property reads happen for real, and
 * each part becomes its own export with its own client reference. Server
 * Components import the flat names and never dot into the namespace.
 *
 * Same hazard, same rule, elsewhere in this app: `ButtonLink` and `EmptyState`.
 */
export const TableRoot = Table;
export const TableHeader = Table.Header;
export const TableHead = Table.Head;
export const TableBody = Table.Body;
export const TableRow = Table.Row;
export const TableCell = Table.Cell;
