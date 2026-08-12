# Reminder phone calls — design

Date: 2026-08-12
Status: implemented in one pass

Extends `2026-08-11-reminders-design.md`. Everything that document says about
the schema, the compare-and-swap, the cron trigger and the email template is
unchanged and still binding. This feature adds one enum, one column on
`Reminder`, four on `User`, one separate deployment, and one section on
`/account`.

## 1. What gets built

A reminder can arrive as an **email**, a **phone call**, or **both**. When the
call connects it reads the reminder aloud and hangs up.

The number is set by its owner on `/account` and confirmed by a call that
speaks a six-digit code. Nothing else. No SMS, no voicemail detection, no
"press 1 to snooze", no call transcripts, no per-call delivery status.

### What this deliberately does not touch

Email reminders behave exactly as before. `Reminder.channel` defaults to
`EMAIL`, the migration backfills nothing, and every row scheduled before this
feature is byte-identical after it runs — so no existing reminder starts
phoning anybody. With `VOICE_URL` unset the feature is simply off and the app
is the one described in the previous document.

## 2. Why a separate service

The telephony lives in `services/voice`, deployed on its own. Three reasons,
in the order they actually matter:

**Credential isolation.** The Twilio account SID and auth token are a payment
instrument — anyone holding them can place calls billed to this account. They
now exist only in a process that renders no HTML, runs no user code, holds no
session and talks to no database.

**Provider swap per region.** A US number dialling an Indian mobile is subject
to carrier filtering and DND rules that a local provider is not. Replacing
Twilio with Exotel for `+91` is a change to one file in one deployment rather
than a change to the app.

**Nothing telephonic on the request path.** A hanging provider cannot block a
web request, because no web request ever waits on this service.

### The seam: a dumb pipe

```
web (cron tick)                         services/voice
  claim row (compare-and-swap)  ──────► POST /call {to, say}  ──► Twilio
  ^ stays in the app                    ^ stateless, no DB
```

The voice service knows a phone number and a sentence. It does not know what a
reminder is.

**This is the decision the whole design turns on.** The tempting alternative —
give the voice service its own database connection and let it read due
reminders — puts two services in a race over one table, requires a second copy
of the schema, and duplicates the claim logic that guarantees at-most-once
delivery. That is more coupling than the monolith had, wearing the costume of a
microservice. The claim stays next to the row it swaps.

### What that costs

A network hop that can fail. The schedule is already advanced before the call
is attempted (unchanged from the email design), so a failed call is a **lost**
reminder, never a duplicated one. That trade was already made for email and it
matters more here: a duplicated email is annoying, a duplicated 3am phone call
is an uninstall.

## 3. Schema

```prisma
enum ReminderChannel { EMAIL  CALL  BOTH }

model Reminder {
  channel ReminderChannel @default(EMAIL)
}

model User {
  phone              String?     // E.164, set only by its owner
  phoneVerified      DateTime?   // the exact counterpart of emailVerified
  phoneCodeHash      String?     // sha256, cleared on the FIRST attempt
  phoneCodeExpiresAt DateTime?
}
```

**`BOTH` is one row, not two.** A row is what the scheduler claims, and one
claim covering an email and a call keeps them a single occurrence. Two rows
would be two claims, two schedules and two things to delete.

**`phone` is not unique.** Uniqueness reads like a protection and provides
none — it only stops a second account claiming a number already claimed, which
is not the attack — while breaking the ordinary case of a shared handset.

**No index on `phone`.** Nothing queries by it, exactly as nothing queries by
`Ticket.assigneeId`.

## 4. The robocall problem, and the two rules that solve it

Any member may schedule a daily reminder **for themselves**. Without a control,
that is a robocall vector: register, type a stranger's number into your own
profile, schedule a 6am daily call, walk away.

Two rules, both enforced where they cannot be forgotten:

1. **A number is written only by its owner.** Every write is scoped to
   `session.id`; there is no id in any of those forms to forge. There is no
   admin screen for it and no field on the invite form.
2. **`phoneVerified` gates every call**, checked in the scheduler beside the
   existing `emailVerified` check — not at the call sites, so a new call site
   cannot skip it.

