# Email — design

Date: 2026-08-06
Status: approved, implementing in one pass

Extends `SPEC.md`. Email is currently recorded there and in `README.md` as
deliberately absent; this document reverses that decision and supersedes it.
Two accepted risks it names — the registration enumeration oracle (§4.4, §8.2)
and the unreachable-account consequence of having no password reset — are
closed here. Everything else `SPEC.md` says about authorization, sessions,
passwords, rate limiting, CSRF and validation is unchanged and still binding.

The provider is [Resend](https://resend.com).

## 1. What gets built

Three things the app cannot currently do at all:

- **Password reset.** A forgotten password today means the account is
  permanently unreachable and an operator must edit the database by hand.
- **Invite a teammate who has no account.** `addMember` refuses with *"No
  account with that email. Ask them to sign up first."* — there is no way to
  onboard anyone.
- **Email verification**, which also closes the register-time enumeration
  oracle.

And four notifications: assignment, new comment, added-to-organization, and
MCP token created.

## 2. Transport

`src/lib/email.ts` — one `fetch` to `https://api.resend.com/emails`. No SDK.
The `resend` package is a dependency for what is a single POST with a bearer
header, and this repo already prefers the runtime's own primitives (`node:crypto`
for hashing and tokens) over packages that wrap them.

```ts
export async function sendMail(mail: Mail): Promise<void>
export function queueMail(mail: Mail): void
```

`Mail` is `{ to, subject, html, text }`. Every message carries both an HTML and
a plain-text body.

**`sendMail` never throws.** A non-2xx response logs
`[email] send_failed ref=<8 hex> status=<code>` and returns. Mail delivery is
not permitted to fail a Server Action: an issue that was assigned stays
assigned whether or not Resend was reachable. The log line carries a
correlation id and a status code and nothing else — never the recipient's
address, never a token, never a link, never the response body.

**`queueMail` is `after(() => sendMail(mail))`** from `next/server`. The send
happens after the response is flushed, so no user waits on an SMTP round-trip.
This is the native Next 15 mechanism; there is no queue, no worker, and no
retry. A dropped message is recoverable by the user — resend the verification,
request another reset link — which is why a retry layer is not worth its
weight here.

**Missing `RESEND_API_KEY` is not an error.** `sendMail` logs the subject, the
recipient and the full link to the console and returns. Local development
therefore needs no credentials and no account, and every link in every flow is
clickable from the dev server output. Logging the link is deliberate on this
branch and only on this branch; with a key configured it never runs.

### Templates

**Amended during implementation:** react-email, not hand-written HTML strings.

`react-email` v6 unified the components and the renderer into one package, so
this is a single dependency rather than the several the split packages used to
need, and `render()` produces the `text/plain` alternative from the same tree —
which removes the class of bug where the two parts drift.

Nine messages live in `src/emails/templates.tsx` over a shared shell in
`src/emails/layout.tsx` and a small Tailwind config in `src/emails/theme.ts`.
The scale is deliberately tiny: six type sizes, eight colours, one button.
`<Tailwind>` **drops unknown utility classes silently**, so a typo is invisible
until someone opens the mail — the theme file says so at the top.

Two rules the shell enforces so no template can forget them:

- every one-time link appears twice, as a button and as text, because a link
  that exists only inside a styled button is unreachable to anyone reading the
  plain-text part;
- there is no logo image. The app ships no `public/` directory, and a remote
  image that 404s renders as a broken-image icon — worse than the wordmark it
  would replace.

`bun run email:dev` opens react-email's preview server against `src/emails/`.

### Configuration

```
RESEND_API_KEY=            # absent in dev; see above
EMAIL_FROM="Flone <noreply@example.com>"
APP_URL=https://flone.example.com
```

`APP_URL` is **required in production and is never derived from the request**.
Building a verification or reset link out of the `Host` or `X-Forwarded-Host`
header is host-header poisoning: an attacker sets the header, the victim
receives a genuine-looking mail from the real system, and the link delivers the
one-time token to the attacker's domain. `src/lib/rate-limit.ts` already
documents why this codebase distrusts client-controllable proxy headers; the
same reasoning applies with much higher stakes to a link that carries a
credential. Booting production without `APP_URL` logs an error at first use and
sends nothing.

## 3. Tokens

One model, three purposes.

