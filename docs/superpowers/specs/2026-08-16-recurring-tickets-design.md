# Recurring tickets — design

Date: 2026-08-16
Status: designed — not yet implemented

Extends `SPEC.md`, `2026-08-05-linear-project-workspace-design.md` and
`2026-08-11-reminders-design.md`. Everything those documents say about
authorization, sessions, validation, the Server Action contract, the mail
transport and the cron trigger is unchanged and still binding — this feature
adds one table, one enum, one page and one branch in the existing cron tick,
and changes no existing behaviour.

## 1. What gets built

A **recurring ticket**: a template that the scheduler turns into a real,
ordinary `Ticket` on a cadence.

- **Every day, every weekday, every week, or every month** — the occurrence
  honoured exactly, never duplicated, missed ones skipped rather than replayed;
- **Pre-filled** — title, Markdown description, priority, labels and assignee
  are copied from the template, so the ticket arrives with its parameters and
  its checklist already written;
- **Landing in one project**, in that project's first *Todo*-type state, due
  the day it was spawned.

Everything after the spawn is the app as it already exists. The review is a
`Comment` on the spawned ticket. Done is moving it to a `COMPLETED` state. The
history of every review of one recurring duty is the issues list filtered by a
label. The assignee is nudged by mail when their ticket appears.

### The driving case, and why the feature is not shaped like it

The internal need is a trading desk: a defined set of deployed strategies
(MT5, TradingView via Morrowell), each reviewed daily/weekly/monthly — how it
worked, how it performed, what to improve. That is one template per strategy:
the strategy's parameters and deployment target in the description, a label
per strategy for history, `WEEKDAYS` because markets close.

The feature itself stays generic — *recurring tickets*, the thing every
tracker's users ask for (standups, on-call handoffs, invoicing, renewals) —
because this app is headed for public release and "strategy review" is a
usage, not a mechanism. Nothing in the schema or the copy knows what a
strategy is.

### How the improvement loop closes, with zero new features

- *"Here is how it performed"* → a comment on the spawned ticket, structured
  by whatever headings the template's own description carries
  (`## How it worked`, `## Performance`, `## Improvements`).
- *"Just make the improvement"* → an ordinary ticket, optionally a **child**
  of the review ticket (`parentId` already exists), so the review links to the
  work it caused.
- *"From next time, also monitor X"* → **edit the template's description.**
  The next occurrence includes it. The template is the living checklist;
  improving the process and editing the template are the same gesture. This is
  also why templates are editable where reminders are not — a reminder is four
  fields, a template body is accumulated work product.

### What this deliberately does not touch

`Reminder` and its tick are unchanged (the route that triggers both is shared
— §6). `Ticket`, `WorkflowState`, `Cycle`, `Board`, `Label`, `Comment` and
every query over them are untouched; the one write the feature makes to shared
data is creating a ticket, and it goes through the exact transaction
`createIssue` already runs — extracted, not copied, so the two can never
disagree (§5). The migration creates one enum, one table and one join table,
backfills nothing and rewrites nothing.

## 2. Schema

One enum, one model, one implicit m:n join.
`prisma/migrations/20260816000000_recurring_tickets/`.

```prisma
enum TicketRepeat {
  DAILY
  WEEKDAYS
  WEEKLY
  MONTHLY
}

model RecurringTicket {
  id              String       @id @default(cuid())
  projectId       String
  project         Project      @relation(fields: [projectId], references: [id], onDelete: Cascade)
  /// 1–160, not the Ticket's 200: the spawn stamps " — 16 Aug 2026" onto it,
  /// and the headroom is what guarantees the stamped title always fits.
  title           String
  description     String?      @db.Text
  priority        Priority     @default(NONE)
  /// SetNull, not Cascade: losing the assignee must not delete the process
  /// definition. The next occurrence spawns unassigned and sits on the board.
  assigneeId      String?
  assignee        User?        @relation("RecurringTicketAssignee", fields: [assigneeId], references: [id], onDelete: SetNull)
  repeat          TicketRepeat
  /// The first occurrence, immutable except by an explicit schedule edit.
  /// EVERY later occurrence is computed from it, never from the previous one —
  /// that is what stops a monthly template anchored on the 31st from drifting
  /// to the 28th forever after its first February (§4).
  anchorAt        DateTime
  /// The scheduler's whole query, claimed by compare-and-swap exactly as
  /// `Reminder.nextRunAt` is. Null means PAUSED — same "null is off" semantics,
  /// so no second boolean, and a paused template keeps its accumulated
  /// description instead of being deleted to stop it.
  nextRunAt       DateTime?
  lastSpawnedAt   DateTime?
  tzOffsetMinutes Int          @default(0)
  /// Cascade, like Reminder: configuration, not authored content. In practice
  /// a creator with authored tickets cannot be deleted anyway (Restrict), so
  /// a live template always has a live creator for spawned rows to name.
  createdById     String
  createdBy       User         @relation("RecurringTicketCreatedBy", fields: [createdById], references: [id], onDelete: Cascade)
  labels          Label[]      @relation("RecurringTicketLabels")
  createdAt       DateTime     @default(now())
  updatedAt       DateTime     @updatedAt

  @@index([nextRunAt])      // the scheduler
  @@index([projectId])      // the page
}
```

