# flone-voice

Places one call, speaks one sentence, hangs up.

Design: [`docs/superpowers/specs/2026-08-12-reminder-calls-design.md`](../../docs/superpowers/specs/2026-08-12-reminder-calls-design.md)

A separate deployment from the web app, and a **dumb pipe**: it knows nothing
about reminders, users or the database. Everything that decides *whether* to
call and *whom* to call stays in the app, next to the compare-and-swap that
makes a reminder fire at most once.

## API

```
POST /call
authorization: Bearer $VOICE_SECRET
content-type: application/json

{ "to": "+14155550100", "say": "Your reminder is ...", "voice": "Polly.Raveena" }
```

`202` — the provider queued the call. **Queued, not answered:** nothing here
learns whether a human picked up.
`400` — bad payload; the body names which field.
`401` — wrong or missing bearer.
`502` — the provider refused or was unreachable. Never retried.

`GET /health` returns `{ ok, configured }` and needs no credential. It reports
the *process*, not the configuration — a healthcheck that fails on a missing
variable turns a bad env var into a deploy that never goes live and therefore
never shows you its own logs.

## Environment

| Variable | |
| --- | --- |
| `TWILIO_ACCOUNT_SID` | console.twilio.com, starts `AC` |
| `TWILIO_AUTH_TOKEN` | same panel, click to reveal |
| `TWILIO_FROM` | a Voice-capable number you own, E.164 |
| `VOICE_SECRET` | must match the web app's `VOICE_SECRET` |
| `PORT` | set by Railway; defaults to `3001` |

With any of them unset the service answers `503` and places no call.

## Run it

```
bun index.ts          # serve
bun check.ts          # 12 asserts, no network, no credentials
```

From the repo root: `bun run check:voice`.

## Railway

A second service in the same project, root directory `services/voice`, and
**no public domain**. The web app reaches it at
`http://voice.railway.internal:3001` over the private network.

`VOICE_SECRET` can be a reference variable here (`${{voice.VOICE_SECRET}}` on
the web service) — the expansion problem documented for `CRON_SECRET` affects
*start commands* only, not environment variables.

## Three things that each cost a failed call to learn

**Geographic permissions are off by default.** Twilio blocks most international
destinations until you tick the country under **Voice → Settings → Geographic
Permissions**. The failure is error **21215**, which reads like a malformed
number rather than a permissions problem.

**Trial accounts only call verified numbers.** Add the destination under **Phone
Numbers → Manage → Verified Caller IDs** first (error **21219** otherwise), and
expect a spoken trial notice before your message.

**Do not test this by pasting curl into PowerShell.** PowerShell 5.1 strips the
quotes around `voice="Polly.Raveena"` on the way to a native `.exe`, so Twilio
receives `<Say voice=Polly.Raveena>` — invalid XML — and the call says *"an
application error has occurred"*. Nothing is wrong with the account. Use
`Invoke-RestMethod` with a hashtable body, or Git Bash, or just this service,
which builds the payload with `URLSearchParams` and never touches a shell.

## The one line not to delete

`escapeXml` in `index.ts`. The spoken text is user-written and is interpolated
into a document Twilio *executes*; without it a reminder titled
`hi</Say><Dial>+1900…</Dial><Say>` becomes a premium-rate dial-out billed to
this account. `check.ts` asserts it.
