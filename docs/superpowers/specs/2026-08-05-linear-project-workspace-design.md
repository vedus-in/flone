# Linear-style project workspace — design

Date: 2026-08-05
Status: approved, implementing in one pass

Extends `SPEC.md`. Where the two disagree about the ticket/column model, this
document wins; everything `SPEC.md` says about authorization, sessions,
passwords, rate limiting, CSRF and validation is unchanged and still binding.

## 1. The mapping

The existing hierarchy already matches Linear's, one level shifted:

| Linear            | This repo                                            |
| ----------------- | ---------------------------------------------------- |
| Workspace         | `Organization`                                       |
| **Team** (`VED`)  | **`Project`** — owns the key, states, labels, cycles |
| **Project** chip  | **`Board`**                                          |
| Issue `VED-153`   | `Ticket`                                             |
| Workflow state    | `WorkflowState` (was `BoardColumn`)                  |

An issue has exactly **one** status, and that status belongs to the Project.
This is what Linear does. There are no per-board private columns; a board's
kanban is a *view* grouped by the project's workflow states.

## 2. Schema

### New models

**`WorkflowState`** — `projectId, name, type, color, position`.
`type ∈ BACKLOG | UNSTARTED | STARTED | COMPLETED | CANCELED`.

The type is the load-bearing field. It decides:

- which tab an issue appears under (Active = `UNSTARTED` + `STARTED`,
  Backlog = `BACKLOG`, All = everything),
- whether an issue counts as done for cycle progress and sub-issue progress
  (`COMPLETED` only — `CANCELED` leaves the scope instead of completing it),
- whether `startedAt` / `completedAt` get stamped on a transition.

`position` is the **board** order — Backlog → Todo → In Progress → In Review →
Done → Canceled, left to right, which is what a kanban wants and what the
settings page lists.

The **issue list** groups in a different order, and deliberately so: the
screenshots show In Review, then Todo, then Backlog. That order is a rank
derived from the type in application code (`STARTED, UNSTARTED, BACKLOG,
COMPLETED, CANCELED`, then `position` within a rank), not a second column. One
stored order, two derived presentations.

**`Cycle`** — `projectId, number, name?, startsAt, endsAt`, unique
`(projectId, number)`.

**`Label`** — `projectId, name, color`, implicit m:n with `Ticket`.

**`SavedView`** — `projectId, name, query, createdById, isShared`. `query` is
the Issues-list query string verbatim. A saved view is a named URL; there is no
separate filter DSL to keep in sync with the one the URL already expresses.

### Changed models

- `Project` gains `cyclesEnabled, cycleWeeks (default 2), cycleStartDay (1 =
  Monday), upcomingCycles (default 3)`.
- `Board` gains `status (BoardStatus), leadId?, targetDate?, color`, and is
  now optional on a ticket.
- `Ticket`: `columnId` → `stateId`; `boardId` becomes nullable; gains
  `projectId` (non-null), `cycleId?`, `parentId?`, `labels[]`, `startedAt?`,
  `completedAt?`. `@@unique([boardId, number])` → `@@unique([projectId, number])`.
- `BoardColumn` — dropped.

`Ticket.projectId` is denormalized rather than derived through the board,
because the board is now nullable and every project-level query roots at it.
It is written only from an authorized context and never from client input.

### Migration

One Prisma migration plus a SQL data step, in this order:

1. Create the new tables and columns, `Ticket.projectId` nullable for now.
2. For each project, collapse its boards' distinct column names into
   `WorkflowState` rows. Type is inferred from the name, case-insensitively:
   `backlog` → `BACKLOG`; `todo`/`to do`/`open`/`new` → `UNSTARTED`;
   `done`/`complete`/`closed`/`shipped` → `COMPLETED`;
   `cancel*`/`duplicate`/`wont*` → `CANCELED`; anything else → `STARTED`.
   A `Backlog` and a `Canceled` state are appended if the project ended up
   with none, so every project can express the full tab set.
3. Point every ticket at the state matching its old column's name within its
   project; backfill `projectId` from the board.
