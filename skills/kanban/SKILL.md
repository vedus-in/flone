---
name: kanban
description: Read and update Kanban boards, tickets and comments through the kanban MCP server. Use when the user mentions their board, a ticket, a ticket ref like PROJ-12, a backlog, a sprint column, or asks to file, move, assign, prioritise, comment on or close work items.
---

# Kanban

The `kanban` MCP server exposes one person's boards. Every call acts as the
owner of the token and can only reach organizations they belong to — there is no
admin mode and no way to see another tenant.

## Setup

The server needs two environment variables where the client runs:

```bash
export KANBAN_URL=https://your-kanban.example.com   # defaults to http://localhost:3000
export KANBAN_MCP_TOKEN=<token from the app>
```

Get the token from the running app: account menu (bottom of the sidebar) →
**MCP access** → *Create token*. It is shown once. If a tool returns
"You are signed out", the token was revoked or has expired — mint a new one.

## Working with it

Ids are opaque cuids and must never be guessed. Get them from a read first:

| Read | Gives you |
| --- | --- |
| `list_boards` | The whole tree: organizations → projects → boards. Start here. |
| `get_organization` | Members with their `membershipId`, and the org's projects and boards. |
| `get_board` | Columns and their tickets, plus who can be assigned. |
| `get_ticket` | One ticket in full, with `commentId`s. |
| `search_tickets` | Substring match on title and description across every board. |

Then act. Everything the web app can do is here:

- **Tickets** — `create_ticket` (`column` accepts a name like "In Progress"), `update_ticket`, `move_ticket` (`position` 0 puts it on top; omit to append), `move_ticket_to_board`, `delete_ticket`.
- **Comments** — `create_comment`, `update_comment`, `delete_comment`.
- **Boards** — `create_board`, `rename_board`, `delete_board`.
- **Projects** — `create_project`, `update_project`, `delete_project`.
- **Organizations** — `create_organization`, `rename_organization`, `delete_organization`.
- **Members** — `add_member` (by email; they must already have an account), `set_member_role`, `remove_member`.
- **Site admin** — `admin_list_users`, `admin_set_registration`, `admin_set_user_admin`. These govern the *instance*, not any organization, and only work for a site administrator.

`update_ticket` takes any combination of title, description, `priority` (NONE/LOW/MEDIUM/HIGH/URGENT), `dueDate` (YYYY-MM-DD) and `assignee` (member email). Omitted fields are untouched; an empty string clears `description`, `dueDate` or `assignee`.

## Conventions

- A ticket's human-facing name is its `ref`, e.g. `PROJ-12`. Say that to the user, not the id.
- Every result carries a `url` — a path on the Kanban app. Offer it when reporting what changed.
- **Ask before deleting anything.** Deletes cascade: a board takes its tickets, a project takes its boards, an organization takes everything. `delete_project` and `delete_organization` also require you to echo the key or name exactly — that guardrail is there to make the deletion deliberate, so treat needing it as a reason to confirm with the user, not a puzzle to solve.
- Making several changes to one ticket? One `update_ticket` call, not four.
- Columns are fixed: every board is seeded with *To Do*, *In Progress*, *Done*, and there is no tool to add, rename or delete a column. That is a deliberate limit of the app, not a gap here.
- Permission errors are honest. "You don't have permission to do that" means the token's owner genuinely lacks the role — a MEMBER cannot create projects or delete other people's tickets. Report it; don't try another tool to route around it.