Decisions worth the words:

**`ONCE` does not exist here.** A one-time pre-filled ticket is called
creating a ticket; the form for that already exists. The enum differs from
`ReminderRepeat` for exactly this reason — it is a different value set, not a
duplicate — and `WEEKDAYS` exists here and not there because a ticket is work
and work has working days, while a nudge is whenever you asked to be nudged.

**No stored `stateId`.** The spawned ticket's state is resolved *per spawn* by
`defaultComposeState` in `src/lib/states.ts` — the first non-`BACKLOG` state,
falling back to the very first. That function already exists and is what the
compose form uses to decide where a hand-filed issue lands, so a spawned
ticket and a hand-filed one arrive in the same column by construction rather
than by two rules that agree today. Storing a state id instead would hand the
template a reference that a deleted or renamed state turns into a dangling
pointer the scheduler trips over at 3am; resolving at spawn time is the same
indirection the Daily Challenges board already uses for the same reason.

> Amended during implementation. This section first specified "the first
> `UNSTARTED` state by `STATE_ORDER`". That is the same row for a project with
> the default states, but it was a second definition of a question the codebase
> had already answered, so the existing one won.

**No `boardId`, no `cycleId`, no `parentId` on the template.** Grouping per
recurring duty is what the labels are for; a spawned review is not sprint
work; and a template with a parent is a hierarchy nobody asked for. Each is
one nullable column plus one guard away if someone asks.

**`@@index` set follows the house rule** — only what something filters on.
`assigneeId` and `createdById` get none, exactly as on `Ticket`.

## 3. Time

Identical to reminders, sharing the code: `<input type="datetime-local">`
plus the hidden `tzOffsetMinutes` field, converted once by `toInstant`, formatted
everywhere by `formatWhen` — fixed locale, `timeZone: 'UTC'` on the shifted
instant, so server render and hydration cannot disagree.

The same accepted ceiling too (`ponytail:` already in `reminder-math.ts`): the
offset is a snapshot, not a zone, so a daily template created in summer spawns
an hour off after the clocks change. Same upgrade path, written down there.

One addition: **`WEEKDAYS` is judged on the template's own wall clock**, not
the server's. A Monday-09:00 Tokyo spawn is Sunday in UTC; the weekend test
runs on the offset-shifted instant (`wallClock`), or a template on the far
side of the date line skips the wrong days. A first run picked on a Saturday
or Sunday is rolled forward to Monday by the create action, using the same
function the scheduler uses.

## 4. Recurrence

`nextOccurrence(anchorAt, repeat, after)` joins `nextRun` in
`src/lib/reminder-math.ts` — pure, import-free, exercised by
`scripts/check-model.ts` under plain Node.

- **`DAILY` / `WEEKLY`** — the existing fixed-step arithmetic: whole periods
  elapsed, computed not looped, result always strictly after `after`.
- **`WEEKDAYS`** — the daily step, then rolled forward past Saturday and
  Sunday on the template's wall clock. At most two rolls, and the result is
  still strictly after `after`.
- **`MONTHLY`** — calendar months **from the anchor**: occurrence *k* is the
  anchor's day-of-month and time-of-day, *k* months on, with the day clamped
  to the target month's length. *k* is computed from the calendar month
  difference, so a template unfired for a year costs the same arithmetic as
  one unfired for a minute. Anchored on the 31st, it spawns Jan 31 → Feb 28 →
  Mar 31: **the clamp never sticks**, because every occurrence is derived from
  `anchorAt`, never from the (possibly clamped) previous occurrence.

