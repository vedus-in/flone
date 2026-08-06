# Flone — Canonical Implementation Spec

This document is the single source of truth. Three design lenses (data/authz, security,
UI/routing) were reconciled here. Where they disagreed, §7 records the conflict and the
resolution. **Implementers follow this document literally.** If this document and a lens
document disagree, this document wins. If something is not in this document, it is not built.

---

## 1. Scope

### In scope — the complete feature list

1. **Organizations** — the multi-tenant boundary. Created by any signed-in user, who becomes `OWNER`.
2. **Users** — email + password authentication (register, sign in, sign out). Name + email only.
3. **Memberships** — a user belongs to an organization with a role (`OWNER`, `ADMIN`, `MEMBER`).
   Owners/admins may add an existing user by email, change roles, and remove members.
4. **Projects** — many per organization. Name, uppercase key, optional description.
5. **Boards** — many per project. Name only. Every board is seeded with exactly three columns:
   `To Do`, `In Progress`, `Done`.
6. **Tickets** — title + description, a per-board sequential `number`, an optional assignee,
   movable between columns and reorderable within a column.
7. **Comments** — plain-text body on a ticket.

### Explicitly OUT of scope — do not build any of these

File uploads · notifications · email sending of any kind · password reset · password change ·
OAuth/SSO · labels · due dates · priorities · search · filtering · activity feeds · websockets ·
realtime · drag-and-drop · admin panel · billing · dark-mode toggle · i18n · analytics ·
markdown/rich text rendering · avatars · REST/JSON API · route handlers (`route.ts`) ·
`middleware.ts` · tests beyond what is explicitly asked for.

### Additionally CUT during reconciliation (a lens proposed it; it is out)

- **Column CRUD** (`createColumn` / `renameColumn` / `deleteColumn`) — see §7.6.
- **`leaveOrganization`** — see §7.7.
- **Nonce-based CSP + `middleware.ts`** — see §7.9.
- **Intercepting routes / modal ticket view**, **`useOptimistic`**, **`useTransition`** — see §7.11.
- **`?next=` return-to parameter** — open-redirect surface for one click of value.
- **Column reordering**, **ticket "move to index"** — see §7.4.

---

## 2. Final Prisma schema

`prisma/schema.prisma` — complete and copy-pasteable.

```prisma
generator client {
  provider      = "prisma-client-js"
  binaryTargets = ["native", "debian-openssl-3.0.x"]
}

datasource db {
  provider = "postgresql"
  url      = env("DATABASE_URL")
}

enum Role {
  OWNER
  ADMIN
  MEMBER
}

model User {
  id           String   @id @default(cuid())
  email        String   @unique
  name         String
  passwordHash String
  createdAt    DateTime @default(now())
  updatedAt    DateTime @updatedAt

  sessions        Session[]
  memberships     Membership[]
  createdTickets  Ticket[]     @relation("TicketCreatedBy")
  assignedTickets Ticket[]     @relation("TicketAssignee")
  comments        Comment[]
}

model Session {
  id        String   @id @default(cuid())
  tokenHash String   @unique
  userId    String
  user      User     @relation(fields: [userId], references: [id], onDelete: Cascade)
  expiresAt DateTime
  createdAt DateTime @default(now())

  @@index([userId])
  @@index([expiresAt])
}

model Organization {
  id        String   @id @default(cuid())
  name      String
  slug      String   @unique
  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt

  memberships Membership[]
  projects    Project[]
}

model Membership {
  id             String       @id @default(cuid())
  userId         String
  user           User         @relation(fields: [userId], references: [id], onDelete: Cascade)
  organizationId String
  organization   Organization @relation(fields: [organizationId], references: [id], onDelete: Cascade)
  role           Role         @default(MEMBER)
  createdAt      DateTime     @default(now())

  @@unique([userId, organizationId])
  @@index([organizationId])
}

model Project {
  id             String       @id @default(cuid())
  organizationId String
  organization   Organization @relation(fields: [organizationId], references: [id], onDelete: Cascade)
  name           String
  key            String
  description    String?
  createdAt      DateTime     @default(now())
  updatedAt      DateTime     @updatedAt

  boards Board[]

  @@unique([organizationId, key])
}

model Board {
  id        String   @id @default(cuid())
  projectId String
  project   Project  @relation(fields: [projectId], references: [id], onDelete: Cascade)
  name      String
  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt

  columns BoardColumn[]
  tickets Ticket[]

  @@index([projectId])
}

model BoardColumn {
  id        String   @id @default(cuid())
  boardId   String
  board     Board    @relation(fields: [boardId], references: [id], onDelete: Cascade)
  name      String
  position  Int
  createdAt DateTime @default(now())

  tickets Ticket[]

  @@index([boardId, position])
}

model Ticket {
  id          String      @id @default(cuid())
  boardId     String
  board       Board       @relation(fields: [boardId], references: [id], onDelete: Cascade)
  columnId    String
  column      BoardColumn @relation(fields: [columnId], references: [id], onDelete: Cascade)
  number      Int
  title       String
  description String?     @db.Text
  position    Int
  createdById String
  createdBy   User        @relation("TicketCreatedBy", fields: [createdById], references: [id], onDelete: Restrict)
  assigneeId  String?
  assignee    User?       @relation("TicketAssignee", fields: [assigneeId], references: [id], onDelete: SetNull)
  createdAt   DateTime    @default(now())
  updatedAt   DateTime    @updatedAt

  comments Comment[]

  @@unique([boardId, number])
  @@index([columnId, position])
}

model Comment {
  id        String   @id @default(cuid())
  ticketId  String
  ticket    Ticket   @relation(fields: [ticketId], references: [id], onDelete: Cascade)
  authorId  String
  author    User     @relation(fields: [authorId], references: [id], onDelete: Restrict)
  body      String   @db.Text
  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt

  @@index([ticketId, createdAt])
}
```

### Schema notes (binding)

- **Index set is final.** No standalone index on `Project.organizationId`, `Ticket.boardId`, or
  `Membership.userId` — each is already the leading column of a composite unique, so a second
  index is pure write cost. No index on `Ticket.createdById`, `Ticket.assigneeId`, or
  `Comment.authorId` — nothing in scope filters by them.