```prisma
enum EmailTokenPurpose {
  EMAIL_VERIFY
  PASSWORD_RESET
  INVITE
}

model EmailToken {
  id             String            @id @default(cuid())
  tokenHash      String            @unique
  purpose        EmailTokenPurpose
  /// The address the token was issued to. For INVITE there may be no User yet.
  email          String
  userId         String?
  /// INVITE only. Enforced by convention, not by the schema.
  organizationId String?
  role           Role?
  invitedById    String?
  expiresAt      DateTime
  usedAt         DateTime?
  createdAt      DateTime          @default(now())
}
```

Construction is identical to `Session` and for the same reasons: the raw token
is 256 bits from `randomBytes(32).toString('base64url')`, the database stores
only `sha256(token)` under a unique index, and verification is a lookup by key
rather than a comparison. A database leak yields no usable token. SHA-256
rather than scrypt is correct for the same reason it is correct for sessions —
a uniformly random 256-bit value has no dictionary to attack.

`userId` cascades from `User`, `organizationId` from `Organization`, so
deleting either takes its outstanding tokens with it.

Lifetimes: `EMAIL_VERIFY` 24 hours, `PASSWORD_RESET` 1 hour, `INVITE` 7 days.

### Single use

```ts
export async function consumeToken(raw: string, purpose: EmailTokenPurpose)
```

is one statement:

```ts
const { count } = await prisma.emailToken.updateMany({
  where: { tokenHash: hash(raw), purpose, usedAt: null, expiresAt: { gt: new Date() } },
  data: { usedAt: new Date() },
});
```

and succeeds only on `count === 1`. Single use is enforced by the database
inside one atomic statement, not by a read-then-write that two concurrent
clicks can both pass. The row is then read for its payload. Purpose is part of
the `where` clause, so a verification token cannot be presented to the reset
endpoint.

Issuing a new token of a purpose invalidates the user's outstanding ones of
that same purpose, so requesting a second reset link retires the first.

## 4. Schema changes to `User`

```prisma
emailVerified       DateTime?
notifyAssigned      Boolean @default(true)
notifyComments      Boolean @default(true)
notifyOrgMembership Boolean @default(true)
```

**The migration backfills `emailVerified = now()` for every existing row.** The
gate in §5 refuses sign-in to an unverified account; without the backfill,
deploying this locks out every account that already exists. This is the single
most dangerous line in the change.

Ids remain Prisma-side `cuid()`. No migration in this change may introduce a
database-side `gen_random_uuid()` default — the application's validation
schemas parse ids as cuids and a UUID-shaped row is rejected by every Server
Action that touches it.

## 5. Registration and sign-in

### Register

`src/app/(auth)/register/actions.ts` stops creating a session and stops
redirecting to `/`. It sends mail and returns a single result that is
byte-identical on both branches:

- **address is free** → create the user, issue `EMAIL_VERIFY`, send the
  verification mail;
- **address is taken** → create nothing, send *"someone tried to register with
  this address; you already have an account"* with links to sign in and to
  reset.

Both branches send exactly one email, return the identical literal, and the
page renders the same "check your inbox" screen. This is what actually closes
the oracle — a response that differs in *any* observable way, including
latency, reopens it.

**The taken branch must burn the same CPU as the free branch.** The free branch
spends roughly 250 ms in scrypt; the taken branch has nothing to hash, so
without care it answers a quarter-second sooner and the timing alone
distinguishes the two. It therefore calls `hashPassword` and discards the
result, exactly as `signIn` already calls `verifyPassword` against `DUMMY_HASH`
for an unknown email. That existing comment — *"Result deliberately discarded.
MUST NOT be removed"* — applies verbatim to the new call.

The first-user-becomes-admin transaction is unchanged.

### Sign in

`signIn` gains one branch, and its position matters: it comes **after** the
password is verified, never before. A verified password proves the caller owns
the account, so telling them the address is unconfirmed reveals nothing they
did not already know.

```
password wrong  → ERRORS.INVALID_CREDENTIALS   (unchanged, still the one literal)
password right, emailVerified === null
                → no session; "Confirm your email address to sign in."
                  and a fresh verification mail
password right, verified
                → unchanged
```

Session rotation, the rehash-on-login upgrade, expiry purging and the
email-bucket reset all stay where they are.

### `/verify`

- `?token=…` → `peekToken` renders a **confirm button**; pressing it consumes
  the token, sets `emailVerified`, mints a session and redirects to `/` (which
  sends a zero-org user on to `/orgs/new`).
- `?token=<bad>` → an explanation, plus the resend form.
- no token → a rate-limited resend form answering one generic literal whatever
  the address.

