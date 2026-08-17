# Flone

A small, multi-tenant Kanban application. People sign up with an email address and a password, create or join an organization, and work inside it: an organization holds projects, a project holds boards, a board holds three fixed columns (To Do, In Progress, Done), and tickets move between those columns and carry a comment thread. The organization is the tenant boundary, and it is enforced on every single read and write by walking up from the resource to its organization inside the database query itself — there is no place where one tenant can observe another. It is deliberately small: a handful of pages, exactly one third-party service (Resend, for email), and one API endpoint — an MCP server that speaks to the same authorization layer as everything else.

`SPEC.md` in this repository is the canonical specification. If the code and this README disagree, read the spec.

## Features

- **Organizations** — the tenant boundary. Any signed-in user can create one and becomes its `OWNER`.
- **Users** — register, sign in, sign out. Name, email, and password; nothing else. Registering sends a confirmation link, and an account cannot sign in until the address is confirmed.
- **Password reset** — "Forgot your password?" on the sign-in form. The emailed link is single use, expires in an hour, and completing a reset signs out every other session, MCP tokens included.
- **Memberships** — `OWNER`, `ADMIN`, and `MEMBER` roles. Owners and admins can add someone by email, change roles, and remove members. If the address has no account yet it gets an invitation instead, valid for 7 days; pending invitations can be resent or revoked from the organization's settings.
- **Email notifications** — when an issue is assigned to you, when someone comments on an issue you are involved in, when a comment mentions you, and when you are added to an organization. Each is a separate switch on `/account`. Security messages (password changed, MCP token created) are always sent.
- **Projects** — many per organization, with a name, an uppercase key (`ENG`, `WEB`), and an optional description.
- **Boards** — many per project. Every new board is seeded with the three columns `To Do`, `In Progress`, `Done`.
- **Tickets** — title, optional description, a per-board sequential number, an optional assignee. Moved between columns and reordered within a column using buttons on the card.
- **Comments** — Markdown comments on a ticket, edited in place: press Edit and the comment itself becomes the editor, Ctrl/Cmd+Enter or Save commits, Escape reverts. You can edit and delete your own; admins and owners can moderate any.
- **@mentions** — type `@` in a comment to tag any member of the organization, and they get an email about it. The name is stored as plain text in the body, so who was tagged is re-derived from the comment itself — including after an edit, which mails only the people it newly named.
- **Recurring tickets** — a template that creates a pre-filled issue on a schedule: daily, weekdays, weekly or monthly. Title, Markdown description, priority, labels and assignee are copied onto each one, which arrives due that day with the date on its title. Every occurrence is counted from the template's original anchor, so one anchored on the 31st runs Jan 31 → Feb 28 → Mar 31 rather than sticking at the 28th. Editing the description changes every future ticket and none already created; pausing keeps it for when the work comes back.
- **MCP** — one authenticated endpoint (`/api/mcp`) exposing the whole application to an AI assistant: organizations, members, projects, boards, tickets, comments, reminders, recurring tickets, saved views and site administration. See [MCP access](#mcp-access).

### Not included, on purpose

File uploads, in-app notifications, password change while signed in (reset it instead), OAuth/SSO, MFA, digest emails, labels, filtering, activity feeds, realtime/websockets, an admin panel, billing, a dark-mode toggle, i18n, analytics, a rich-text editor, avatars, and any public REST/JSON API — `/api/mcp` is the only route handler, it speaks MCP rather than REST, and it is closed to anyone without a session token. Board columns are fixed at three and cannot be added, renamed, or deleted.

Digests are absent because they need a scheduler on a timer for something nobody asked to be woken by; reminders, which people do ask for, have one.

## Stack

| Piece | Why it is here |
| --- | --- |
| **Next.js 15 (App Router)** | Server Components render every read on the server, so query results never travel to the browser and authorization cannot be bypassed client-side. |
| **React Server Actions** | Every mutation is a server function; this removes the entire REST surface, and with it a whole class of missing-auth-check bugs on endpoints. |
| **TypeScript (strict)** | The action return type is a closed union, which makes leaking a raw error message a compile error rather than a discipline problem. |
| **Prisma + PostgreSQL** | The tenant check lives inside the `where` clause of a typed query, so "missing" and "not yours" are literally the same code path. |
| **Bun** | Package manager and runtime, for install and boot speed; there is no Node-specific dependency in the tree. |
| **zod** | Every Server Action re-parses its own `FormData`, without exception, before anything reaches the database. |
| **node:crypto** | Password hashing (scrypt), session tokens and emailed one-time tokens use the runtime's own crypto — no native build steps, so deploys cannot break on a compiler toolchain. |
| **Resend + react-email** | The only third-party service. `react-email` renders the templates; sending is a single `fetch` to Resend's API, so the `resend` SDK is not a dependency. With no API key configured the app prints messages to the console instead, and local development needs no account. |
| **Tailwind CSS v4** | `globals.css` is the entrypoint and the whole configuration — no `tailwind.config`, tokens declared in `src/styles/theme.css`, layout written as utilities at the call site. |
| **Untitled UI** | The design system. Components are source in `src/components/`, not an imported package, so one is edited in place rather than overridden; `@untitledui/icons` and `tailwind-merge` come along with it. |
| **React Aria Components + Base UI** | The unstyled primitives under those components — focus management, keyboard behaviour and ARIA wiring that is not worth hand-rolling twice. |

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

Then edit `.env` and point `DATABASE_URL` at your database. It is the only variable the app requires locally — leave `RESEND_API_KEY` empty and every email is printed to the console instead of sent, links included, so you can click through registration, reset and invitations without a Resend account.

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
| `bun run mcp:smoke` | End-to-end check of `/api/mcp` against a running server. Needs `FLONE_MCP_TOKEN`. |
| `bun run email:dev` | react-email's preview server for the templates in `src/emails/`. |
| `bun run check:email` | Asserts the transport and templates. The one-time-token checks need a reachable database and are skipped, not failed, without one. |
| `bun run check:markdown` | Asserts what the comment renderer does with hostile input: raw HTML stays inert, `javascript:` links are dropped. |
| `bun run check:mentions` | Asserts the @mention tokenizer — who a body tags, who it must not (`dana@acme.com`, `@Dan`), and that the highlight and the email agree. |

## MCP access

The app is also an [MCP](https://modelcontextprotocol.io) server, so an AI assistant can work your boards: `POST /api/mcp`, Streamable HTTP transport, stateless.

### Get a token

Sign in, open the account menu at the foot of the sidebar, choose **MCP access**, and create a token. It is shown once.

A token *is* a session — the same `Session` row a browser sign-in creates, with the same SHA-256 storage, the same 30-day rolling expiry, and the same revocation. Two consequences worth being clear about: it carries your full access to every organization you belong to, and it stays valid as long as it keeps being used. Revoke it on the same page.

### Connect a client

```bash
claude mcp add --transport http flone https://your-flone.example.com/api/mcp --header "Authorization: Bearer <your-token>"
```

Or install this repository as a plugin, which brings the server and a skill that teaches the model how to use it:

```bash
claude plugin marketplace add <this-repo>
claude plugin install flone@flone
```

The plugin's `.mcp.json` reads two environment variables:

```bash
export FLONE_URL=https://your-flone.example.com   # defaults to http://localhost:3000
export FLONE_MCP_TOKEN=<your-token>
```

Any other MCP client works the same way — point it at the endpoint with that one header.

### Tools

The whole application, 50 tools. Every one of them is the same Server Action the web UI submits, so the role matrix below is the app's, not a second implementation of it.

| Area | Tools | Who |
| --- | --- | --- |
| Reading | `list_boards`, `whoami`, `get_organization`, `get_project`, `get_board`, `get_ticket`, `search_tickets` | any member |
| Tickets | `create_ticket`, `update_ticket`, `move_ticket`, `move_ticket_to_board`, `delete_ticket` | any member; delete is author/`ADMIN`/`OWNER` |
| Comments | `create_comment`, `update_comment`, `delete_comment` | any member; edit and delete are author/`ADMIN`/`OWNER` |
| Boards | `create_board`, `rename_board`, `delete_board` | `ADMIN` or `OWNER` |
| Projects | `create_project`, `update_project`, `delete_project` | `ADMIN` or `OWNER` |
| Workspaces | `create_workspace` | `ADMIN` or `OWNER` |
| Labels | `create_label`, `update_label`, `delete_label` | `ADMIN` or `OWNER` |
| Organizations | `create_organization`, `rename_organization`, `delete_organization` | anyone may create; rename is `ADMIN`+, delete is `OWNER` |
| Members | `add_member`, `set_member_role`, `remove_member` | `ADMIN` or `OWNER`; granting `OWNER` is `OWNER`-only |
| Daily Challenges | `list_challenges`, `add_challenge`, `remove_challenge`, `move_challenge` | your own board only |
| Reminders | `list_reminders`, `create_reminder`, `delete_reminder` | any member; delete is setter/recipient/`ADMIN` |
| Recurring tickets | `list_recurring_tickets`, `create_recurring_ticket`, `update_recurring_ticket`, `reschedule_recurring_ticket`, `set_recurring_ticket_paused`, `delete_recurring_ticket` | any member; delete is creator/`ADMIN`/`OWNER` |
| Saved views | `list_views`, `create_view`, `delete_view` | any member; delete is creator/`ADMIN` |
| Site admin | `admin_list_users`, `admin_set_registration`, `admin_set_user_admin` | site administrators |

`delete_project` and `delete_organization` require the caller to echo the project key or organization name exactly, the same confirmation the web forms ask for.

Some things are deliberately absent. Signing out would revoke the very token making the call; login, register and creating an MCP token all mint credentials — a caller holding a token is already authenticated, and account creation stays a human act behind the registration flag; and phone verification places a real call, which is not something a model should trigger on someone's handset.

Others are simply not built yet: workflow states and cycles can be read and referred to by name but not created or edited over MCP, and neither can cycle configuration, workspace renaming, notification preferences or pending invitations. The web UI does all of those.

### Verifying it

```bash
FLONE_MCP_TOKEN=<token> bun run mcp:smoke
```

It checks the handshake, that an unauthenticated call is a 401, and that a bad argument comes back as a tool error rather than a transport error. Then it builds a **throwaway organization of its own** — project, two boards, a ticket, a comment — exercises every tool against it, and deletes the organization in a `finally`. Your real boards are never touched, so it is safe to point at production. The three `admin_*` tools are skipped, not failed, when the token does not belong to a site administrator.

## Deploying to Railway

One service running the Next.js app, plus one Postgres database in the same project. `railway.json` in the repo root already pins the builder, build command, start command, restart policy, and health check, so the dashboard needs no build configuration.

**Commit your migrations first.** The pre-deploy command runs `prisma migrate deploy`, which only *applies* migrations that already exist in `prisma/migrations/` — it never creates them. Run `bun run db:migrate` locally and commit the generated folder before your first deploy, or the container will start against an empty database and every request will fail.

`prisma` is a runtime dependency rather than a dev dependency on purpose: dev dependencies are pruned before the release step runs, and `prisma migrate deploy` needs the CLI to be present at that point.

1. Create a Railway project and point it at this repository (or run `railway init` and `railway up` from the repo root).
2. In that project, add a database: **New → Database → Add PostgreSQL**.
3. On the **app service**, open **Variables** and add a reference variable so the app always reads the database's current credentials rather than a copied-and-pasted snapshot:

   ```bash
   DATABASE_URL=${{Postgres.DATABASE_URL}}
   ```

   If you renamed the database service, replace `Postgres` with its name.
4. On the same **Variables** tab, add the three email variables:

   ```bash
   RESEND_API_KEY=re_...
   EMAIL_FROM=Flone <no-reply@yourdomain.com>
   APP_URL=https://your-flone.example.com
   ```

   `EMAIL_FROM`'s domain must be verified in Resend first, or every send is rejected. `APP_URL` must be the public origin with no trailing path — it is what every emailed link is built from, and it is deliberately not taken from the request. Set it *before* the first real signup: with a key present but `APP_URL` missing, the app logs `[email] not_configured` and sends nothing, so nobody can confirm an address.
5. Deploy. Railpack detects `bun.lock` and installs with Bun, then runs `bun run build`. Before the new version takes traffic, the pre-deploy command runs `bunx prisma migrate deploy`; the container then starts with `bun run start`.
6. Under **Settings → Networking**, generate a public domain. Railway injects `PORT` — `next start` listens on it, so the domain's **target port must match that injected value (8080), not 3000**. A mismatch here surfaces as a 502 from the Railway edge even though the container is healthy.

The health check hits `/login`, which renders without a session and without a database round-trip, so a slow or unavailable database does not cause a restart loop while the app itself is healthy. The restart policy is `ON_FAILURE` with 10 retries.

`NODE_ENV` is set to `production` by the build, and that is what switches the session cookie to the `__Host-` prefix and turns on the `Secure` flag. Do not override it.

## Security notes

What is actually implemented:

- **Passwords** are hashed with scrypt from `node:crypto` (N=2^16, r=8, p=1, 64-byte key, a fresh 16-byte random salt per password, explicit `maxmem`), run asynchronously behind a concurrency gate so a burst of logins cannot exhaust container memory. Verification is `crypto.timingSafeEqual` against a buffer that is equal-length by construction. Minimum length is 12 characters, with no composition rules.
- **Sessions** are opaque 256-bit random tokens. The browser gets the raw token in a cookie; the database stores only its SHA-256 hash, so a database leak yields no usable session. Cookies are `httpOnly`, `sameSite=lax`, `Secure` in production, `path=/`, with no `Domain` attribute, under the `__Host-` prefix in production. Expiry is 30 days with rolling refresh, and every request re-checks `expiresAt` against the database. Logging in rotates any presented token; logging out deletes the row.
- **Authorization** is re-derived on every read and every write by walking from the resource up to its organization *inside the Prisma `where` clause*, using the user id from the session. A resource that does not exist and a resource in another tenant return the same `null` from the same query, so there is no existence oracle. No action ever trusts a client-supplied user, organization, or role.
- **Login is enumeration-resistant**: a single database lookup and a single scrypt invocation on both the found and not-found branches (an unknown email is hashed against a dummy hash), and every failure returns the identical message.
- **Registration is enumeration-resistant too**, which it was not before email existed. Both branches send exactly one message — a confirmation link to a free address, a "you already have an account" notice to a taken one — spend the same scrypt time (the taken branch hashes a password it discards), and return the identical result rendering the identical screen. The same holds for the password-reset and resend-confirmation forms, which answer one literal whatever the address.
- **Emailed links are one-time credentials and are treated as such**: 256 bits from `randomBytes`, only `sha256(token)` stored, single use enforced by one atomic `UPDATE ... WHERE usedAt IS NULL AND expiresAt > now()` rather than a read-then-write two clicks can both pass, and the purpose is part of that `where` clause so a confirmation token cannot be spent on the reset endpoint. Confirming is a POST behind a button, never the GET itself, so mail scanners and link prefetchers cannot burn a link before the reader opens it. Every link is built from `APP_URL` and never from the `Host` header.
- **An invitation is bound to the address it was sent to**, not to whoever opens it. Accepting while signed in as a different account is refused rather than silently granting that account access, which is what makes a forwarded or leaked invitation harmless.
- **A completed password reset deletes every session for that user**, MCP tokens included, and sends a notice that cannot be switched off.
- **Validation**: every Server Action re-parses its `FormData` with zod before touching the database, including length caps and rejection of control characters that Postgres `text` cannot store.
- **One API surface, authenticated**: there is no `middleware.ts`, and exactly one route handler — `/api/mcp`. Everything else is reachable only as a Server Action, which requires a POST carrying a `Next-Action` header that a cross-origin form cannot set; that, plus `sameSite=lax` and Next's `Origin`/`Host` check, is why there is no CSRF token. The MCP endpoint is not a CSRF hole either: it authenticates with an `Authorization: Bearer` header, which no cross-site form, image, or script can attach, and it answers no `OPTIONS`, so no origin is ever granted CORS access. It performs no authorization of its own — every tool goes through the same `require*` walk and the same Server Actions as the web UI.
- **Security headers** are set in `next.config.ts` for every path: a Content-Security-Policy (with `base-uri 'none'`, `form-action 'self'`, `object-src 'none'`, `frame-ancestors 'none'`), `X-Content-Type-Options`, `Referrer-Policy`, `X-Frame-Options`, `Strict-Transport-Security`, `Permissions-Policy`, and `Cross-Origin-Opener-Policy`. `poweredByHeader` is off.
- **Error handling** never returns a Prisma message, an error code, or a stack trace to the browser; actions return one of a fixed set of literals. Passwords, hashes, session tokens, and raw login form data are never logged, and the Prisma client never enables query logging.

What is deliberately **not** implemented, and what that means for you:

- **No password change while signed in.** Changing a password means resetting it through the emailed link.
- **No SSO, OAuth, or MFA.** Email and password is the only way in.
- **Rate limiting is in-process only.** Login, registration, reset and resend throttles live in the memory of a single Node process, so a redeploy or crash resets every counter, and running more than one replica multiplies every limit by the replica count. scrypt's cost is the real floor here. Move the counters into Postgres before scaling out.
- **Email delivery is best-effort and unretried.** Sending happens after the response via `after()`, and a failure is logged rather than raised — an issue that was assigned stays assigned whether or not Resend was reachable. There is no queue and no retry, on the grounds that every message is re-requestable by the user. A confirmation or reset link lost to a provider outage is recovered by asking for another.
- **Deliverability is a domain problem, not a code problem.** If `EMAIL_FROM` is on a domain without SPF/DKIM set up in Resend, mail is rejected or lands in spam, and the app cannot tell the difference — the log line says the send failed and nothing more.
- **The CSP is not nonce-based**, so `script-src` allows inline scripts and is not XSS protection. The app is defended by React's escaping instead: it never constructs HTML from user input, and `dangerouslySetInnerHTML` is banned. Descriptions and comments are Markdown, rendered by `react-markdown` into React elements — raw HTML in a body is escaped rather than parsed, because `rehype-raw` is deliberately absent. `bun run check:markdown` is what holds that line.
- **No audit log and no account deletion.** `/tokens` lists your live sessions and revokes any of them, but it shows only when each was created — there is no device, IP, or last-used detail to tell two of them apart, and no way to scope a token to less than your full access.

## Data model

- **User** — email (unique, lowercased), name, password hash, `emailVerified` timestamp, and three notification switches.
  - **Session** — SHA-256 token hash (unique), expiry. Deleted with the user.
  - **EmailToken** — SHA-256 token hash (unique), purpose (`EMAIL_VERIFY`, `PASSWORD_RESET`, `INVITE`), the address it was issued to, expiry, and `usedAt`. An `INVITE` also carries the organization and the role it grants, and has no user until it is accepted. Deleted with the user or the organization.
- **Organization** — name, unique slug. The tenant boundary; deleting it cascades to everything below.
  - **Membership** — joins a user to an organization with a role of `OWNER`, `ADMIN`, or `MEMBER`. One per user per organization.
  - **Project** — name, key (unique within the organization), optional description.
    - **Board** — name.
      - **BoardColumn** — name and position. Always exactly `To Do` (0), `In Progress` (1), `Done` (2).
      - **Ticket** — sequential number (unique within the board), title, optional description, position, creator, optional assignee. Belongs to one board and one of that board's columns.
        - **Comment** — plain-text body, author.

Creators of tickets and authors of comments are `Restrict` references, so a user row cannot be deleted while their work exists. An assignee is `SetNull`. Everything else in the tree cascades from the organization down.