- **Referential actions are final.** The tenant tree cascades
  (`Organization → Membership/Project → Board → BoardColumn/Ticket → Comment`, `User → Session`),
  so deleting an organization removes every row belonging to it. `Ticket.createdById` and
  `Comment.authorId` are `Restrict` (a user cannot be hard-deleted while authored content exists —
  correct, since no user-deletion flow is in scope and `Cascade` there would vaporize a team's work).
  `Ticket.assigneeId` is `SetNull`.
- **`position` is never unique-constrained.** It is a sort hint. See §6.7.
- Migrations are applied on Railway release/start with `bunx prisma migrate deploy`.

---

## 3. Authorization model

### The one rule

> **Access is always re-derived by walking up from the resource to its Organization, inside the
> Prisma `where` clause, using the `userId` read from the session — never from client input.**

Concretely, the membership predicate is part of the lookup, not a follow-up `if`:

```ts
prisma.ticket.findFirst({
  where: {
    id: ticketId,
    board: { project: { organization: { memberships: { some: { userId: session.id } } } } },
  },
  select: { /* … ticket + board + project + org + the caller's membership row … */ },
});
```

A missing resource and a resource in another tenant both produce `null` from the **same single
query** — identical result, identical shape, indistinguishable timing. There is no existence
oracle and no separate 403 to leak from.

### Hard prohibitions

1. **No bare-id lookups on tenant-scoped models.** Outside `src/lib/authz.ts`,
   `Organization`, `Membership`, `Project`, `Board`, `BoardColumn`, `Ticket`, and `Comment` must
   **never** be reached with `findUnique({ where: { id } })` or any `findFirst` / `count` /
   `aggregate` lacking a tenant predicate. Fetch through a `require*` helper, or via a nested
   `select`/`include` rooted at an already-authorized entity. Enforce in review; optionally add an
   ESLint `no-restricted-syntax` rule.
2. **No action trusts a client-supplied `userId`, `organizationId`, `projectId`, or `role`.**
   `orgSlug` / `projectKey` / `boardId` / `ticketId` may arrive from a form, but only as *lookup
   keys* that must survive the membership predicate. They are never identity.
3. **Authorization never lives in a layout or in middleware.** Layout redirects are UX. Server
   Actions are directly addressable POST endpoints not covered by the layout that rendered the
   form; every action re-derives the session itself as its first statement.
4. **No caching directives under the authenticated tree.** `export const revalidate`,
   `dynamic = 'force-static'`, and `unstable_cache` are banned under `(app)/`.
   `(app)/layout.tsx` sets `export const dynamic = 'force-dynamic'` as a belt-and-braces guard.

### `src/lib/authz.ts` — exact exported surface

```ts
import 'server-only';
import { Role } from '@prisma/client';
import type { ActionResult } from '@/lib/result';

/* ---------- context shapes ---------- */

export type SessionUser = { id: string; email: string; name: string; sessionId: string };

export type OrgRef     = { id: string; name: string; slug: string };
export type ProjectRef = { id: string; name: string; key: string; description: string | null };
export type BoardRef   = { id: string; name: string };
export type TicketRef  = {
  id: string; number: number; boardId: string; columnId: string;
  position: number; title: string; description: string | null;
  createdById: string; assigneeId: string | null;
};
export type CommentRef = { id: string; ticketId: string; authorId: string; body: string };

export type OrgCtx     = { user: SessionUser; org: OrgRef; role: Role };
export type ProjectCtx = OrgCtx     & { project: ProjectRef };
export type BoardCtx   = ProjectCtx & { board: BoardRef };
export type TicketCtx  = BoardCtx   & { ticket: TicketRef };
export type CommentCtx = TicketCtx  & { comment: CommentRef };

/* ---------- errors ---------- */

export type AuthzKind = 'UNAUTHENTICATED' | 'NOT_FOUND' | 'FORBIDDEN';
export class AuthzError extends Error {
  constructor(readonly kind: AuthzKind, message?: string);
}

/* ---------- identity ---------- */

/** Session user or throw AuthzError('UNAUTHENTICATED'). Wraps the cache()d readSession(). */
export function requireUser(): Promise<SessionUser>;

/** Memberships of the caller only. Used by `/` to dispatch and by the org picker. */
export function listUserOrgs(): Promise<Array<OrgRef & { role: Role }>>;

/* ---------- URL-tuple loaders (used by pages/layouts) ----------
   Every ancestor segment of the URL is a CONSTRAINT in the SAME query, so a
   mismatched ancestor yields null rather than needing a separate assertion. */

export function requireOrgBySlug(orgSlug: string): Promise<OrgCtx>;
export function requireProjectByKey(orgSlug: string, projectKey: string): Promise<ProjectCtx>;
export function requireBoardInPath(orgSlug: string, projectKey: string, boardId: string): Promise<BoardCtx>;
export function requireTicketInPath(
  orgSlug: string, projectKey: string, boardId: string, ticketNumber: number,
): Promise<TicketCtx>;

/* ---------- leaf-id loaders (used by Server Actions) ----------
   Each walks UP to the organization in one query and returns the whole chain. */

export function requireBoard(boardId: string): Promise<BoardCtx>;
export function requireTicket(ticketId: string): Promise<TicketCtx>;
export function requireComment(commentId: string): Promise<CommentCtx>;

/* ---------- intra-resource integrity guards ---------- */

/** MANDATORY before any write of Ticket.columnId (createTicket, moveTicket).
 *  boardColumn.findFirst({ where: { id: columnId, boardId } }) -> NOT_FOUND on mismatch. */
export function requireColumnInBoard(
  boardId: string, columnId: string,
): Promise<{ id: string; boardId: string; name: string; position: number }>;

/** MANDATORY before any write of Ticket.assigneeId. NOT_FOUND if the candidate
 *  has no Membership in this organization. */
export function assertOrgMember(organizationId: string, candidateUserId: string): Promise<void>;

/** Target membership for member-management actions, scoped to an already-authorized org. */
export function requireMembershipInOrg(
  organizationId: string, membershipId: string,
): Promise<{ id: string; userId: string; role: Role; user: { id: string; name: string; email: string } }>;

/* ---------- roles ---------- */

export const ROLE_RANK: Record<Role, number>;              // MEMBER 1, ADMIN 2, OWNER 3
export function atLeast(role: Role, min: Role): boolean;
/** throws AuthzError('FORBIDDEN') */
export function requireRole(ctx: { role: Role }, min: Role): void;
/** Author-or-privileged. throws AuthzError('FORBIDDEN'). Used for comments and ticket delete. */
export function requireAuthorOrRole(
  ctx: { user: SessionUser; role: Role }, authorId: string, min: Role,
): void;

/* ---------- path builders (revalidatePath / redirect inputs) ----------
   Always built from the upward walk; NEVER from a client-submitted path. */

export function orgPath(org: OrgRef): string;                                    // /orgs/acme
export function projectPath(org: OrgRef, p: ProjectRef): string;                 // /orgs/acme/ENG
export function boardPath(org: OrgRef, p: ProjectRef, b: BoardRef): string;      // /orgs/acme/ENG/<cuid>
export function ticketPath(org: OrgRef, p: ProjectRef, b: BoardRef, n: number): string;

/* ---------- adapters: the ONLY places AuthzError is translated ---------- */

/** RSC pages/layouts. UNAUTHENTICATED -> redirect('/login'); NOT_FOUND & FORBIDDEN -> notFound(). */
export function loadPage<T>(fn: () => Promise<T>): Promise<T>;

/** Server Actions. Maps AuthzError to a fixed literal; logs anything else server-side and
 *  returns ERRORS.UNEXPECTED. MUST re-throw Next control-flow errors:
 *    if (e && typeof e === 'object' && 'digest' in e && typeof (e as any).digest === 'string'
 *        && ((e as any).digest === 'NEXT_NOT_FOUND'
 *            || (e as any).digest.startsWith('NEXT_REDIRECT'))) throw e; */
export function runAction(fn: () => Promise<ActionResult>): Promise<ActionResult>;
```

### Role matrix (final)

| Capability | OWNER | ADMIN | MEMBER |
|---|---|---|---|
| Read everything in the org | ✅ | ✅ | ✅ |
| Create/edit/move tickets, create comments | ✅ | ✅ | ✅ |
| Edit/delete own comment | ✅ | ✅ | ✅ |
| Edit/delete anyone's comment | ✅ | ✅ | ❌ |
| Delete a ticket they did not create | ✅ | ✅ | ❌ |
| Create/rename/delete projects and boards | ✅ | ✅ | ❌ |
| Add members, remove members, set role to ADMIN/MEMBER | ✅ | ✅ | ❌ |
| Grant or revoke OWNER | ✅ | ❌ | ❌ |
| Act on an OWNER row (change role / remove) | ✅ | ❌ | ❌ |
| Rename the organization | ✅ | ✅ | ❌ |
| Delete the organization | ✅ | ❌ | ❌ |

Additional invariants enforced **inside the same transaction** as the write:
- The last remaining `OWNER` cannot be demoted or removed → `'An organization must have at least one owner.'`
- No one may change their own role, and no one may remove themselves.
- `Membership.role` defaults to `MEMBER`, so a forgotten field fails safe.

### Error taxonomy

| Kind | Page (`loadPage`) | Action (`runAction`) |
|---|---|---|
| `UNAUTHENTICATED` | `redirect('/login')` | `{ ok: false, error: ERRORS.UNAUTHENTICATED }` |
| `NOT_FOUND` — missing **or** not yours | `notFound()` | `{ ok: false, error: 'Not found.' }` |
| `FORBIDDEN` — role failure on a resource the caller can already see | `notFound()` | `{ ok: false, error: "You don't have permission to do that." }` |

`FORBIDDEN` never distinguishes anything the caller could not already observe, so it is safe to
give it a distinct action message while rendering identically to `NOT_FOUND` at the HTTP level.

---

## 4. Auth / session / password design

### 4.1 `src/lib/password.ts`

```ts
import 'server-only';
const N = 2 ** 16, R = 8, P = 1, KEYLEN = 64, SALTLEN = 16;
const MAXMEM = 128 * N * R * 2;                    // 134_217_728 — MANDATORY
const OPTS = { N, r: R, p: P, maxmem: MAXMEM } as const;
const scryptAsync = promisify(crypto.scrypt);
```

- **`maxmem` is not optional.** `128 * N * r = 64 MiB` exceeds Node's 32 MiB default and
  `crypto.scrypt` throws `ERR_CRYPTO_INVALID_SCRYPT_PARAMS`. Pass `OPTS` on **every** call.
- **Async only.** Never `scryptSync` — it blocks the event loop for ~250 ms per call.
- **Concurrency semaphore.** Module-level FIFO gate capping in-flight scrypt calls at **4**
  (`let active = 0; const queue: Array<() => void> = []`). 4 × 64 MiB ≈ 256 MiB is already most of a
  small Railway container; without the gate a handful of concurrent logins is an OOM kill.
- **Encoding:** `["scrypt", N, r, p, salt.b64, key.b64].join("$")` — exactly 6 `$`-separated fields.
  Base64 never contains `$`, so the delimiter is unambiguous. Stored as Prisma `String`.
- **Strict decoder `parseHash(encoded)`** returns `null` (never throws) unless *all* hold:
  `parts.length === 6`; `parts[0] === 'scrypt'`; `N`/`r`/`p` match `/^\d{1,7}$/` before `Number()`;
  `N` is a power of two in `[2**14, 2**17]`; `r ∈ [1,16]`; `p ∈ [1,4]`; `128*N*r <= MAXMEM`;
  `salt.length === 16`; `hash.length === 64`. The byte-length checks are load-bearing because
  `Buffer.from(x, 'base64')` silently skips invalid characters and truncates.
- **`verifyPassword(plain, encoded)`**: NFKC-normalize the plaintext, parse; on parse failure run
  one scrypt against `DUMMY_HASH` and return `false`. On success derive the candidate with
  `keylen := parsed.hash.length`, so the two buffers are equal-length **by construction** and
  `crypto.timingSafeEqual`'s `ERR_CRYPTO_TIMING_SAFE_EQUAL_LENGTH` throw is structurally
  unreachable. Never compare with `===`, `Buffer.compare`, or `.equals()`.
- **`needsRehash(encoded)`** → `true` when stored params differ from the current constants. On a
  successful login with `needsRehash`, re-hash the just-verified plaintext and update the row.
- **`DUMMY_HASH`** is a committed module constant produced once offline by hashing a random
  32-byte string with the current parameters. At import time:
  `if (needsRehash(DUMMY_HASH)) throw new Error('DUMMY_HASH params drifted');` — a pure parse, zero
  hashing cost, that fails the boot loudly if parameters change without regenerating the decoy.
- **Password rules:** `z.string().min(12).max(200)`. NFKC normalization happens **inside**
  `hashPassword`/`verifyPassword` only, never at the schema layer (so it cannot be applied on one
  path and forgotten on the other). **Never `.trim()` a password.** No composition rules, no
  denylist, no breach API.

### 4.2 `src/lib/session.ts`

```ts
import 'server-only';
export const SESSION_COOKIE =
  process.env.NODE_ENV === 'production' ? '__Host-session' : 'session';
export const SESSION_TTL_MS   = 30 * 24 * 60 * 60 * 1000;   // 30 days
export const REFRESH_AFTER_MS =      24 * 60 * 60 * 1000;   // refresh once >1 day has elapsed
```

- **Token:** `randomBytes(32).toString('base64url')` — 256 bits, 43 URL-safe chars.
- **Storage:** only `sha256(token)` as hex (64 chars) under the `@unique` index. Verification is
  `findUnique({ where: { tokenHash } })` — a lookup by key, never a comparison, so there is no
  timing surface and deliberately no constant-time compare. SHA-256 (not scrypt) is correct here:
  a 256-bit uniformly random value has no dictionary, and this runs on every request.
- **Cookie attributes:** `{ httpOnly: true, sameSite: 'lax', secure: NODE_ENV === 'production',
  path: '/', expires: expiresAt }` and **no `domain`** — exactly what `__Host-` requires, so the
  prefix is free. `cookies()` is async in Next 15: `const store = await cookies()`.
- **`readSession()`** — wrapped in React `cache()`. Reads the cookie, hashes, looks up the row,
  rejects when `expiresAt <= now` (and opportunistically deletes that row). Selects explicitly:
  `{ id, expiresAt, user: { select: { id, email, name } } }` — **never** `passwordHash`.
  When more than `REFRESH_AFTER_MS` has elapsed it extends `Session.expiresAt` in the DB.
  It **never** touches `cookies().set` — Next 15 forbids that during a Server Component render.
- **`touchSessionCookie()`** — called by `requireUser()` when invoked from a Server Action; re-issues
  the cookie with the refreshed `expires`. Cookie lifetime therefore refreshes on any mutation.
- **`createSession(userId)`** → `{ token, expiresAt }`; **`destroySession()`** →
  `deleteMany({ where: { tokenHash } })` then set the cookie to `''` with byte-identical attributes
  and `maxAge: 0`.
- **Rotation on login:** if the request already carries a session cookie,
  `deleteMany({ where: { tokenHash: sha256(presented) } })` first, then create a brand-new row and
  token. Multiple concurrent sessions per user are allowed; no cap.
- **Cleanup without a cron:** (a) `readSession` deletes the row it just found expired;
  (b) successful login runs `deleteMany({ where: { userId, expiresAt: { lt: now } } })`.
  Expiry is enforced on every read regardless, so cleanup is table hygiene, never a security control.

### 4.3 `src/lib/rate-limit.ts`

```ts
import 'server-only';
export function consume(key: string, limit: number, windowMs: number): boolean;
```

In-process fixed window over a `Map<string, { count: number; resetAt: number }>`. Memory is bounded
or the limiter is itself a DoS: sweep expired entries every 500th call, hard-cap 20 000 keys, and
evict in insertion order when full (`buckets.keys().next().value`).

| Bucket | Limit |
|---|---|
| `login:ip:<ip>` | 30 per 15 min |
| `login:email:<normalizedEmail>` | 10 per 15 min |
| `register:ip:<ip>` | 5 per hour |

Two non-negotiable details: **(a)** consume limits *before* the scrypt call, so a throttled request
costs microseconds instead of 250 ms of CPU; **(b)** consume the email bucket even when the email
does not exist, otherwise the presence of the throttle message becomes the enumeration oracle the
dummy hash exists to close. Clear the email bucket on successful login. Client IP: prefer
`x-real-ip`, fall back to the leftmost `x-forwarded-for` entry, else the constant `'unknown'`
(`headers()` is async).

### 4.4 Login enumeration resistance

```ts
const user = await prisma.user.findUnique({
  where: { email }, select: { id: true, passwordHash: true },
});
let ok = false;
if (user) ok = await verifyPassword(password, user.passwordHash);
else      await verifyPassword(password, DUMMY_HASH);   // result discarded, MUST NOT be removed
```

Exactly one DB round-trip and exactly one scrypt invocation on both branches. Every failure — zod
rejection, unknown email, wrong password, corrupt hash — returns the identical exported literal
`ERRORS.INVALID_CREDENTIALS = 'Invalid email or password.'`. The login form never surfaces per-field
zod messages; they are collapsed into that one string.

**Registration enumeration is accepted, not solved.** Hiding it requires the "we sent you an email"
pattern and email is out of scope. Registration returns a clear
`'An account with that email already exists.'` (mapped from Prisma `P2002` as well as the pre-check,
because the race is real), bounded by 5 registrations per IP per hour.

### 4.5 Email normalization

One shared schema in `src/lib/validation.ts`, used **identically** by register and login:

```ts
export const emailSchema = z.string().max(254).trim().toLowerCase().pipe(z.string().email());
```

`.max()` sits before the transforms so a 10 MB string is rejected before any work. Store and query
only the normalized form. Do **not** strip dots or `+tags`, and do not NFKC an email address.

### 4.6 CSRF: no token, and precisely why

No CSRF token and no double-submit cookie. Four independent layers already cover it:
`sameSite='lax'` omits the cookie on cross-site non-GET requests; Next compares `Origin` against the
forwarded `Host` on Server Action requests; a Server Action is only invocable by a POST carrying a
`Next-Action` header, which a cross-origin `<form>` cannot set (the action ID itself is **not** a
secret and is not the defense); and actions cannot be triggered by GET.

**Binding rule:** no state-changing mutation may occur on a GET path — not in a Server Component
render, not in `generateMetadata`, not in a layout. The one carve-out is the idempotent
`Session.expiresAt` extension in `readSession()` (§4.2), which changes nothing an attacker could
want. Any future `route.ts` invalidates this analysis — and route handlers are banned.

### 4.7 What must never be logged

Never, in any form: plaintext or normalized passwords, encoded hashes, raw session tokens, token
hashes, `Cookie`/`Set-Cookie` headers, or the raw `FormData` of a login/register action.
Concretely: Prisma client `log: ['error', 'warn']` in production and **never** `['query']` (the
query event payload includes bound params, i.e. every email); action catch blocks log a short code
plus a random correlation id, never `e.message` / `String(e)` / the input object; never put an email
in a redirect query string; never repopulate a password input's `defaultValue`; set
`autoComplete="email" | "current-password" | "new-password"` on the inputs.

### 4.8 `next.config.ts`

```ts
poweredByHeader: false,
reactStrictMode: true,
experimental: { serverActions: { bodySizeLimit: '512kb' } },
async headers() { return [{ source: '/:path*', headers: [ /* below */ ] }]; }
```

| Header | Value |
|---|---|
| `X-Content-Type-Options` | `nosniff` |
| `Referrer-Policy` | `strict-origin-when-cross-origin` |
| `X-Frame-Options` | `DENY` |
| `Strict-Transport-Security` | `max-age=63072000; includeSubDomains` (no `preload`) |
| `Permissions-Policy` | `camera=(), microphone=(), geolocation=(), payment=(), usb=()` |
| `Cross-Origin-Opener-Policy` | `same-origin` |
| `Content-Security-Policy` | `default-src 'self'; script-src 'self' 'unsafe-inline' 'unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'` |

The CSP is deliberately **not** nonce-based (see §7.9). `script-src` is therefore not XSS
protection; the load-bearing directives here are `base-uri 'none'` (blocks base-tag hijacking of
every relative script URL), `form-action 'self'` (an injected form cannot post credentials
off-origin), `object-src 'none'`, and `frame-ancestors 'none'`.

**Pin Next to the latest 15.x, minimum 15.2.3** (below that, CVE-2025-29927 allows a middleware
bypass via `x-middleware-subrequest`).

### 4.9 XSS posture

React escapes text children; `{comment.body}` needs zero sanitization. Make the ban mechanical:
ESLint `react/no-danger: 'error'`, `no-eval`, `no-new-func`. Render multi-line user text as plain
text inside an element styled `white-space: pre-wrap; overflow-wrap: anywhere;`. No markdown
renderer, no autolinker, no HTML sanitizer — the app never constructs HTML from user input.
Normalize `\r\n` → `\n` in the zod transform for `description` and `body`.

### 4.10 Shared validation primitives (`src/lib/validation.ts`)

```ts
export const RESERVED_SLUGS = new Set(['new', 'orgs', 'login', 'register', 'api', 'admin',
  'settings', 'static', '_next', 'favicon.ico', 'robots.txt', 'sitemap.xml', 'health']);

export const DEFAULT_COLUMNS = [
  { name: 'To Do', position: 0 },
  { name: 'In Progress', position: 1 },
  { name: 'Done', position: 2 },
] as const;

/** Single-line text. Rejects NUL and every other C0 control character.
 *  Postgres `text` cannot store a NUL byte: Prisma throws, and the result is a
 *  user-controlled 500 with an error digest. */
const CONTROL_CHARS = /[\u0000-\u001F\u007F]/;            // no newline allowed
export const safeText = (min: number, max: number) =>
  z.string().trim().min(min).max(max).refine((s) => !CONTROL_CHARS.test(s));

/** Multi-line text. Normalizes CRLF -> LF first, then bans every control char except \n. */
const CONTROL_CHARS_MULTILINE = /[\u0000-\u0009\u000B-\u001F\u007F]/;
export const safeMultiline = (min: number, max: number) =>
  z.string()
    .transform((s) => s.replace(/\r\n/g, '\n'))
    .pipe(z.string().trim().min(min).max(max)
      .refine((s) => !CONTROL_CHARS_MULTILINE.test(s)));

export const cuid = z.string().cuid();
export const emailSchema = /* §4.5 */;
export const slugSchema = z.string().trim().toLowerCase()
  .regex(/^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])$/)
  .refine(s => !RESERVED_SLUGS.has(s), 'That URL is not available.');
export const projectKeySchema = z.string().trim().toUpperCase().regex(/^[A-Z][A-Z0-9]{1,9}$/);
```

Length caps, final: user name 1–80 · org name 2–60 · project name 1–80 · project description 0–2000 ·
board name 1–80 · ticket title 1–200 · ticket description 0–10000 · comment body 1–5000.

### 4.11 `src/lib/result.ts`

```ts
export type ActionResult =
  | { ok: true; message?: string }
  | { ok: false; error: string; fieldErrors?: Record<string, string> };

export const ERRORS = {
  UNAUTHENTICATED:     'You are signed out. Please sign in again.',
  INVALID_CREDENTIALS: 'Invalid email or password.',
  NOT_FOUND:           'Not found.',
  FORBIDDEN:           "You don't have permission to do that.",
  RATE_LIMITED:        'Too many attempts. Try again in a few minutes.',
  UNEXPECTED:          'Something went wrong.',
} as const;
```

`error` must be one of these literals or a specific, closed, user-meaningful literal declared in the
action's own file (e.g. `'That key is already in use.'`). Typing it as a union is what makes
`error: e.message` a compile error rather than a discipline problem. Never return `String(e)`, a
Prisma message, or a Prisma error code. `redirect()` / `notFound()` throw control-flow errors — call
them **after** the try/catch closes, or re-throw digest errors (`runAction` does this).

---

## 5. App Router file tree

Ten pages. **Zero route handlers. No `middleware.ts`.**

```
prisma/
└─ schema.prisma

src/
├─ app/
│  ├─ globals.css                    Tailwind v4 entrypoint: imports ../styles/theme.css, custom variants
│  ├─ layout.tsx                     <html>/<body>, imports globals.css, metadata
│  ├─ error.tsx                      'use client' — fixed generic copy; never renders message or digest
│  ├─ not-found.tsx                  "Not found." + link home (also serves "not yours")
│  │
│  ├─ (auth)/
│  │  ├─ layout.tsx                  centered card shell; if a session exists -> redirect('/')
│  │  ├─ actions.ts                  register, signIn
│  │  ├─ login/page.tsx
│  │  └─ register/page.tsx
│  │
│  └─ (app)/
│     ├─ layout.tsx                  export const dynamic = 'force-dynamic';
│     │                              requireUser() or redirect('/login'); header + sign-out form
│     ├─ actions.ts                  signOut
│     ├─ page.tsx                    '/' dispatcher: 0 orgs -> /orgs/new, 1 -> that org, 2+ -> picker
│     │
│     └─ orgs/
│        ├─ new/
│        │  ├─ page.tsx              first-run vs. plain copy, driven by membership count
│        │  └─ actions.ts            createOrganization
│        │
│        └─ [orgSlug]/
│           ├─ layout.tsx            requireOrgBySlug -> notFound(); breadcrumb + org tabs
│           ├─ page.tsx              project grid + inline "New project" (<details>)
│           ├─ actions.ts            createProject
│           │
│           ├─ settings/
│           │  ├─ page.tsx           members table, roles, rename, danger zone
│           │  └─ actions.ts         addMember, changeMemberRole, removeMember,
│           │                        renameOrganization, deleteOrganization
│           │
│           └─ [projectKey]/
│              ├─ page.tsx           board list + inline "New board" + project settings panel
│              ├─ actions.ts         updateProject, deleteProject,
│              │                     createBoard, renameBoard, deleteBoard
│              │
│              └─ [boardId]/
│                 ├─ loading.tsx     3 skeleton columns
│                 ├─ page.tsx        THE BOARD — one query
│                 ├─ actions.ts      createTicket, moveTicket, reorderTicket
│                 │
│                 └─ [ticketNumber]/
│                    ├─ page.tsx     ticket detail + comment thread
│                    └─ actions.ts   updateTicket, assignTicket, deleteTicket,
│                                    createComment, updateComment, deleteComment
│
├─ lib/                              every file starts with `import 'server-only'` except result.ts
│  ├─ db.ts                          PrismaClient singleton, log: ['error','warn'] in production
│  ├─ password.ts                    §4.1
│  ├─ session.ts                     §4.2
│  ├─ authz.ts                       §3
│  ├─ rate-limit.ts                  §4.3
│  ├─ validation.ts                  §4.10  (server-only)
│  └─ result.ts                      §4.11  (types + literals; NOT server-only — client imports the type)
│
└─ components/
   ├─ submit-button.tsx              'use client' — useFormStatus; disables + "Saving…"
   ├─ inline-form.tsx                'use client' — useActionState wrapper; resets + refocuses on ok
   ├─ move-buttons.tsx               'use client' — useActionState + useFormStatus
   ├─ board-column.tsx               server
   ├─ ticket-card.tsx                server
   └─ empty-state.tsx                server
```

### URL shape (final)

```
/                                     dispatcher
/login  /register
/orgs/new
/orgs/[orgSlug]
/orgs/[orgSlug]/settings
/orgs/[orgSlug]/[projectKey]
/orgs/[orgSlug]/[projectKey]/[boardId]
/orgs/[orgSlug]/[projectKey]/[boardId]/[ticketNumber]
```

Org slugs live under `/orgs/`, so the only static segment a slug could shadow is `new` — a frozen,
one-element collision surface closed by `RESERVED_SLUGS`. The board segment is the raw cuid
(the schema gives `Board` no slug and no per-project unique name; inventing one is a schema change).
The project segment is the uppercase `key`; the ticket segment is the per-board `number`.

**Next 15 params are Promises.** Every page and layout destructures via
`const { orgSlug, projectKey } = await params`. `projectKey` is uppercased and `ticketNumber` is
parsed with `z.coerce.number().int().positive()` **before** reaching Prisma; a segment that fails to
parse calls `notFound()`. A query must never be built from an `undefined` segment — that would turn
the membership predicate into a match-anything filter.

### Board UI (final)

- **Move buttons, not drag-and-drop.** Each card is one `<form>`; the *submit button's* `name`/`value`
  carries the destination — plain HTML expressing N destinations with no hidden-input duplication:
  `<button name="toColumnId" value={next.id} aria-label={\`Move "\${title}" to \${next.name}\`}>→</button>`,
  plus `<button name="direction" value="up" formAction={reorderAction}>↑</button>`.
  `prev`/`next` are resolved **on the server** at render time from the column ordering; the client only
  echoes an id the server re-vets against `ticket.boardId` anyway.
- **One query per board render**: the `requireBoardInPath` findFirst, with
  `columns → tickets → assignee{ id, name } + _count.comments` selected.
- **Layout**: columns are a horizontal grid (`grid-auto-flow: column;
  grid-auto-columns: minmax(272px, 1fr); overflow-x: auto`) collapsing to `grid-auto-flow: row`
  under 720px. Each column is a `<section aria-labelledby>` wrapping an `<ol>`. The card body is an
  `<a>` to the ticket page and the move `<form>` is a **sibling**, never nested inside it.
- **Pending UI**: `useFormStatus()` only. Its `data` field identifies which button was pressed
  (`data.get('toColumnId')`), so exactly the pressed control spins and all four disable — which is
  also the double-submit guard. No `useTransition`, no `useOptimistic` anywhere.
- Every column carries a persistent bottom form (`<input name="title" placeholder="Add a card…">` +
  `SubmitButton`). With JS, `InlineForm` clears and refocuses the input on `{ ok: true }`.

### Empty states (final)

| State | Treatment |
|---|---|
| 0 orgs | `/` redirects to `/orgs/new` with first-run copy: "Let's set up your workspace", one **Name** field, slug shown as read-only helper text, `<details>` for "Advanced: choose a URL". |
| Org, no projects | Dashed panel, "No projects yet", create form already `open` and autofocused. Placeholders `Website Redesign` / key `WEB`. **MEMBER** sees "No projects yet — ask an owner or admin to create one" with **no form**. |
| Project, no boards | Only reachable by deleting every board. "No boards in WEB" + inline one-field form, gated to OWNER/ADMIN. |
| Board, no tickets | All three columns still render — the To Do → In Progress → Done structure *is* the explanation. First column shows a dashed "Nothing here yet" card and an autofocused add input; the others show a muted "Empty". A one-line hint below the board reads "Use ← and → on a card to move it between columns." and disappears once any ticket exists. |
| Column empty on a populated board | Just the persistent "Add a card…" input. No placeholder noise. |

Empty states must never dangle an action the viewer's role cannot perform. The UI branch is
politeness; the server action re-checks the role regardless.

---

## 6. Server Action contract

### 6.1 Universal rules

1. Every file begins with `'use server'`.
2. Every action has the signature
   `(prev: ActionResult | null, formData: FormData) => Promise<ActionResult>`
   and is bound with `useActionState(action, null)`. React's `<form action>` prop rejects
   value-returning functions; `useActionState` accepts them and degrades to a native POST with JS off.
3. **Literal first statement** of every action body is `const user = await requireUser();`
   (via `runAction`). An action whose first statement is not that is a review blocker.
4. Input is re-parsed with zod on every action, without exception.
5. Resources are resolved only through a `require*` helper. No bare `findUnique` on tenant models.
6. `revalidatePath(<concrete literal path>)` after every mutation, built from the upward walk via
   the path builders — **never** from a client-submitted path string.
7. `redirect()` is called **after** the try/catch closes, on the success path only.
8. Returned `error` values come from `ERRORS` or a closed literal declared in the same file.

### 6.2 `src/app/(auth)/actions.ts`

| Action | zod input | Authz / guards | Returns |
|---|---|---|---|
| `register` | `{ name: safeText(1,80), email: emailSchema, password: z.string().min(12).max(200) }` | public. `consume('register:ip:'+ip, 5, 1h)` first | tx: `User` + `Session`; set cookie; `revalidatePath('/', 'layout')`; `redirect('/')`. Duplicate email (pre-check **or** `P2002`) → `{ ok:false, error:'An account with that email already exists.' }` |
| `signIn` | `{ email: emailSchema, password: z.string().min(1).max(200) }` | public. Consume `login:ip` (30/15m) **and** `login:email` (10/15m) **before** any hashing; consume the email bucket even for unknown emails | Rotate any presented session; create `Session`; set cookie; purge that user's expired rows; clear the email bucket; `revalidatePath('/', 'layout')`; `redirect('/')`. Any failure → `{ ok:false, error: ERRORS.INVALID_CREDENTIALS }` — identical for zod failure, unknown email, wrong password, corrupt hash |

`register` does **not** create an organization — `/` routes a zero-org user to `/orgs/new` (§7.3).

### 6.3 `src/app/(app)/actions.ts`

| Action | zod input | Authz | Returns |
|---|---|---|---|
| `signOut` | none | any session (no-op if absent) | delete the `Session` row by `tokenHash`, clear the cookie, `revalidatePath('/', 'layout')`, `redirect('/login')` |

### 6.4 `src/app/(app)/orgs/new/actions.ts`

| Action | zod input | Authz | Returns |
|---|---|---|---|
| `createOrganization` | `{ name: safeText(2,60), slug: slugSchema.optional() }` | `requireUser()` | tx: `Organization` + `Membership{ role: OWNER }` → `redirect('/orgs/'+slug)`. Slug blank → derived from name via `slugify` (lowercase, `[a-z0-9-]`, collapsed dashes, ≤40 chars, fallback `'org'`); on collision append **4 random base36 chars**, up to 5 attempts. Slug typed explicitly → collision returns `{ ok:false, fieldErrors:{ slug:'That URL is taken.' } }` |

An incrementing `-2`/`-3` suffix is forbidden: it turns the global slug index into an enumeration
oracle for other tenants' organization names. Random suffixes remove the signal at zero cost.

### 6.5 `src/app/(app)/orgs/[orgSlug]/actions.ts`

| Action | zod input | Authz | Returns |
|---|---|---|---|
| `createProject` | `{ orgSlug: slugSchema, name: safeText(1,80), key: projectKeySchema.optional(), description: safeMultiline(0,2000).optional() }` | `requireOrgBySlug(orgSlug)` → `requireRole(ctx,'ADMIN')` | one tx: `Project` + `Board{ name:'Main' }` + `DEFAULT_COLUMNS` → `redirect(projectPath(...))`. Key blank → derived from name (first 3–4 alphanumerics, uppercased). `P2002` on `(organizationId, key)` → `{ ok:false, fieldErrors:{ key:'That key is already in use.' } }` |

`orgSlug` arriving in `FormData` is not a trust violation: it is a routing key, and
`requireOrgBySlug` re-proves membership before it is used for anything.

### 6.6 `src/app/(app)/orgs/[orgSlug]/settings/actions.ts`

All five open with `requireOrgBySlug(orgSlug)`.

| Action | zod input | Authz / guards | Returns |
|---|---|---|---|
| `addMember` | `{ orgSlug, email: emailSchema, role: z.enum(['ADMIN','MEMBER']) }` | `requireRole(ctx,'ADMIN')` | Look up an existing `User` by email; create `Membership`. Unknown email → `'No account with that email. Ask them to sign up first.'` Already a member → `'Already a member.'` `{ ok:true }` otherwise |
| `changeMemberRole` | `{ orgSlug, membershipId: cuid, role: z.nativeEnum(Role) }` | `requireRole(ctx,'ADMIN')`; `requireMembershipInOrg`; only OWNER may set **or** clear OWNER; ADMIN may not act on an OWNER row; may not change own role; last-OWNER guard inside the tx | `{ ok:true }` |
| `removeMember` | `{ orgSlug, membershipId: cuid }` | `requireRole(ctx,'ADMIN')`; `requireMembershipInOrg`; ADMIN may not remove an OWNER; refuses self; last-OWNER guard inside the tx | `{ ok:true }` |
| `renameOrganization` | `{ orgSlug, name: safeText(2,60) }` | `requireRole(ctx,'ADMIN')` | `{ ok:true }` |
| `deleteOrganization` | `{ orgSlug, confirmName: z.string() }` `.refine(confirmName === org.name)` | `requireRole(ctx,'OWNER')` | cascade delete → `redirect('/')` |

### 6.7 `src/app/(app)/orgs/[orgSlug]/[projectKey]/actions.ts`

| Action | zod input | Authz | Returns |
|---|---|---|---|
| `updateProject` | `{ orgSlug, projectKey, name: safeText(1,80), description: safeMultiline(0,2000).optional() }` | `requireProjectByKey` → `requireRole('ADMIN')` | `{ ok:true }` |
| `deleteProject` | `{ orgSlug, projectKey, confirmKey: z.string() }` `.refine(confirmKey === project.key)` | same | cascade → `redirect(orgPath(org))` |
| `createBoard` | `{ orgSlug, projectKey, name: safeText(1,80) }` | same | tx: `Board` + `DEFAULT_COLUMNS` → `redirect(boardPath(...))` |
| `renameBoard` | `{ boardId: cuid, name: safeText(1,80) }` | `requireBoard(boardId)` (walks board→project→org) → `requireRole('ADMIN')` | `{ ok:true }` |
| `deleteBoard` | `{ boardId: cuid }` | same | cascade → `redirect(projectPath(...))` |

### 6.8 `src/app/(app)/orgs/[orgSlug]/[projectKey]/[boardId]/actions.ts`

| Action | zod input | Authz / guards | Returns |
|---|---|---|---|
| `createTicket` | `{ boardId: cuid, columnId: cuid, title: safeText(1,200), description: safeMultiline(0,10000).optional() }` | `requireBoard(boardId)` → any role; **`requireColumnInBoard(board.id, columnId)`** | tx: `number = (max number on board) + 1`, `position = (max position in column) + 1`, `createdById = user.id`. Retry ≤ 3× **only** on `P2002` whose `meta.target` names the `(boardId, number)` constraint → `{ ok:true }` |
| `moveTicket` | `{ ticketId: cuid, toColumnId: cuid }` | `requireTicket(ticketId)` → any role; **`requireColumnInBoard(ticket.boardId, toColumnId)`** | Appends to the end of the target column: `columnId = toColumnId`, `position = (max in target) + 1`. No-op if already there → `{ ok:true }` |
| `reorderTicket` | `{ ticketId: cuid, direction: z.enum(['up','down']) }` | `requireTicket(ticketId)` → any role | In one tx: read the column's tickets in canonical order, swap the ticket with its neighbour, then write `position = i` for that **single column** (dense renumber of one column). Edge of column → `{ ok:true }` no-op |

### 6.9 `src/app/(app)/orgs/[orgSlug]/[projectKey]/[boardId]/[ticketNumber]/actions.ts`

| Action | zod input | Authz / guards | Returns |
|---|---|---|---|
| `updateTicket` | `{ ticketId: cuid, title: safeText(1,200), description: safeMultiline(0,10000).optional() }` | `requireTicket` → any role (MEMBER may edit tickets) | `{ ok:true }` |
| `assignTicket` | `{ ticketId: cuid, assigneeId: z.union([cuid, z.literal('')]) }` | `requireTicket`; **`assertOrgMember(ctx.org.id, assigneeId)`** unless `''` (which unassigns) | `{ ok:true }`; non-member → `ERRORS.NOT_FOUND` |
| `deleteTicket` | `{ ticketId: cuid }` | `requireTicket`; `requireAuthorOrRole(ctx, ticket.createdById, 'ADMIN')` | cascade deletes its comments → `redirect(boardPath(...))` |
| `createComment` | `{ ticketId: cuid, body: safeMultiline(1,5000) }` | `requireTicket` → any role; `authorId = user.id` from the session | `{ ok:true }` |
| `updateComment` | `{ commentId: cuid, body: safeMultiline(1,5000) }` | `requireComment` (walks comment→ticket→board→project→org); `requireAuthorOrRole(ctx, comment.authorId, 'ADMIN')` | `{ ok:true }` |
| `deleteComment` | `{ commentId: cuid }` | same | `{ ok:true }` |

Ticket-scoped mutations `revalidatePath` **both** the ticket page and its board.

### 6.10 Ordering invariants

- Canonical read order **everywhere**: `orderBy: [{ position: 'asc' }, { createdAt: 'asc' }, { id: 'asc' }]`.
  Duplicate positions therefore degrade to a stable, deterministic order rather than a rendering bug.
- `position` is a plain non-unique `Int`. Gaps are allowed and never compacted.
- Insert and cross-column move set `position = max + 1`. Only `reorderTicket` renumbers, and only
  the one column it touches, inside its transaction.
- `BoardColumn.position` uses the same scheme and is fixed at `0,1,2` for the seeded columns.

---

## 7. Decisions log — where the lenses disagreed

Numbering: **L1** = data/authz lens, **L2** = security lens, **L3** = UI/routing lens.

### 7.1 URL shape: root-level `[orgSlug]` vs. an `/orgs/` prefix — **resolved toward `/orgs/`**

L3 put the org slug at the root (`/acme/ENG/…`) and mitigated the collision with a `RESERVED_SLUGS`
denylist. L1 assumed `/orgs/<slug>`. **Resolved: `/orgs/[orgSlug]/…`.** With a root-level slug, the
denylist must anticipate every top-level route that will ever exist, and getting it wrong produces a
*silent, permanent* 404 for an organization that was created successfully — the worst kind of bug to
diagnose. Under `/orgs/`, the collision surface is frozen at exactly one static sibling (`new`), so
the denylist is provably complete rather than aspirational. The cost is one extra path segment.

### 7.2 Deep-link authorization: `assertParam` vs. ancestors-as-constraints — **resolved toward constraints**

L1 proposed authorizing the deepest id and then calling `assertParam(derived, fromUrl)` on each URL
ancestor. **Resolved: put every ancestor segment into the same `where` clause** (`requireBoardInPath`,
`requireTicketInPath`). This is strictly better: it is the same round-trip count, and a mismatched
ancestor yields `null` instead of relying on a developer remembering a follow-up assertion — the
exact failure mode L1 was trying to prevent. `assertParam` is **cut** from the authz surface.
It also resolves the fact that `projectKey` and `ticketNumber` are not ids, so "authorize the
deepest id" was under-specified for this URL shape.

### 7.3 Does registration create an organization? — **resolved toward "no"**

L1 created `User + Organization + Membership(OWNER) + Session` in one transaction at registration,
arguing that a user with no org is a broken state. L3 registered the user, then dispatched from `/`
to `/orgs/new`. **Resolved: L3.** L1's own decision log concedes the zero-org state must be handled
anyway (a user can be removed from their only org, or the org can be deleted), so L1's approach adds
a second org-creation code path without removing the first. One path, exercised on every signup, is
simpler and better tested than two. Registration stays a three-field form.

### 7.4 Ticket ordering: dense renumber + `toIndex` vs. append + swap — **resolved toward a hybrid**

L1: `moveTicket({ ticketId, toColumnId, toIndex })` with a full dense renumber of both columns under
`SELECT … FOR UPDATE`. L3: two actions — `moveTicket` appends to the end of the target column,
`reorderTicket` swaps `position` with the adjacent sibling — with no renumbering at all.
**Resolved: L3's two-action split, with one correction from L1.** Splitting removes `toIndex` from the
wire entirely, so there is no stale-index race to clamp and no `FOR UPDATE` needed. But L3's "swap
two `position` values" is *wrong when the two positions are tied* (which its own non-unique,
never-compacted scheme permits) — the swap becomes a silent no-op. So `reorderTicket` densely
renumbers **the single affected column** inside its transaction, which is always correct and touches
at most a few dozen rows. `moveTicket` still appends with `max+1` and never renumbers.
L1's third sort key (`id asc`) is adopted on top of L3's `[position, createdAt]`.
**Cut:** move-to-arbitrary-index, and column reordering.

