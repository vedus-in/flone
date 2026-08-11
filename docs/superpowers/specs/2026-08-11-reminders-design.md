# Scheduling and email reminders — design

Date: 2026-08-11
Status: implemented in one pass

Extends `SPEC.md` and `2026-08-06-email-design.md`. Everything those documents
say about authorization, sessions, validation, the Server Action contract and
the mail transport is unchanged and still binding — this feature adds one table,
one page, one route handler and one email template, and touches no existing
behaviour.

## 1. What gets built

A person can schedule an email nudge:

- **once, daily or weekly** — the recurrence honoured exactly, never duplicated;
- **about one project, or about the whole organization** — the scope arrives
  with the message, so the reason for the nudge is in the nudge;
- **for themselves or for a teammate** — the designated recipient gets the mail.

Nothing else. There is no snooze, no edit, no digest, no per-issue reminder, no
"remind me when this is due". Each is a different feature and each is cheaper to
add later than to carry unused.

### What this deliberately does not touch

`Ticket`, `Board`, `WorkflowState`, `Cycle`, `Label`, `Comment`, `Membership`
and every existing query over them are untouched. The migration creates one enum
and one table, backfills nothing and rewrites nothing, so every existing
organization and project is byte-identical after it runs. A reminder cannot
change what any existing view shows, because nothing in the feature writes to
anything an existing view reads.

## 2. Schema

One table, one enum. `prisma/migrations/20260811000000_reminders/`.

```prisma
enum ReminderRepeat { ONCE  DAILY  WEEKLY }

model Reminder {
  id              String         @id @default(cuid())
  organizationId  String         // Cascade — the tenant tree
  projectId       String?        // null = organization scope. Cascade.
  title           String
  repeat          ReminderRepeat @default(ONCE)
  nextRunAt       DateTime?      // null = not scheduled (a fired one-time reminder)
  lastSentAt      DateTime?
  tzOffsetMinutes Int            @default(0)
  recipientId     String         // Cascade
  createdById     String         // Cascade
  createdAt       DateTime       @default(now())
  updatedAt       DateTime       @updatedAt

  @@index([nextRunAt])        // the scheduler's whole query
  @@index([organizationId])   // the list page
}
```

Three decisions worth the words:

**Scope is a nullable foreign key, not an enum.** `projectId == null` means
organization scope. A separate `scope` column would be a value that can disagree
with the id sitting beside it, and there is no third scope to make that risk
worth taking. `projectId` cascades rather than nulling: deleting a project must
not silently promote its reminders to organization-wide ones.

**`nextRunAt` is nullable and doubles as the on/off flag.** Null means "not
scheduled". The due query is `nextRunAt <= now`, which never matches null, so a
one-time reminder that has already fired needs no second `active` boolean to be
skipped — and it stays on the page as *Sent* rather than vanishing.

**Both `User` relations cascade.** Unlike `Ticket.createdById`, a reminder is a
notification setting rather than authored content; there is nothing here worth
blocking a user delete over.

Indexes follow the rule stated at the top of `schema.prisma`: only columns
something actually filters on. `projectId`, `recipientId` and `createdById` get
none — nothing queries by them, exactly as nothing queries by
`Ticket.assigneeId`.

## 3. Time

The hard part of this feature is not recurrence, it is timezones — and the
cheapest correct answer is to avoid carrying a timezone database.

`<input type="datetime-local">` submits a wall clock with no zone: `09:00` and
nothing more. A hidden field carries `Date.prototype.getTimezoneOffset()` beside
it, and the action converts once:

```
instant   = wall clock + offset      // 09:00 Berlin (offset -120) -> 07:00Z
wall clock = instant - offset
```

