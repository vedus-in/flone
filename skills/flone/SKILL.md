---
name: flone
description: Read and update Flone boards, tickets and comments through the flone MCP server. Use when the user mentions their board, a ticket, a ticket ref like PROJ-12, a backlog, a sprint column, or asks to file, move, assign, prioritise, comment on or close work items.
---

# Flone

The `flone` MCP server exposes one person's boards. Every call acts as the
owner of the token and can only reach organizations they belong to — there is no
admin mode and no way to see another tenant.

## Setup

The server needs two environment variables where the client runs:

```bash
export FLONE_URL=https://your-flone.example.com   # defaults to http://localhost:3000
export FLONE_MCP_TOKEN=<token from the app>
```

Get the token from the running app: account menu (bottom of the sidebar) →
**MCP access** → *Create token*. It is shown once. If a tool returns
"You are signed out", the token was revoked or has expired — mint a new one.

## Working with it

Ids are opaque cuids and must never be guessed. Get them from a read first:

| Read | Gives you |
| --- | --- |
| `list_boards` | The whole tree: organizations → workspaces → projects → boards. Start here. |
| `whoami` | Who the token belongs to. |
| `get_organization` | Members with their `membershipId`, and the org's projects and boards. |
| `get_project` | A project's workflow states, labels, boards and cycles — the vocabulary every write below refers to by name. |
| `get_board` | A board's issues, plus who can be assigned. |
| `get_ticket` | One issue in full, with `commentId`s. |
| `search_tickets` | Substring match on title and description across every project. |

Then act. Everything the web app can do is here:

- **Issues** — `create_ticket`, `update_ticket`, `move_ticket` (sets status; `position` 0 puts it on top, omit to append), `move_ticket_to_board`, `delete_ticket`.
- **Comments** — `create_comment`, `update_comment`, `delete_comment`.
- **Boards** — `create_board`, `rename_board`, `delete_board`.
- **Projects** — `create_project`, `update_project`, `delete_project`. **Workspaces** — `create_workspace`.
- **Organizations** — `create_organization`, `rename_organization`, `delete_organization`.
- **Members** — `add_member` (by email; they must already have an account), `set_member_role`, `remove_member`.
- **Reminders** — `list_reminders`, `create_reminder`, `delete_reminder`. A scheduled email or phone call, for anyone in the org.
- **Recurring tickets** — `list_recurring_tickets`, `create_recurring_ticket`, `update_recurring_ticket`, `reschedule_recurring_ticket`, `set_recurring_ticket_paused`, `delete_recurring_ticket`.
- **Daily Challenges** — `list_challenges`, `add_challenge`, `remove_challenge`, `move_challenge`. The token owner's own cherry-picked board, spanning projects.
- **Saved views** — `list_views`, `create_view`, `delete_view`.
- **Site admin** — `admin_list_users`, `admin_set_registration`, `admin_set_user_admin`. These govern the *instance*, not any organization, and only work for a site administrator.

`update_ticket` takes any combination of title, description, `priority` (NONE/LOW/MEDIUM/HIGH/URGENT), `dueDate` (YYYY-MM-DD), `assignee` (member email), `board`, `cycle`, `labels` and `parent`. Omitted fields are untouched; an empty string clears the nullable ones, and `labels` REPLACES the whole set. Status is not here — it is `move_ticket`.

## Recurring tickets

A template that creates a pre-filled issue on a schedule — `DAILY`, `WEEKDAYS`,
`WEEKLY` or `MONTHLY`. There is no "once": for a single pre-filled issue, use
`create_ticket`.

- `runAt` is a **wall clock** (`2026-08-20T09:00`), not an instant, and it must be in the future. It is read as UTC unless you pass `tzOffsetMinutes` — the offset `getTimezoneOffset()` reports, so Berlin in summer is `-120`. The same offset decides which days count as the weekend for `WEEKDAYS`.
- The description is the **living checklist**. `update_recurring_ticket` changes what every *future* issue says and never touches ones already created — that is the intended way to refine a recurring process, so prefer it over deleting and recreating.
- `set_recurring_ticket_paused` is the right way to stop one temporarily; it keeps everything written into the template. Resuming always schedules into the future, so a template paused for a month does not create a backlog.
- Issues it creates are **ordinary issues**. `get_ticket`, `create_comment` and `move_ticket` all work on them, and nothing links them back to the template.

## Conventions

- A ticket's human-facing name is its `ref`, e.g. `PROJ-12`. Say that to the user, not the id.
- Every result carries a `url` — a path on the Flone app. Offer it when reporting what changed.
- **Ask before deleting anything.** Deletes cascade: a project takes its boards and issues, an organization takes everything. Deleting a *board* is the exception — its issues survive and simply lose the board chip. `delete_project` and `delete_organization` also require you to echo the key or name exactly — that guardrail is there to make the deletion deliberate, so treat needing it as a reason to confirm with the user, not a puzzle to solve.
- Making several changes to one issue? One `update_ticket` call, not four.
- **Status belongs to the project, not to a board.** Each project owns its workflow states — by default *Backlog*, *Todo*, *In Progress*, *In Review*, *Done*, *Canceled* — and an issue has exactly one, which every board and list reflects. `get_project` lists them; `move_ticket` sets one by name. A board is an optional grouping chip, and an issue need not be on one.
- States, labels and cycles can be read and referred to by name, but not created or renamed here yet. If a label you need does not exist, say so rather than filing the issue untagged.
- Permission errors are honest. "You don't have permission to do that" means the token's owner genuinely lacks the role — a MEMBER cannot create projects or delete other people's tickets. Report it; don't try another tool to route around it.