### 7.5 Ticket `number` allocation — **agreement, with the optional hardening cut**

Both L1 and L3 specified `max(number)+1` inside `$transaction` with up to 3 retries on `P2002`.
L1 offered optional `SELECT id FROM "Board" WHERE id = $1 FOR UPDATE` to eliminate the race.
**Resolved: retry only, no `FOR UPDATE`.** It requires `$queryRaw`, and the retry already converts a
rare correctness-preserving failure into a rare extra millisecond. The retry must be keyed strictly
to the `(boardId, number)` constraint target — a blanket `P2002` retry would mask genuine unique
violations. `count()+1` is explicitly rejected (it collides immediately after any delete), as is a
`Board.ticketCounter` column (deviates from the agreed data model).

### 7.6 Column CRUD — **CUT entirely** (scope)

L3 specified `createColumn`, `renameColumn`, and `deleteColumn` (ADMIN+, refuse non-empty, refuse
the last column), arguing that a fixed set of three contradicts a schema with `position`.
L1 independently flagged that deleting a non-empty column cascades and destroys tickets with no undo.
**Resolved: cut.** The user's scope is "tickets movable across board columns" — not customizable
columns, and the instruction was "nothing else". Every board is seeded with `To Do / In Progress /
Done` and that is the whole column model. This deletes three actions, an ADMIN gate, the
delete-cascades-tickets risk, and the last-column risk in one stroke. `BoardColumn.position` remains
in the schema (it is in the locked data model) and is simply always `0,1,2`.