Both properties the reminders math asserts hold here and are asserted again:
the result is always strictly after `after` (no spawn loop), and missed
occurrences are skipped, not replayed (a scheduler down for a week spawns one
ticket per template, not seven — six stale review tickets are noise that
buries the one that matters).

`REPEAT_LABEL`-style total `Record`s for the new enum, so a fifth cadence
without labels or arithmetic is a type error, not a template that silently
stops.

## 5. The tick

`src/lib/recurring.ts` — one function, `runDueRecurringTickets(now)`, called
only by the cron route, shaped line-for-line like `runDueReminders`:

```
due = recurringTicket.findMany({ nextRunAt <= now }, take 100, asc)
for each template:
  following = nextOccurrence(template.anchorAt, template.repeat, now)
  claim     = updateMany({ id, nextRunAt: <the value read> },
                         { nextRunAt: following, lastSpawnedAt: now })
  if claim.count === 0: continue            // another tick already has it
  state  = defaultComposeState(ensureDefaultStates(projectId))   // may be null
  ticket = insertTicket({ ...copied fields, title: stamped, dueDate, state })
  mail the assignee, if any and confirmed
```

**The one invariant: a given occurrence spawns at most one ticket**, held by
the compare-and-swap on `nextRunAt`, not by a lock. The schedule is advanced
*before* the create, so the chosen failure mode is a missed ticket, never a
duplicated one — the same trade the reminders tick makes, for the same
reason: a missing review gets asked about; a board that grows two identical
tickets per day gets the feature turned off.

The spawned ticket, field by field:

| Field | Value |
| --- | --- |
| `title` | `<template title> — 16 Aug 2026` — the occurrence's date on the template's wall clock, fixed `en-GB` format. Fits by construction (§2). |
| `description` | the template's, verbatim |
| `stateId` | resolved per spawn (§2) |
| `priority`, `labels` | copied; labels connected by id — a label deleted since creation has already vanished from the join table, so the set is valid by construction |
| `assigneeId` | the template's, **re-proved a member at spawn** — someone who has left the organization spawns an unassigned ticket, not an error (the counterpart of the tick's unverified-address rule) |
| `dueDate` | the occurrence's date — "review today's session" is due today, and the existing due-date surfaces are the overdue-review escalation for free |
| `createdById` | the template's creator — the tick has no session |
| `number`, `position` | allocated by `insertTicket` (below) |

**`insertTicket` is extracted from `createIssue`, not copied.** The
`number = max + 1` transaction with its 3-attempt retry keyed strictly to the
`(projectId, number)` constraint, the position append, and the
`stampsFor` state stamps move to `src/lib/ticket-insert.ts` (a plain
`server-only` lib — it cannot live in the `'use server'` action module,
where every export is a directly addressable POST endpoint). `createIssue`
calls it with what it always computed; behaviour unchanged. One insert path,
two callers, exactly as `renderAndSend` was extracted from `queueMail` for
the reminders tick.

## 6. The trigger

**The existing route, unchanged in path and credential:**
`POST /api/cron/reminders` now runs `runDueReminders` and then
`runDueRecurringTickets`, each independently bounded at 100 and each claiming
its own rows. The path keeps its name because the deployed Railway cron has
the URL baked into its start command — the same rotation hazard the reminders
design records — and a rename is an outage nobody is looking at. The log
gains a second counts-only line:

```
[cron] recurring claimed=2 spawned=2 mailed=1
```

Never a title, a project, or an organization. Everything else the reminders
design says about the trigger — closed without `CRON_SECRET`, constant-time
comparison, `GET` as the same handler, safe at any rate including
concurrently, the 5-minute Railway floor — applies verbatim and is not
repeated here.

The tick interval remains the worst-case lateness: a 09:00 template spawns
its ticket between 09:00 and 09:05.

## 7. Email

One new template, `RecurringTicketEmail`, beside the others in
`src/emails/templates.tsx`. Sent to the assignee only, only when their address
is confirmed, checked **after** the claim (the reminders rule, same reason: a
filter in the due query would leave rows permanently due).

