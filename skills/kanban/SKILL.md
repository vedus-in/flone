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

Ids are opaque cuids and must never be guessed. Get them from a read:

1. `list_boards` — the whole tree: organizations → projects → boards. Start here.
2. `get_board` — columns and their tickets, plus the members who can be assigned.
3. `search_tickets` — substring match on title and description across every board.
4. `get_ticket` — one ticket in full, with its comments.

Then act:

- `create_ticket` — `column` accepts a name ("In Progress"), defaulting to the first column.
- `update_ticket` — title, description, `priority` (NONE/LOW/MEDIUM/HIGH/URGENT), `dueDate` (YYYY-MM-DD), `assignee` (member email). Omitted fields are untouched; an empty string clears `description`, `dueDate` or `assignee`.
- `move_ticket` — another column of the same board; `position` 0 puts it on top, omit it to append.
- `comment_ticket`, `delete_ticket`.

## Conventions

- A ticket's human-facing name is its `ref`, e.g. `PROJ-12`. Say that to the user, not the id.
- Every result carries a `url` — a path on the Kanban app. Offer it when reporting what changed.
- Confirm before `delete_ticket`. It also deletes the ticket's comments and cannot be undone.
- Making several changes to one ticket? One `update_ticket` call, not four.
- Board and column names are fixed here — the app seeds *To Do*, *In Progress*, *Done* and there is no tool to create boards or columns. Ask the user to do that in the web app.