### 7.7 `leaveOrganization` — **CUT** (scope)

L3 included it, with a last-OWNER guard. **Resolved: cut.** It is not in the user's list, it
duplicates `removeMember`'s machinery, and it adds a self-lockout path. `removeMember` refuses to
act on the caller's own membership, so there is exactly one way a membership disappears and one
place the last-OWNER invariant lives.

### 7.8 Comment edit by ADMIN/OWNER — **ground truth taken literally**

L3 flagged that letting an admin *edit* (not just delete) another person's comment means altering
their words, and suggested delete-only as the stricter reading. **Resolved: follow ground truth
literally** — "may only edit/delete their OWN comment (or be ADMIN/OWNER)" applies to both verbs.
Flagged here so the user can tighten it to delete-only with a one-line change if they prefer.

### 7.9 `middleware.ts` and a nonce-based CSP — **CUT the middleware; keep static headers**

L2 wanted a `middleware.ts` whose only job is generating a per-request nonce and emitting a
`script-src 'nonce-…' 'strict-dynamic'` CSP. L3 wanted **no middleware file at all**.
**Resolved: no middleware.** Both lenses agree — emphatically — that middleware must never carry
authorization (Prisma cannot reach Postgres from the Edge runtime, and CVE-2025-29927 showed
header-driven chokepoints fail open), so the only question is whether a nonce CSP justifies the file.
It does not here: it adds a file, an environment branch for React Refresh's `'unsafe-eval'` in dev,
and a hard dependency on every future contributor threading the nonce correctly — in an app that
renders zero user-supplied HTML, has `react/no-danger` failing the build, and ships no third-party
scripts. The high-value directives (`base-uri 'none'`, `form-action 'self'`, `object-src 'none'`,
`frame-ancestors 'none'`) need no nonce and ship as static headers in `next.config.ts` (§4.8).
`script-src` is documented as **not** being XSS protection rather than pretending otherwise.

