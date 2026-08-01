# Kanban

A small, multi-tenant Kanban application. People sign up with an email address and a password, create or join an organization, and work inside it: an organization holds projects, a project holds boards, a board holds three fixed columns (To Do, In Progress, Done), and tickets move between those columns and carry a comment thread. The organization is the tenant boundary, and it is enforced on every single read and write by walking up from the resource to its organization inside the database query itself — there is no place where one tenant can observe another. It is deliberately small: the whole app is ten pages, no JSON API, and no third-party services.

`SPEC.md` in this repository is the canonical specification. If the code and this README disagree, read the spec.

## Features

- **Organizations** — the tenant boundary. Any signed-in user can create one and becomes its `OWNER`.
- **Users** — register, sign in, sign out. Name, email, and password; nothing else.
- **Memberships** — `OWNER`, `ADMIN`, and `MEMBER` roles. Owners and admins can add an existing user by email, change roles, and remove members.
- **Projects** — many per organization, with a name, an uppercase key (`ENG`, `WEB`), and an optional description.
- **Boards** — many per project. Every new board is seeded with the three columns `To Do`, `In Progress`, `Done`.
- **Tickets** — title, optional description, a per-board sequential number, an optional assignee. Moved between columns and reordered within a column using buttons on the card.
- **Comments** — plain-text comments on a ticket. You can edit and delete your own; admins and owners can moderate any.

### Not included, on purpose

File uploads, notifications, email of any kind, password reset, password change, OAuth/SSO, labels, due dates, priorities, search, filtering, activity feeds, realtime/websockets, drag-and-drop, an admin panel, billing, a dark-mode toggle, i18n, analytics, markdown rendering, avatars, and any public REST/JSON API. Board columns are fixed at three and cannot be added, renamed, or deleted.

## Stack

| Piece | Why it is here |
| --- | --- |
| **Next.js 15 (App Router)** | Server Components render every read on the server, so query results never travel to the browser and authorization cannot be bypassed client-side. |
| **React Server Actions** | Every mutation is a server function; this removes the entire REST surface, and with it a whole class of missing-auth-check bugs on endpoints. |
| **TypeScript (strict)** | The action return type is a closed union, which makes leaking a raw error message a compile error rather than a discipline problem. |
| **Prisma + PostgreSQL** | The tenant check lives inside the `where` clause of a typed query, so "missing" and "not yours" are literally the same code path. |
| **Bun** | Package manager and runtime, for install and boot speed; there is no Node-specific dependency in the tree. |
| **zod** | Every Server Action re-parses its own `FormData`, without exception, before anything reaches the database. |
| **node:crypto** | Password hashing (scrypt) and session tokens use the runtime's own crypto — no native build steps, so deploys cannot break on a compiler toolchain. |
| **Plain CSS** | One `globals.css` with custom properties. No Tailwind, no component library, no CSS-in-JS, nothing to keep up to date. |

## Local development

### Prerequisites