**Amended during implementation: confirming is a POST, not the GET.** The
original plan spent the token during the page load, which is simpler and wrong.
Corporate link scanners, Outlook Safe Links and mail-client prefetchers all
fetch URLs found in mail, so a one-time token would routinely be spent before
the human clicked — and the session cookie would be set on the scanner's
request rather than the reader's. Hence `peekToken` (read, do not spend)
alongside `consumeToken`. `/reset` and `/invite` were already forms and are
unaffected in shape, but they use `peekToken` for the same reason.

## 6. Password reset

**One route, `/reset`.** With no token it renders the request form; with a
token it renders the new-password form. Two URLs for two halves of one flow is
a second page, a second action and a second set of copy for no gain.

Requesting a link always returns *"If an account exists for that address, we
have sent a link."* — identical for a known and an unknown address. Unknown
addresses send nothing.

Completing a reset, in order:

1. `consumeToken(raw, PASSWORD_RESET)`;
2. hash the new password (`passwordSchema`, unchanged — minimum 12 characters,
   no composition rules);
3. write the hash;
4. **delete every `Session` row for that user.** A reset is the response to a
   suspected compromise; leaving the attacker's session alive defeats it. This
   revokes MCP tokens too, which is correct — they are the same `Session` rows.
5. set `emailVerified` if it is null. Clicking a link sent to the address
   proves the address as well as any verification mail would.
6. mint a fresh session and sign in.
7. send *"your password was changed"*.

Step 7 ignores every preference toggle. It is a security notice, not a
notification: it is the only way a user learns that someone else completed a
reset against their account.

### Rate limits

Added to `LIMITS` in `src/lib/rate-limit.ts`, consumed before any scrypt work,
same as the existing buckets:

| Bucket           | Limit | Window |
| ---------------- | ----- | ------ |
| `RESET_EMAIL`    | 3     | 1 hour |
| `RESET_IP`       | 10    | 1 hour |
| `VERIFY_RESEND`  | 3     | 1 hour |

The accepted risk recorded in `SPEC.md` §8.1 — counters are per-process and
reset on redeploy — applies to these exactly as it does to the login buckets,
and is unchanged.

## 7. Invitations

`addMember` in `src/app/(app)/orgs/[orgSlug]/settings/actions.ts` splits on
whether the address has an account. Authorization is untouched: `requireUser`,
then `requireOrgBySlug`, then `requireRole(ctx, ADMIN)`, exactly as now.

- **Account exists** → create the membership as today, then mail *"you were
  added to <org>"*, gated on `notifyOrgMembership`.
- **No account** → issue an `INVITE` token carrying `organizationId`, `role`
  and `invitedById`; mail the invitation; return `ok('Invitation sent.')`.

The `NO_ACCOUNT` failure literal is deleted along with the oracle it documented
— the two branches are no longer distinguishable from the outside.

### `/invite?token=…`

Renders the organization name and who invited you, then takes a name and a
password. On submit: create the user with `emailVerified` already set (the link
proved the address), create the membership with the role stored on the token,
consume the token, sign in.

**This path bypasses `isRegistrationOpen()`.** An admin inviting a specific
address is an explicit per-address grant, and it is the only way a closed
instance can ever onboard anyone. The registration flag governs open public
signup, which is what it was built for.

Two races, both benign:

- The address registered independently between invite and accept. Create the
  membership against the existing user and send them to sign in; do not touch
  their password.
- Two invitations to the same address, both accepted. The
  `(userId, organizationId)` unique index makes the second a `P2002`, which is
  treated as success.

Organization settings grows a pending-invitations list — address, role,
inviter, expiry — with revoke and resend. Revoking is a delete.

The MCP `add_member` tool inherits all of this without changing: it calls this
same Server Action. Its tool description and the `README.md` role table need
updating to say so.

## 8. Notifications

`src/lib/mailer.ts` holds every sender and the recipient resolution.

**Amended during implementation: it must not be a `'use server'` module, and
nothing in it may be re-exported from one.** Next turns every export of a
`'use server'` file into a directly addressable POST endpoint. Putting
`sendVerification(userId, name, email)` in `register/actions.ts` — the obvious
place, and where it was first written — would have published an open mail
relay: any caller, unauthenticated, could send this instance's mail to any
address. Actions import from `mailer.ts`; nothing in `mailer.ts` is an action.

| Event             | Hook                                  | Gate                  |
| ----------------- | ------------------------------------- | --------------------- |
| Assigned an issue | `createIssue`, `setIssueAssignee`     | `notifyAssigned`      |
| New comment       | `createComment`                       | `notifyComments`      |
| Added to an org   | `addMember`                           | `notifyOrgMembership` |
| MCP token created | `createMcpToken`                      | none — security mail  |