The offset is stored on the row. That is what lets the **cron process**, the
**server-rendered page** and the **email** all print the same string — the time
the person actually picked — with no `Intl` timezone lookups and no guessing
from a server's own clock. All formatting uses a fixed locale and `timeZone:
'UTC'` on the already-shifted instant, so server render and browser hydration
cannot disagree (the same rule `formatDay` follows in `src/lib/issues.ts`).

**Accepted ceiling (`ponytail:` in `reminder-math.ts`).** The offset is a
snapshot, not a zone. A daily reminder created in summer keeps summer's offset,
so it arrives an hour off after the clocks change. The upgrade path is written
down where the code is: store the IANA zone from
`Intl.DateTimeFormat().resolvedOptions().timeZone` and recompute the wall time
per occurrence.

## 4. Recurrence, and why it cannot duplicate

`src/lib/reminder-math.ts` — pure, import-free, exercised by
`scripts/check-model.ts` under plain Node. Same split as `cycle-math.ts`.

```ts
export function nextRun(from: Date, repeat: ReminderRepeat, after: Date): Date | null {
  const step = STEP_MS[repeat];         // ONCE: 0, DAILY: 24h, WEEKLY: 7d
  if (step === 0) return null;
  const periods = Math.max(1, Math.floor((after.getTime() - from.getTime()) / step) + 1);
  return new Date(from.getTime() + periods * step);
}
```

Two properties, both asserted:

1. **The result is always strictly after `after`.** A next run still in the past
   would be picked up by the very next tick — a mail loop, one copy per tick.
2. **Missed occurrences are skipped, not replayed.** A scheduler down for three
   days sends *one* nudge, not three in three minutes. A reminder is a nudge;
   four stale nudges are worse than one late one.

`STEP_MS` is a total `Record<ReminderRepeat, number>`, so adding `MONTHLY` to the
enum without a cadence is a type error rather than a reminder that silently
stops.

## 5. The scheduler

`src/lib/reminders.ts` — one function, called only by the route handler.

```ts
for (const reminder of due) {                       // due: nextRunAt <= now, take 100
  const following = nextRun(reminder.nextRunAt, reminder.repeat, now);

  const claim = await prisma.reminder.updateMany({
    where: { id: reminder.id, nextRunAt: reminder.nextRunAt },   // <- compare-and-swap
    data:  { nextRunAt: following, lastSentAt: now },
  });
  if (claim.count === 0) continue;                  // another tick already has it

  if (!reminder.recipient.emailVerified) continue;  // advanced, not sent
  await sendReminderMail({ ... });                  // never throws
}
```

**The one invariant: a given occurrence produces at most one email.** It is held
by the conditional update, not by a lock. Two ticks overlapping — a slow send, an
over-eager cron, a redeploy that leaves the old container running a moment
longer — both read the row, but only one write can still match the old
`nextRunAt`, so only one sends.

The schedule is therefore advanced **before** the message goes out. That is the
deliberate trade: the failure mode is a lost reminder, never a duplicated one. A
person who did not get a nudge asks about it; a person who got the same nudge
nine times turns the feature off.

Two details that are easy to get wrong:

- **The unverified-address rule is applied after the claim.** Filtering
  unconfirmed recipients out of the *due query* would leave those rows
  permanently due and re-read by every tick forever. They are claimed and
  advanced, just not sent.
- **The batch is bounded at 100.** A backlog costs a fixed number of provider
  calls per tick and drains over several, instead of hanging one request until
  it times out.

## 6. The trigger

`POST /api/cron/reminders`, bearer-authenticated with `CRON_SECRET`:

```
curl -fsS -X POST -H "authorization: Bearer $CRON_SECRET" \
  https://flone.example.com/api/cron/reminders