### 7.10 Rate limiting and the scrypt semaphore — **kept, over a strict scope reading**

Only L2 raised these. They are not features, they are the difference between "auth exists" and "auth
works": without the explicit `maxmem`, scrypt throws on 100% of calls; without the semaphore, four
concurrent logins can OOM-kill a small Railway container; without throttle-before-hash, the limiter
would amplify rather than mitigate. **Resolved: keep all three**, in ~60 lines total across
`password.ts` and `rate-limit.ts`. L2's three-bucket configuration is adopted unchanged.

### 7.11 Client-side state: `useOptimistic` / `useTransition` / modal ticket view — **all CUT**

L3 rejected `useOptimistic` on the board (it requires mirroring the entire ticket array client-side)
but left the door open for optimistic comment appends. **Resolved: cut that too.** `useFormStatus` is
the only pending primitive; there are exactly three `'use client'` files. Intercepting routes for a
ticket modal are also cut — they add `@modal` slots, `default.tsx`, and a soft/hard-navigation
divergence that breaks progressive enhancement, in exchange for one URL segment.

### 7.12 Password minimum length: 10 vs. 12 — **12**

L3 said `min(10)`, L2 said `min(12)` and built its brute-force argument on 12.
**Resolved: 12.** L2's argument (scrypt caps the process near ~15 guesses/second, which is only
comfortable against a 12-character floor) is the one that actually reasons about the number.