Assignment has exactly **two** write points, not four: `assignIssue` and the
MCP `update_ticket` tool both delegate to `setIssueAssignee`, and `updateIssue`
does not touch `assigneeId`. Hooking the two writes covers every path,
including MCP, without a hook per caller.

Comment recipients are the issue's creator, its assignee, and every prior
comment author, deduplicated.

Two rules are applied once, inside `notify.ts`, and hold for every message:

- **Never mail the actor.** Assigning an issue to yourself, or commenting on
  your own, sends nothing.
- **Never mail an unverified address.** `emailVerified === null` is excluded
  from every recipient set. The app does not send to addresses nobody has
  confirmed.

Delivery is immediate, one message per event. Digests are not built: they need
a scheduler, and this app deliberately has none — cycles are generated lazily
on read precisely so that no cron exists.

### Preferences

A new `/account` page holds the three toggles and one Server Action.

`/tokens` is not the place for them. It is the MCP access page, its copy is
about credentials, and mail preferences would be an unrelated second concern on
it.

## 9. Files

**New**

```
src/lib/email.ts                  transport, queueMail, link building
src/lib/email-token.ts            issue / peek / consume / revoke / list
src/lib/mailer.ts                 every sender + recipient resolution
src/emails/theme.ts               Tailwind config for email
src/emails/layout.tsx             shell, card, button, quote
src/emails/templates.tsx          the nine messages
src/components/auth-shell.tsx     extracted so /invite can reuse it
src/app/(auth)/verify/            page + actions
src/app/(auth)/reset/             page + actions (both halves)
src/app/invite/                   layout + page + actions
src/app/(app)/account/            page + actions
scripts/check-email.ts
prisma/migrations/20260806000000_email/
```

**`/invite` sits outside the `(auth)` group, not in it.** That group's layout
redirects anyone carrying a session to `/`. An invitation is opened by someone
who already has an account at least as often as by someone who does not — a
colleague invited to a second organization clicks the same link — and under
`(auth)` that click would land silently on the dashboard with the invitation
unaccepted and nothing explaining why. Hence `AuthShell`, shared by both
layouts, and the session redirect only in one of them.

**Modified**

```
prisma/schema.prisma
src/app/(auth)/register/actions.ts        hard gate
src/app/(auth)/login/actions.ts           unverified branch
src/app/(app)/orgs/[orgSlug]/settings/    invite path + pending list
src/app/(app)/orgs/[orgSlug]/[projectKey]/issue-actions.ts
src/app/(app)/orgs/[orgSlug]/[projectKey]/issue/[ticketNumber]/actions.ts
src/app/(app)/tokens/actions.ts
src/lib/rate-limit.ts                     three buckets
src/lib/validation.ts                     token schema
src/lib/mcp.ts                            add_member description
.env.example, README.md, SPEC.md
```

## 10. Verification

`bun run check:email`, in the existing `check:*` idiom, asserting the things
that fail *silently* — no error, no stack trace, no failing page, just a
message never sent or sent somewhere wrong:

- `sendMail` with no `RESEND_API_KEY` neither throws nor opens a socket;
- a key present but `EMAIL_FROM` or `APP_URL` missing sends nothing, rather
  than sending a real message with a broken link;
- a configured instance posts exactly one well-formed request carrying both the
  HTML and the plain-text part;
- a 500, a network error and a timeout are all swallowed;
- links come from `APP_URL`, tolerate a trailing slash, and URL-encode the
  token;
- all nine templates render both parts, and **every link survives into the
  plain-text part** — the one that rots quietly when a template is edited;
- `consumeToken` succeeds exactly once under two *concurrent* attempts, and
  rejects expired, already-spent, and wrong-purpose tokens.

The token group needs a database and is **skipped, not failed**, without one,
the same way `mcp:smoke` skips the `admin_*` tools for a non-admin token. The
script also has to stub `server-only`: running under `--conditions=react-server`
would satisfy that import but then `react-dom/server` refuses to load, and
`render()` needs it. The real boundary enforcement is `check:boundary`.

## 11. Documentation

`README.md` currently lists *"email of any kind"*, password reset, and email
verification under **"Not included, on purpose"**, and its security section
states that hiding whether an address is registered *"requires sending email,
which is out of scope"*. `SPEC.md` §4.4 and §8.2 record the same as accepted
risk, and the header comment in `register/actions.ts` repeats it.

All four are wrong the moment this ships and are rewritten as part of the
change, not after it. The README's *"no third-party services"* claim in its
opening paragraph becomes *one* third-party service, named.