```

A route rather than a worker process, because the mail layer is Next's: the
templates are TSX and `src/lib/email.ts` is `server-only`, so a standalone script
would need a second copy of the render path. One HTTP call also means the
schedule can come from a Railway cron service, a GitHub Actions workflow or an
uptime pinger with no code change.

- **With `CRON_SECRET` unset the endpoint is closed, in every environment** —
  503. An unauthenticated trigger is a way for anyone to make the instance send
  mail, and "it is only development" is how that reaches production.
- The comparison is constant-time over SHA-256 digests of both sides, so
  `timingSafeEqual` never sees a length mismatch (which would itself leak the
  secret's length).
- `GET` is the same handler. It mutates, which GET should not — but the
  credential is required either way and the work is idempotent, and the
  alternative is an operator discovering at 3am that their pinger has been
  collecting 405s all week.
- Logs are counts only: `[cron] reminders claimed=3 sent=2 skipped=1`. Never a
  title, an address or an organization.

Railway deployment: add a second service from the same repo, start command set
to the `curl` above, cron schedule `* * * * *`. It shares the project's
variables.

## 7. Email

One template, `ReminderEmail`, added to `src/emails/templates.tsx` beside the
other nine. **The reminder's own text is the subject line** — no `Reminder:`
prefix, which would push the part the person wrote out of a phone's preview pane.

```
┌──────────────────────────────────────────────┐
│ REMINDER                                     │
│ Post the deploy notes before standup         │  <- title, also the subject
│ Wed 12 Aug, 09:00 (UTC+02:00) · Engineering  │  <- when, in their clock · scope
│                                              │
│ Dana Reed scheduled this reminder for you.   │  <- omitted when it is your own
│ Every day.                                   │
│                                              │
│      [ Manage reminders ]                    │
│ Or paste this link into your browser: …      │  <- link survives text/plain
│                                              │
│ Delete it on that page to stop it.           │
└──────────────────────────────────────────────┘
```

Two rules from the email design bend here, both on purpose and both noted at the
call site:

- **Never mail the actor** does not apply. A reminder you set for yourself is the
  entire point, and at send time the actor is a cron tick.
- **`await`, not `queueMail`.** `queueMail` uses Next's `after()`, which runs
  behind a response; the scheduler has no browser waiting and wants the send
  finished before the process is free to exit. `renderAndSend` was extracted from
  `queueMail` for this — one render path, two callers, no behaviour change for
  the existing nine messages.

**Never mail an unconfirmed address** does still apply, enforced in the
scheduler.

No new preference toggle on `/account`. A reminder is explicitly asked for by
somebody, and the recipient can delete it themselves — a switch to mute a thing
you can delete is a second way to say the same thing.

## 8. UI

One page: `/orgs/[orgSlug]/reminders`, beside `challenges` at organization level
(`reminders` is added to `RESERVED_SLUGS`, so no workspace can shadow it). It
carries a sidebar row under **Organization**.

**One page, not two.** Scope is a field on the form rather than a second route
under every project, so "what have we got scheduled?" has a single answer and the
project-scoped and organization-scoped cases share every line of UI.

```
Organizations / Acme / Reminders

Reminders
Scheduled emails for you or a teammate, about this organization or one of its projects.

┌─ New reminder ─────────────────────────────────────────────────────────────┐
│ The email arrives at the time you pick, in your own timezone.              │
│                                                                            │
│ Remind about                                                               │
│ [ Post the deploy notes before standup                                   ] │
│ This becomes the subject line, so write it the way you want to read it.    │
│                                                                            │
│ First send                             Repeats                             │
│ [ 12/08/2026, 09:00            📅 ]    [ Every day              ▾ ]        │
│                                        A recurring reminder keeps sending  │
│ About                                  Send to                             │
│ [ Acme (whole organization)    ▾ ]     [ Dana Reed (you)         ▾ ]       │
│ Shown in the email, so the reason      Anyone in Acme. They can delete it  │
│ for the nudge arrives with it.         themselves.                         │
│                                                                            │
│ [ Schedule reminder ]                                                      │
└────────────────────────────────────────────────────────────────────────────┘