### 7.13 Email schema construction — **L2's ordering**

L1: `z.string().trim().toLowerCase().email().max(254)`. L2:
`z.string().max(254).trim().toLowerCase().pipe(z.string().email())`.
**Resolved: L2.** `.max()` must precede the transforms so a 10 MB string is rejected before any work
is done on it. Both agree on the substance (one shared schema, used identically by register and
login, so casing can never fork an account).

### 7.14 Slug collision suffix: `-2` vs. random — **random**

L3 auto-suffixed `-2`; L1 used 4 random base36 chars. **Resolved: L1.** `acme`, `acme-2`, `acme-3`
lets anyone probe how many organizations share a name — a free enumeration oracle across the tenant
boundary. Randomness removes the signal at zero cost. When the slug was typed explicitly, a collision
is a field error rather than a silent rename (L3's behaviour, kept).

### 7.15 Error handling style: `AuthzError` + adapters vs. direct `notFound()` — **adapters**

L1 had helpers throw `AuthzError` with `loadPage`/`action` adapters; L3 had helpers call `notFound()`
directly. **Resolved: L1's adapters.** `notFound()` inside a Server Action has ill-defined UX for a
form POST, so the helpers cannot call it directly and still be shared between pages and actions.
L1's requirement that the action adapter **re-throw** `NEXT_REDIRECT` / `NEXT_NOT_FOUND` digest
errors is adopted verbatim, *and* L3's structural rule is kept on top of it: `redirect()` is called
after the try/catch closes, on the success path only. Both, not either.

### 7.16 `FORBIDDEN` as a distinct kind — **kept, but indistinguishable on pages**

L2 collapsed everything into `NOT_FOUND`. L1 kept a third kind for role failures.
**Resolved: L1.** `FORBIDDEN` is only ever raised on a resource the caller has *already* been proven
able to see, so a distinct action message leaks nothing while being far better UX than "Not found."
when a MEMBER tries to delete a project. On the render path it still calls `notFound()`, so the two
are indistinguishable at the HTTP level, satisfying the ground-truth requirement.

### 7.17 Rolling session refresh — **all three converge; the split is made explicit**

All three lenses independently hit the same Next 15 constraint: `cookies().set()` is illegal during a
Server Component render. **Resolved:** `readSession()` (read path) extends `Session.expiresAt` in the
DB when more than a day has elapsed; `touchSessionCookie()` (action path) re-issues the browser
cookie. This is the one deliberate carve-out to "no mutation on a GET path" (§4.6), because extending
an expiry is idempotent and useless to an attacker.

### 7.18 Ticket delete permission — **L3's rule adopted**

Ground truth is silent. L3 proposed `createdById OR ADMIN OR OWNER`, mirroring the comment rule.
**Resolved: adopted.** It is the least surprising reading and prevents a MEMBER destroying another
member's work while keeping ticket *editing* open to every MEMBER, as ground truth requires.

### 7.19 `description` length cap: 10 000 vs. 20 000 — **10 000**

L2 said 10 000, L3 said 20 000. **Resolved: 10 000.** Arbitrary either way; the smaller bound is the
better default with a 512 kB action body limit, and it comes from the lens that reasoned about
request-body sizing.

### 7.20 `addMember` enumeration message — **specific message kept**

L1 recommended a generic message on add-member to avoid an account-existence oracle; L2 and L3
accepted the specific one. **Resolved: keep the specific message**
(`'No account with that email. Ask them to sign up first.'`). Because there is no email/invite flow,
a generic message makes the feature genuinely unusable — the admin would have no way to know why
nothing happened. The oracle is gated behind ADMIN membership in some organization, and registration
already leaks the same fact to anonymous users, so the marginal disclosure is zero.

---

## 8. Known risks accepted

Each of these is a conscious trade, not an oversight. The trigger to revisit is stated.

1. **In-process rate limiting resets on redeploy.** Counters live in one Node process; a redeploy,
   crash, or container restart zeroes every bucket, handing an attacker one fresh window.
   *Accepted* because scrypt itself is the real floor (~250 ms and 64 MiB per attempt, semaphore of
   4 ⇒ roughly 15 guesses/second process-wide even with the limiter off, which is not viable against
   a 12-character minimum), redeploys are operator-initiated, and Railway runs a single replica.
   **Revisit when:** scaling past one replica — at which point every limit silently multiplies by N
   and counters must move to a Postgres `LoginAttempt` table.

2. **Registration reveals whether an email is already registered.** Unavoidable without email
   sending, which is out of scope. Bounded at 5 registrations per IP per hour; login stays fully
   generic because login is what credential-stuffing bots actually spray.

3. **`addMember` is an account-existence oracle** for anyone holding ADMIN in any organization.
   Accepted (§7.20) — it is the price of an invite flow with no email.

4. **`x-forwarded-for` is client-controllable** if the proxy appends rather than replaces, so IP
   buckets can be rotated away. Mitigated by preferring `x-real-ip` and by treating the
   *email*-keyed bucket — which cannot be spoofed — as the account-takeover control.

5. **The email-keyed limiter enables targeted lockout**: someone who knows a colleague's address can
   burn 10 attempts every 15 minutes. Accepted: fixed window with automatic expiry, no permanent
   lockout, bucket cleared on successful login, and limits generous enough that typo recovery is
   unaffected.

6. **A read-only user is signed out at exactly 30 days.** Cookies cannot be re-issued during a
   render, so a user who never triggers a Server Action keeps a live DB session but an expiring
   cookie. In a Kanban app, mutations are frequent enough that this is effectively hypothetical, and
   the failure mode is a re-login prompt.

7. **`Ticket.boardId` and `Ticket.columnId` can diverge at the database level.** Nothing in the
   schema forces the column to belong to the board. The **only** enforcement is
   `requireColumnInBoard`, which must be present on 100% of writes touching `columnId` — there are
   exactly two (`createTicket`, `moveTicket`). A DB-level composite FK
   (`@@unique([boardId, id])` on `BoardColumn` + a hand-written composite FK) would make divergence
   impossible, but `prisma migrate dev` treats objects it cannot model as drift and emits `DROP`
   statements for them. Declined as a build-time footgun. **Revisit when:** the schema stops changing.

8. **Concurrent moves can produce duplicate `position` values.** Positions are non-unique and set to
   `max+1` without locking. Accepted because every read sorts
   `[position asc, createdAt asc, id asc]`, so a tie resolves deterministically and identically on
   every render. This is the deliberate trade against renumber-on-write contention.

9. **Concurrent `createTicket` on one board can fail with `P2002`.** Duplicates are impossible (the
   unique index guarantees it), but a spurious failure is possible under READ COMMITTED. Bounded to
   3 retries; `InlineForm` keeps the typed title in the input when the result is not `ok`, so a retry
   costs no re-typing.

10. **The no-JS path is functional but not equally informative.** Without JS, `useActionState` error
    returns are lost — the POST responds with the re-rendered page and the `{ ok:false, error }`
    string reaches no rendered element. Accepted for move/reorder (the re-rendered board shows the
    truth anyway); for auth and create forms the failure modes are re-derivable server-side.

11. **`style-src 'unsafe-inline'` remains** as a concession to Next's inlined critical CSS. There is
    no user-controlled styling anywhere in scope (authored Tailwind utilities and theme tokens only —
    no CSS-in-JS, no runtime-computed styles, nothing derived from user input), so
    the exploitable surface requires an HTML injection that React's escaping already prevents.

12. **`script-src` is not XSS protection** (§7.9). The compensating controls are: React escaping,
    `react/no-danger: 'error'` failing the build, no HTML ever constructed from user input, and
    `base-uri 'none'` / `form-action 'self'` / `object-src 'none'` limiting what an injection could do.

13. **`sameSite='lax'` is site-scoped, not origin-scoped.** A hostile app sharing the registrable
    domain would be treated as same-site. Mitigated by the `__Host-` cookie prefix (which blocks the
    cookie-injection half outright) and by keeping the app on a dedicated host.

14. **Expired `Session` rows accumulate** between opportunistic cleanups. Harmless — expiry is
    enforced on every read — and `@@index([expiresAt])` makes a manual sweep cheap if ever needed.

15. **No user deletion is possible** while a user has authored tickets or comments
    (`onDelete: Restrict`). Intentional: it makes account deletion loudly impossible rather than
    quietly catastrophic, and no user-deletion flow is in scope.

16. **Login timing equalization is approximate.** The DB round-trip differs slightly between an index
    hit and an index miss, and the decoy branch skips row hydration. The ~250 ms scrypt dominates the
    sub-millisecond delta by three orders of magnitude and network jitter exceeds the residual.

---

## 9. Review blockers (checklist)

An implementation is **rejected** if any of these is true:

- [ ] A Server Action whose first statement is not `requireUser()` (directly or via `runAction`).
- [ ] A `findUnique({ where: { id } })`, `findFirst`, `count`, or `aggregate` on `Organization`,
      `Membership`, `Project`, `Board`, `BoardColumn`, `Ticket`, or `Comment` without a tenant
      predicate, outside `src/lib/authz.ts`.
- [ ] A write to `Ticket.columnId` not preceded by `requireColumnInBoard`.
- [ ] A write to `Ticket.assigneeId` not preceded by `assertOrgMember`.
- [ ] Any action using a client-supplied `userId`, or scoping a query to a client-supplied
      `organizationId` / `projectId` without re-deriving it.
- [ ] `redirect()` or `notFound()` inside a `try`/`catch` that does not re-throw digest errors.
- [ ] `crypto.scrypt` called without an explicit `maxmem`, or `scryptSync` used anywhere.
- [ ] `passwordHash` or `Session.tokenHash` present on any object outside `lib/password.ts`,
      `lib/session.ts`, or a login action's local scope.
- [ ] `export const revalidate`, `dynamic = 'force-static'`, or `unstable_cache` under `(app)/`.
- [ ] `dangerouslySetInnerHTML`, a `route.ts`, or a `middleware.ts` anywhere in the tree.
- [ ] `e.message`, a Prisma error message, or a Prisma error code returned to the client.
- [ ] Prisma client configured with `log: ['query']` in production.
- [ ] `params` or `searchParams` read without `await`.