```
┌──────────────────────────────────────────────┐
│ NEW TICKET                                   │
│ XAU breakout daily review — 16 Aug 2026      │  <- spawned title, also the subject
│ FLONE-482 · Trading Desk                     │  <- key · project
│                                              │
│ Your recurring ticket is ready. Every        │
│ weekday.                                     │
│                                              │
│      [ Open FLONE-482 ]                      │
│ Or paste this link into your browser: …      │
└──────────────────────────────────────────────┘
```

The "never mail the actor" rule bends here exactly as it does for reminders,
and for the same recorded reason: a template you set up and assigned to
yourself arriving silently would defeat the point, and at spawn time the
actor is a cron tick. `notifyIssueAssigned` is deliberately *not* reused —
its copy says a person did something ("Dana assigned you…"), and nobody did.
Delivery is `await` via `renderAndSend`, not `queueMail`, because there is no
response to run behind.

An unassigned template sends nothing: the ticket on the board *is* the
notification surface, and anyone who wants a personal nudge for it can set a
reminder — that feature exists.

## 8. UI

One page per project: `/orgs/[orgSlug]/[workspaceSlug]/[projectKey]/recurring`,
a static segment beside `issues`, `boards` and `cycles` (project keys are
uppercase, so no collision is possible), with a row in the project's sidebar
group. Project-level and not organization-level because everything on the
form — labels, assignee default list, the landing state — is the project's.

```
Trading Desk / Recurring

Recurring tickets
Tickets this project creates for you on a schedule, pre-filled and assigned.

┌─ New recurring ticket ─────────────────────────────────────────────────────┐
│ Title                                                                      │
│ [ XAU breakout daily review                                              ] │
│ Each ticket is created as "Title — 16 Aug 2026".                           │
│                                                                            │
│ Description (Markdown)                                                     │
│ [ Deployed on: MT5 · account 1120                                        ] │
│ [ ## How it worked  ## Performance  ## Improvements                      ] │
│ This is the ticket's description, every time. Editing it here changes      │
│ every future ticket — it is the living checklist.                          │
│                                                                            │
│ First ticket                            Repeats                            │
│ [ 17/08/2026, 08:30            📅 ]     [ Every weekday          ▾ ]       │
│                                                                            │
│ Assign to                               Priority          Labels           │
│ [ Dana Reed (you)              ▾ ]      [ None      ▾ ]   [ xau-breakout ] │
│ They get an email each time. Optional.                                     │
│                                                                            │
│ [ Create recurring ticket ]                                                │
└────────────────────────────────────────────────────────────────────────────┘

Scheduled
┌────────────────────────────────┬─────────────────────┬───────────────┬──────┬───────────────────────┐
│ Recurring ticket               │ Next                │ Repeats       │ To   │ Manage                │
├────────────────────────────────┼─────────────────────┼───────────────┼──────┼───────────────────────┤
│ XAU breakout daily review      │ Mon 17 Aug, 08:30   │ Every weekday │ Dana │ Edit · Pause · Delete │
│ xau-breakout · set by you      │ (UTC+02:00)         │               │      │                       │
├────────────────────────────────┼─────────────────────┼───────────────┼──────┼───────────────────────┤
│ Momentum basket monthly review │ Paused              │ Every month   │ —    │ Edit · Resume · Delete│
│ momentum · set by Sam          │                     │               │      │                       │
└────────────────────────────────┴─────────────────────┴───────────────┴──────┴───────────────────────┘
```

Choices behind the wireframe:

- **Native controls throughout**, for the `ActionForm` restore-through-
  `form.elements` reason the reminders page records. The description is the
  same plain `<textarea>` every Markdown surface in the app uses.
- **Edit exists here** (unlike reminders) because the description is
  accumulated process, not four fields — delete-and-re-add would mean
  retyping it. One edit form, full replace. A schedule edit (first run,
  repeat) rewrites `anchorAt` and recomputes `nextRunAt`; a content edit
  touches neither.
- **Pause, don't delete.** Pause sets `nextRunAt` to null; Resume recomputes
  it from the anchor, strictly in the future. A strategy pulled from
  deployment keeps its refined checklist for the day it comes back.
- **Every time shown with its offset**, sorted soonest first, paused rows
  last.

## 9. Authorization

Every rule the app already has, unchanged. The parallel is the ticket itself:
automating what any member may do by hand is not an escalation.

| Action | Rule |
| --- | --- |
| See the page and every template in the project | any member — same as the issues list |
| Create | any member — they can create these tickets by hand today |
| Edit, pause, resume | any member — same as editing a ticket, and it is the assignee's escape hatch |
| Delete | creator, `ADMIN` or `OWNER` — same as deleting a ticket |