- [Bun](https://bun.sh) 1.3 or newer.
- A PostgreSQL 14+ server you can reach, and an empty database for this app.

### Setup

Install dependencies (this also runs `prisma generate`):

```bash
bun install
```

Create your environment file from the template:

```bash
cp .env.example .env
```

Then edit `.env` and point `DATABASE_URL` at your database. It is the only variable the app requires.

Create the database schema. On a fresh checkout this generates the initial migration under `prisma/migrations/` and applies it:

```bash
bun run db:migrate
```

Start the dev server on [http://localhost:3000](http://localhost:3000):

```bash
bun run dev
```

Register an account at `/register`, and you will be sent straight to the organization-creation screen. There is no seed script and no default user.

### Scripts

| Command | What it does |
| --- | --- |
| `bun run dev` | Next.js dev server. |
| `bun run build` | `prisma generate` followed by `next build`. |
| `bun run start` | Serves the production build. |
| `bun run db:migrate` | `prisma migrate dev` — creates and applies a migration from schema changes. Local only. |
| `bun run db:deploy` | `prisma migrate deploy` — applies existing migrations. Used in production. |
| `bun run typecheck` | `tsc --noEmit`. |

## Deploying to Railway

One service running the Next.js app, plus one Postgres database in the same project. `railway.json` in the repo root already pins the builder, build command, start command, restart policy, and health check, so the dashboard needs no build configuration.

**Commit your migrations first.** The start command runs `prisma migrate deploy`, which only *applies* migrations that already exist in `prisma/migrations/` — it never creates them. Run `bun run db:migrate` locally and commit the generated folder before your first deploy, or the container will start against an empty database and every request will fail.

1. Create a Railway project and point it at this repository (or run `railway init` and `railway up` from the repo root).
2. In that project, add a database: **New → Database → Add PostgreSQL**.
3. On the **app service**, open **Variables** and add a reference variable so the app always reads the database's current credentials rather than a copied-and-pasted snapshot:

   ```bash
   DATABASE_URL=${{Postgres.DATABASE_URL}}
   ```

   If you renamed the database service, replace `Postgres` with its name.
4. Deploy. Railway will run `bun install && bun run build`, then start the container with `bunx prisma migrate deploy && bun run start`.
5. Under **Settings → Networking**, generate a public domain. Railway injects `PORT`, which `next start` picks up automatically.

The health check hits `/login`, which renders without a session and without a database round-trip, so a slow or unavailable database does not cause a restart loop while the app itself is healthy. The restart policy is `ON_FAILURE` with 10 retries.

`NODE_ENV` is set to `production` by the build, and that is what switches the session cookie to the `__Host-` prefix and turns on the `Secure` flag. Do not override it.

## Security notes

What is actually implemented:

- **Passwords** are hashed with scrypt from `node:crypto` (N=2^16, r=8, p=1, 64-byte key, a fresh 16-byte random salt per password, explicit `maxmem`), run asynchronously behind a concurrency gate so a burst of logins cannot exhaust container memory. Verification is `crypto.timingSafeEqual` against a buffer that is equal-length by construction. Minimum length is 12 characters, with no composition rules.
- **Sessions** are opaque 256-bit random tokens. The browser gets the raw token in a cookie; the database stores only its SHA-256 hash, so a database leak yields no usable session. Cookies are `httpOnly`, `sameSite=lax`, `Secure` in production, `path=/`, with no `Domain` attribute, under the `__Host-` prefix in production. Expiry is 30 days with rolling refresh, and every request re-checks `expiresAt` against the database. Logging in rotates any presented token; logging out deletes the row.
- **Authorization** is re-derived on every read and every write by walking from the resource up to its organization *inside the Prisma `where` clause*, using the user id from the session. A resource that does not exist and a resource in another tenant return the same `null` from the same query, so there is no existence oracle. No action ever trusts a client-supplied user, organization, or role.
- **Login is enumeration-resistant**: a single database lookup and a single scrypt invocation on both the found and not-found branches (an unknown email is hashed against a dummy hash), and every failure returns the identical message. Registration does reveal whether an address is taken — see the list below.
- **Validation**: every Server Action re-parses its `FormData` with zod before touching the database, including length caps and rejection of control characters that Postgres `text` cannot store.
- **No public API surface**: there are no route handlers (`route.ts`) and no `middleware.ts` anywhere in the tree. Mutations are only reachable as Server Actions, which require a POST carrying a `Next-Action` header that a cross-origin form cannot set — that, plus `sameSite=lax` and Next's `Origin`/`Host` check, is why there is no CSRF token.
- **Security headers** are set in `next.config.ts` for every path: a Content-Security-Policy (with `base-uri 'none'`, `form-action 'self'`, `object-src 'none'`, `frame-ancestors 'none'`), `X-Content-Type-Options`, `Referrer-Policy`, `X-Frame-Options`, `Strict-Transport-Security`, `Permissions-Policy`, and `Cross-Origin-Opener-Policy`. `poweredByHeader` is off.
- **Error handling** never returns a Prisma message, an error code, or a stack trace to the browser; actions return one of a fixed set of literals. Passwords, hashes, session tokens, and raw login form data are never logged, and the Prisma client never enables query logging.

What is deliberately **not** implemented, and what that means for you:

- **No email verification.** Any syntactically valid address can register; nobody confirms it is real or belongs to the person.
- **No password reset and no password change.** A forgotten password means the account is unreachable and an operator must intervene in the database.
- **No SSO, OAuth, or MFA.** Email and password is the only way in.
- **Rate limiting is in-process only.** Login and registration throttles live in the memory of a single Node process, so a redeploy or crash resets every counter, and running more than one replica multiplies every limit by the replica count. scrypt's cost is the real floor here. Move the counters into Postgres before scaling out.
- **Registration reveals whether an email is already registered**, as does adding a member by email. Hiding either requires sending email, which is out of scope.
- **The CSP is not nonce-based**, so `script-src` allows inline scripts and is not XSS protection. The app is defended by React's escaping instead: it never constructs HTML from user input, uses no markdown renderer or sanitizer, and `dangerouslySetInnerHTML` is banned.
- **No audit log, no account deletion, no session management UI.** A user cannot see or revoke their other sessions.

## Data model

- **User** — email (unique, lowercased), name, password hash.
  - **Session** — SHA-256 token hash (unique), expiry. Deleted with the user.
- **Organization** — name, unique slug. The tenant boundary; deleting it cascades to everything below.
  - **Membership** — joins a user to an organization with a role of `OWNER`, `ADMIN`, or `MEMBER`. One per user per organization.
  - **Project** — name, key (unique within the organization), optional description.
    - **Board** — name.
      - **BoardColumn** — name and position. Always exactly `To Do` (0), `In Progress` (1), `Done` (2).
      - **Ticket** — sequential number (unique within the board), title, optional description, position, creator, optional assignee. Belongs to one board and one of that board's columns.
        - **Comment** — plain-text body, author.

Creators of tickets and authors of comments are `Restrict` references, so a user row cannot be deleted while their work exists. An assignee is `SetNull`. Everything else in the tree cascades from the organization down.