4. **Renumber only projects that collide.** A project whose boards' ticket
   numbers are already globally distinct within the project keeps every
   number, so single-board projects — the common case — keep every existing
   ticket URL. Colliding projects are renumbered by `createdAt, id`.
5. Drop `BoardColumn`, make `Ticket.projectId` non-null, add the new
   constraints.

Number allocation moves to `max(number) per project + 1`, keeping the existing
three-attempt retry from SPEC 7.5, rekeyed to the `(projectId, number)`
constraint.

## 3. Routes

```
/orgs/[org]/[KEY]                     overview
/orgs/[org]/[KEY]/issues              Active | Backlog | All
/orgs/[org]/[KEY]/cycles              list
/orgs/[org]/[KEY]/cycles/current      redirect to the active cycle
/orgs/[org]/[KEY]/cycles/upcoming     the ones after it
/orgs/[org]/[KEY]/cycles/[n]          detail + progress panel
/orgs/[org]/[KEY]/boards              board list
/orgs/[org]/[KEY]/boards/[boardId]    kanban, columns = workflow states
/orgs/[org]/[KEY]/issue/[number]      issue detail
/orgs/[org]/[KEY]/views               saved views
/orgs/[org]/[KEY]/settings            states, labels, cycles, danger zone
```

Boards move under `/boards/` so a cuid can never shadow a literal segment.
The old `/[KEY]/[boardId]` and `/[KEY]/[boardId]/[n]` shapes are kept as
redirect-only routes that resolve the board and forward.

## 4. UI

**Sidebar** — the org switcher is unchanged. Each project row expands to
`Home · Issues · Cycles (Current / Upcoming) · Boards · Views` instead of a
board list.

**Issue row** — one shared server component, used by the issues list, cycle
detail and board pages: priority icon · `VED-153` · state icon · title ·
parent breadcrumb · sub-issue progress · labels · board chip · cycle number ·
assignee · updated date. Rows group under collapsible state headers with counts.

**Cycle panel** — scope as issue count (not points), completed count, and a
hand-drawn inline-SVG burndown against the ideal line. No charting dependency.

**Filters** live in the query string, so every view is shareable and
back/forward works without any client state.

## 5. Behaviour

**Cycle generation is lazy.** Any read of a cycles route ensures the cycle
covering *now* plus `upcomingCycles` ahead exist, upserted idempotently on
`(projectId, number)`. Unfinished issues in a cycle that has ended roll forward
into the next one. No cron and no new Railway service.

`startedAt` / `completedAt` are stamped when an issue transitions into a state
of type `STARTED` / `COMPLETED`, and cleared on the way back out. The burndown
reads `completedAt`.

**Permissions** — managing workflow states, labels, cycle configuration and
boards requires `ADMIN`. Creating and editing issues, comments and saved views
follows the existing role matrix in SPEC 3. Deleting an issue stays
author-or-`ADMIN` (SPEC 7.18).

## 6. Out of scope

Story-point estimates (scope is an issue count), triage inbox, issue relations
beyond parent/child, per-user personal views, issue templates, SLAs.

## 7. Checks

`scripts/check-model.ts` (`bun run check:model`, or plain `node` — 22 strips the
types) asserts the four things that rot silently:

- state type → tab and group mapping, including that no type falls out of every
  tab and that canceled counts as neither done nor open;
- the lifecycle stamps `stampsFor` applies on a transition — the invariant the
  burndown reads;
- the migration's name → type inference, cross-checked against the keywords
  actually present in the migration SQL;
- cycle arithmetic: `cycleNumberAt` is an exact inverse of `cycleWindow` and
  consecutive windows tile with no gap, which is precisely what makes the lazy
  `createMany({ skipDuplicates })` generation idempotent.

`stampsFor` lives in `src/lib/model.ts` rather than beside the actions that call
it, because every export of a `'use server'` module must be an async Server
Action — and putting it there is what makes it testable.

`check:boundary` and `mcp:smoke` keep running; the smoke script was extended to
cover board-less issues, the completedAt stamp on entering and leaving a done
state, and that deleting a board leaves its issues intact.
