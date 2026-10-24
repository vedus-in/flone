# Development

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
| **Resend or SMTP + react-email** | Email, the only third-party service. `react-email` renders the templates. Resend is a single `fetch`, so the `resend` SDK is not a dependency; any other mail server is reached over SMTP through `nodemailer`. With neither configured the app prints messages to the console instead, and local development needs no account. |
| **Tailwind CSS v4** | `globals.css` is the entrypoint and the whole configuration — no `tailwind.config`, tokens declared in `src/styles/theme.css` and re-pointed at the Linear-style palette and 13px type scale in `src/styles/linear.css`, layout written as utilities at the call site. |
| **Untitled UI** | The component base, restyled to a Linear-like look (the shell, `PageBar`, list rows and boards live in `src/components/` and `src/app/(app)/`). Components are source in `src/components/`, not an imported package, so one is edited in place rather than overridden; `@untitledui/icons` and `tailwind-merge` come along with it. |
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

Then edit `.env` and point `DATABASE_URL` at your database. It is the only variable the app requires locally — leave `RESEND_API_KEY` and `SMTP_HOST` empty and every email is printed to the console instead of sent, links included, so you can click through registration, reset and invitations without a Resend account.

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
| `bun run smoke:attachments` | End-to-end check of the attachment routes against a running server: upload, the presigned redirect, the type/size refusals, and that deleting an issue really removes its object from the bucket. Builds and deletes a throwaway organization, so it is safe against production. Without `FLONE_MCP_TOKEN` the unauthenticated checks still run and the rest are skipped. |
| `bun run email:dev` | react-email's preview server for the templates in `src/emails/`. |
| `bun run check:email` | Asserts the transport and templates. The one-time-token checks need a reachable database and are skipped, not failed, without one. |
| `bun run check:markdown` | Asserts what the comment renderer does with hostile input: raw HTML stays inert, `javascript:` links are dropped, relative attachment images survive. |
| `bun run check:bucket` | Asserts the attachment path: SigV4 presigning against AWS's published test vector, the image type and size rules, the sentence an unsupported file is refused with, and that a hostile filename cannot escape its object key. Needs no bucket and no network. |
| `bun run check:mentions` | Asserts the @mention tokenizer — who a body tags, who it must not (`dana@acme.com`, `@Dan`), and that the highlight and the email agree. |