Saving a number always clears `phoneVerified`. Otherwise the check is a
formality: verify a number you own, then edit the field.

### One guess per call

The verification code is six digits, and the stored hash is **cleared on the
first attempt whether or not it matched**.

That single rule is what makes six digits sufficient with no attempt counter,
no rate limiter and no lockout table. A wrong answer costs the attacker an
entire new phone call to the real handset — a one-in-a-million retry that also
rings an alarm in the victim's pocket. The usual defence against a small code
space is machinery; here the machinery is unnecessary because the retry is
loud.

The success path is one `updateMany`: a read-then-write would leave a window in
which the code is spent but the number is not yet confirmed. A *malformed* code
burns nothing — it never reached the comparison, so a stray keystroke does not
cost a call.

`randomInt`, not `randomBytes(4) % 1_000_000`: 2^32 is not a multiple of a
million, so the modulo would make low codes slightly likelier. Six digits is a
small enough space that shaving bits off it matters.

## 5. TwiML injection — the one line not to delete

The spoken text is user-written and is interpolated into an XML document Twilio
**executes**. A reminder titled

```
hi</Say><Dial>+19005550000</Dial><Say>
```

becomes a premium-rate dial-out billed to this account. Same class as SQL
injection, with a phone bill attached.

`escapeXml` runs at the point of construction inside `services/voice`, not at
any call site, so a future caller cannot forget it. Numeric character
references (`&#60;`) rather than named entities, because those are valid in XML
with no DTD — which is what TwiML is. Asserted in `services/voice/check.ts`,
including that the payload survives as *text* (it is still spoken, just not
executed).

## 6. What a call says

```
Hello. This is a reminder from Flone.
Your reminder is. Post the deploy notes before standup.
This is about Engineering.
It was scheduled for you by Sam.
Again. Post the deploy notes before standup.
Goodbye.
```

**The title is spoken twice and never first.** Carriers routinely clip the
opening moment of a call while the audio path settles, so a script that leads
with the important part reliably loses it. The preamble exists to be
sacrificed; the repeat exists because a person who missed it cannot ask for a
replay. A call has no scrollback — this is why the wording is asserted in
`scripts/check-model.ts` rather than trusted.

Full stops between clauses are **timing, not punctuation**: Polly pauses at
one, and without them the clauses run together into a single unintelligible
breath. Verification codes are read digit by digit for the same reason —
`102345` spoken as a number is "one hundred two thousand three hundred
forty-five", which nobody can type back.

`Polly.Raveena` (Indian English) rather than the service default
`Polly.Joanna`, because it reads names, digits and times better for the numbers
this instance actually calls.

## 7. The scheduler

Unchanged in structure. After the claim:

```ts
let delivered = false;

if (CHANNEL_EMAILS[channel] && recipient.emailVerified) { await sendReminderMail(...); delivered = true }
if (CHANNEL_CALLS[channel]  && recipient.phoneVerified) { delivered ||= await placeCall(...) }

if (!delivered) result.skipped += 1;
```

**Email goes first, and that order is the point.** For a `BOTH` reminder the
cheap reliable channel leaves before the one that depends on a separate service
and a carrier. If the voice service is down, the email has already gone.

A refused call is not retried and not re-queued. Rewinding `nextRunAt` is how
one unreachable provider turns into the same person being phoned repeatedly
once it recovers.

`CHANNEL_EMAILS` and `CHANNEL_CALLS` are total `Record`s, so adding `SMS` to
the enum without a delivery rule is a type error rather than a channel that
silently reaches nobody. A check asserts no channel delivers nothing.

The tick log gains two counts: `claimed=3 emailed=2 called=1 skipped=1`. Still
counts only — never a title, an address, a number or an organization.

## 8. UI

**`/account`** gains a Phone number card: enter a number → it is stored
*unverified* and phoned → enter the six digits → confirmed. Change and Remove
sit below it.