Client-supplied ids reaching the actions, each proved before use, all with
guards that already exist:

- the project — from the URL tuple, via the same loader every sibling project
  page uses;
- `assigneeId` — the `isOrgMember` rejection `createIssue` uses, and
  re-proved again at spawn time (§5);
- `labelIds` — `filterLabelsInProject`, capped at 20, as on `createIssue`.

The tick itself performs no authorization — like the reminders tick it acts
on rows that a member session already created, scoped by construction to that
member's project.

## 10. Files

New:

```
prisma/migrations/20260816000000_recurring_tickets/migration.sql
src/lib/recurring.ts                                   the tick (claim, resolve state, spawn, mail)
src/lib/ticket-insert.ts                               insertTicket, extracted from createIssue
src/app/(app)/orgs/[orgSlug]/[workspaceSlug]/[projectKey]/recurring/page.tsx
src/app/(app)/orgs/[orgSlug]/[workspaceSlug]/[projectKey]/recurring/actions.ts
                                                       create, update, setPaused, delete
docs/superpowers/specs/2026-08-16-recurring-tickets-design.md
```

Changed:

```
prisma/schema.prisma            + TicketRepeat, + RecurringTicket, + back-relations
                                  (Project, User ×2, Label)
src/lib/reminder-math.ts        + nextOccurrence, + weekday roll, + repeat labels,
                                  + the date-stamp formatter
src/lib/validation.ts           + recurringTitleSchema (1,160), + ticketRepeatSchema
src/lib/authz.ts                + recurringPath
src/lib/mailer.ts               + sendRecurringTicketMail
src/emails/templates.tsx        + RecurringTicketEmail
src/app/api/cron/reminders/route.ts   runs both ticks, second log line
src/app/(app)/orgs/[orgSlug]/[workspaceSlug]/[projectKey]/issue-actions.ts
                                createIssue calls insertTicket; behaviour unchanged
src/app/(app)/app-shell.tsx     + sidebar row under the project group
scripts/check-model.ts          + monthly clamp/no-drift, weekday roll, skip-not-replay
scripts/check-email.ts          + RecurringTicketEmail, both parts
```

## 11. Verification

What must pass before this is called done:

```
node scripts/check-model.ts    new checks: monthly anchored on the 31st runs
                               Jan 31 → Feb 28 → Mar 31 (clamp never sticks);
                               weekday roll crosses the date line correctly;
                               a week-long outage yields exactly one occurrence;
                               every result strictly after `after`
bun scripts/check-email.ts     RecurringTicketEmail renders both parts, link
                               survives text/plain
bun run typecheck              clean — including that the new enum is total in
                               every Record over it
bun run build                  clean; the recurring page dynamic
bunx prisma migrate diff       hand-written migration identical to the schema
```

And against a live database: create → tick → ticket appears in the first
Todo-type state with number, stamp, labels and due date; a second concurrent
tick spawns nothing; pause → tick → nothing; resume → next run strictly
future; `createIssue` before and after the extraction produces
byte-identical rows.

## 12. Deliberately skipped

| Skipped | Add it when |
| --- | --- |
| A Strategy entity (deployment target, parameters as data) | something *reads* it programmatically — today the template body carries it as prose |
| Automatic performance data on the ticket | the desk wants numbers attached before the human opens it — and the shape is already decided: Morrowell / an MT5-side script holding an MCP token calls the existing `create_comment` on the spawned ticket; zero new Flone code |
| Assignee rotation (round-robin the desk) | a real team asks — it is a policy question (skips? swaps?) before it is a column |
| Holiday calendars for `WEEKDAYS` | a market-holiday ticket annoys someone enough to say so — a calendar is a dependency this feature does not otherwise need |
| `ONCE` | never — that is the existing create-ticket form |
| Custom cadence (every N days, twice a month) | the four cadences visibly fail someone |
| A phone call when the ticket spawns | anyone asks — until then, a `CALL` reminder set beside the template does it |
| MCP tools to manage templates | an agent needs to *schedule* work, not just do it — spawned tickets and their comments are already fully reachable |
| Skipping a single occurrence ("markets closed today") | pausing-and-resuming around it hurts more than once a month |
| DST-stable spawn times | inherited from reminders — the same hour of drift, the same recorded fix |