Scheduled
┌──────────────────────────────────┬──────────────────────┬───────────┬──────┬────────┐
│ Reminder                         │ Next                 │ Repeats   │ To   │ Manage │
├──────────────────────────────────┼──────────────────────┼───────────┼──────┼────────┤
│ Post the deploy notes            │ Wed 12 Aug, 09:00    │ Every day │ You  │ Delete │
│ ENG — Engineering · set by you   │ (UTC+02:00)          │           │      │        │
├──────────────────────────────────┼──────────────────────┼───────────┼──────┼────────┤
│ Renew the TLS certificate        │ Mon 31 Aug, 08:00    │ Once      │ Sam  │ Delete │
│ Acme · set by you                │ (UTC+02:00)          │           │      │        │
├──────────────────────────────────┼──────────────────────┼───────────┼──────┼────────┤
│ Quarterly board pack             │ Sent                 │ Once      │ Ali  │ Delete │
│ Acme · set by Sam · last sent …  │                      │           │      │        │
│ ⚠ Their email address is not confirmed yet, so nothing will be delivered.  │        │
└──────────────────────────────────┴──────────────────────┴───────────┴──────┴────────┘
```

Choices behind the wireframe:

- **Native controls throughout** — `<input type="datetime-local">` and
  `<select>`. Not taste: `ActionForm` restores a rejected submit by writing
  through `form.elements`, which only reaches real form controls, so a
  listbox-backed select would silently disagree with what the form submits. The
  native picker is also keyboard-accessible everywhere and needs no library.
- **Every time is shown with its offset.** A bare `09:00` is a guess.
- **Sorted soonest first, sent ones last** (`nulls: 'last'`) rather than
  disappearing, so a one-time reminder can be *seen* to have run.
- **The unconfirmed-address warning.** It is the feature's one silent failure —
  scheduled, advanced, never delivered. Saying so in the row is the difference
  between "broken" and "obvious".
- **No edit.** A reminder is four fields; delete and re-add cannot leave a
  half-changed row for the scheduler to find.

## 9. Authorization

Every rule the app already has, unchanged:

| Action | Rule |
| --- | --- |
| See the page and every reminder in the org | any member — same as the member roster |
| Schedule one, for anyone in the org | any member — a nudge is not access |
| Delete | creator, **recipient**, or ADMIN |

Two client-supplied ids reach the action and both are proved before use:

- `scope`, when it is a project id → `requireProjectInOrg(org.id, projectId)`,
  new, sitting with the other intra-resource guards in `authz.ts`. A forged id
  cannot attach a reminder to another tenant's project, and cannot be used to
  probe whether one exists.
- `recipientId` → `assertOrgMember(org.id, recipientId)`, the same guard issue
  assignment already uses. This cannot become a way to send mail to an arbitrary
  address.

The recipient can delete matters: without it, a colleague could schedule a daily
email you had no way to stop.

## 10. Files

New:

```
prisma/migrations/20260811000000_reminders/migration.sql
src/lib/reminder-math.ts                              pure: recurrence + local time
src/lib/reminders.ts                                  the tick (claim, then send)
src/app/api/cron/reminders/route.ts                   the trigger
src/app/(app)/orgs/[orgSlug]/reminders/page.tsx       list + form
src/app/(app)/orgs/[orgSlug]/reminders/actions.ts     create, delete
src/app/(app)/orgs/[orgSlug]/reminders/tz-offset-field.tsx   8 lines of client
docs/superpowers/specs/2026-08-11-reminders-design.md
```

Changed:

```
prisma/schema.prisma          + Reminder, + ReminderRepeat, + 4 back-relations
src/lib/validation.ts         + 'reminders' reserved, + 4 schemas
src/lib/authz.ts              + requireProjectInOrg, + remindersPath
src/lib/email.ts              renderAndSend extracted from queueMail
src/lib/mailer.ts             + sendReminderMail
src/emails/templates.tsx      + ReminderEmail
src/app/(app)/layout.tsx      + remindersHref
src/app/(app)/app-shell.tsx   + sidebar row
scripts/check-model.ts        + 10 recurrence and timezone checks
scripts/check-email.ts        + ReminderEmail, both branches
.env.example                  + CRON_SECRET
```

## 11. Verification

```
node scripts/check-model.ts   43 checks — 10 new, all reminder arithmetic
bun scripts/check-email.ts    20 assertions — ReminderEmail renders both parts,
                              keeps its link in text/plain
bun run typecheck             clean
bun run check:boundary        clean
bun run build                 clean; /orgs/[orgSlug]/reminders and
                              /api/cron/reminders both dynamic
```

`bunx prisma migrate diff --from-empty --to-schema-datamodel` was diffed against
the hand-written migration: identical, column for column.

**Not verified here: nothing was run against a live database** — no Postgres was
reachable in this environment, so `prisma migrate deploy`, an end-to-end
create → tick → email, and the concurrent-tick claim were not exercised against
real rows. The recurrence and timezone arithmetic they rest on is covered by the
checks above.

## 12. Deliberately skipped

| Skipped | Add it when |
| --- | --- |
| Monthly / custom cadence | someone asks — the date math for "the 31st of every month" is where this stops being three lines |
| Editing a reminder | rescheduling by delete-and-add starts to hurt |
| A note/body beside the title | people start cramming context into 200 characters |
| Per-user "mute reminders" toggle | somebody is being reminded by a colleague they cannot reasonably ask to stop |
| Retry / dead-letter for a failed send | delivery failures show up in the Resend dashboard and matter |
| DST-stable recurrence (store the IANA zone) | the hour of drift after a clock change is noticed |
| A per-organization cap on reminders | anyone abuses it — every row needs a member session to create |
| Reminders attached to an issue or a due date | that is a different feature, not this one grown |