No default country and no local formats. `8448417051` is a valid Indian mobile
**and** a valid US toll-free number; guessing between them silently phones a
stranger. Requiring the `+` makes the user say which they meant, once, at the
only moment they can. Spaces, dashes and brackets are stripped rather than
rejected — everybody pastes a number with them in.

**The reminders page** gains a *How* select (Email / Phone call / Email and
call) and a *How* column. The per-row warning that already existed for
unconfirmed email addresses now covers both destinations, and says which one is
missing:

```
⚠ Their phone number is not confirmed yet, so no call will be placed.
```

For a `BOTH` reminder that names the half that will not arrive, rather than
implying the whole thing is dead. The list shows `phoneVerified` only, **never
the number** — every member can read this page, and scheduling a reminder
should not hand out a roster of colleagues' phone numbers.

Removing your number leaves existing `CALL` reminders alone rather than
deleting or rewriting them: they keep showing with the warning. Silently
converting somebody's call reminders to email is a worse surprise than a
visible warning, and deleting them destroys work nobody asked to lose.

## 9. Files

New:

```
services/voice/index.ts          the service: escapeXml, parseCall, Bun.serve
services/voice/check.ts          12 asserts — injection and validation
services/voice/package.json      no dependencies, on purpose
services/voice/railway.json
services/voice/README.md         ops notes, including the three Twilio traps
src/lib/voice.ts                 the client. one fetch, never throws
prisma/migrations/20260812000001_reminder_calls/migration.sql
docs/superpowers/specs/2026-08-12-reminder-calls-design.md
```

Changed:

```
prisma/schema.prisma                    + ReminderChannel, + 1 and 4 columns
src/lib/reminder-math.ts                + CHANNEL_*, speechFor, speechForCode
src/lib/reminders.ts                    branch on channel after the claim
src/lib/validation.ts                   + e164Schema, phoneCodeSchema, channel
src/app/api/cron/reminders/route.ts     the log line
src/app/(app)/account/page.tsx          + phone card
src/app/(app)/account/actions.ts        + request, verify, remove
src/app/(app)/orgs/[orgSlug]/reminders/page.tsx     + How select, How column
src/app/(app)/orgs/[orgSlug]/reminders/actions.ts   + channel
scripts/check-model.ts                  + 11 channel and speech checks
package.json                            + check:voice
.env.example                            + VOICE_URL, VOICE_SECRET, Twilio notes
```

`@types/bun` was NOT added. The four lines of `Bun.serve` this uses are
declared inline — the alternative is a 40MB devDependency in the *web* app's
`package.json`, since that is where `tsc --noEmit` runs from.

## 10. Verification

```
bun run typecheck        clean
bun run check:boundary   clean
node scripts/check-model.ts   60 checks — 11 new (channels, speech)
bun scripts/check-email.ts    20 assertions — unchanged
bun run check:voice           12 checks — escaping, injection, E.164
```

**Not verified here: nothing was run against a live database or a live Twilio
account.** No Postgres was reachable, so `prisma migrate deploy`, an end-to-end
schedule → tick → ring, and the one-guess code burn were not exercised against
real rows. A manual call placed through the Twilio API during design did
connect and speak, which is the evidence that the TwiML shape and the account's
geo permissions are right.

## 11. Deliberately skipped

| Skipped | Add it when |
| --- | --- |
| SMS as a third channel | somebody asks — it is a different Twilio product and a fourth `CHANNEL_*` rule |
| Answering-machine detection | voicemail boxes start collecting reminders and somebody minds. Needs `MachineDetection` and therefore a webhook |
| Call status callbacks (answered / busy / failed) | a screen exists that would show it. Today nothing does, and it costs a public endpoint |
| Retry on no-answer | a missed call is worse than a late one, which it currently is not |
| Per-user "never call me" toggle | somebody is being called by a colleague they cannot reasonably ask to stop. Removing the number already works |
| Exotel or another regional provider | US-origin calls to `+91` prove unreliable in practice. One `if` in `services/voice`, which is why it is separate |
| A quiet-hours guard | somebody schedules 3am and regrets it. The timezone is already on the row |
| Rate limiting verification calls | the one-guess rule stops being enough, or the Twilio bill says otherwise |
