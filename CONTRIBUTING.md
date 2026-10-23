# Contributing to Flone

Thanks for helping. Bug reports, fixes and small focused features are all welcome.

## Before you start

- **Bugs:** open an issue with steps to reproduce. For anything security-related, do not open an issue. See [SECURITY.md](SECURITY.md).
- **Features:** open an issue first and describe the problem you want solved. Flone is small on purpose (see ["Not included, on purpose"](docs/features.md#not-included-on-purpose)), so it is worth agreeing on the shape before writing code.
- `SPEC.md` is the canonical specification. If a change alters behaviour it describes, update it in the same pull request.

## Development setup

You need [Bun](https://bun.sh) 1.3+, Node 22+ (two of the checks run on plain Node), and a PostgreSQL 14+ database.

```bash
bun install
cp .env.example .env        # point DATABASE_URL at an empty database
bun run db:migrate
bun run db:seed             # optional: demo organization, projects and members
bun run dev
```

With no email provider configured, every email (links included) is printed to the console, so you can click through registration without a mail account.

## Before opening a pull request

Run what CI runs:

```bash
bun run typecheck
bun run check:all
bun run build
```

If you touched `cli/`, also run `npm ci && npm run build && npm test` inside `cli/`.

## Guidelines

- **Match the code around you.** Naming, structure, and comments that explain *why*, not *what*.
- **Keep pull requests small and focused.** One change per PR is much easier to review.
- **Authorization is not optional.** Every read and write goes through the `require*` helpers in `src/lib/authz.ts`, which walk from the resource up to its organization inside the query. Do not add a route or action that skips them.
- **Every Server Action re-parses its input with zod.** Never trust form data, and never return a raw error message to the browser.
- **Add or update a check** in `scripts/` when you change logic one of them covers, or when you fix a bug that could quietly come back.
- **New dependencies need a reason.** The codebase prefers the runtime's own primitives where a few lines will do.

## License

By contributing, you agree that your contributions are licensed under the [GNU AGPL v3](LICENSE), the same license as the project.
