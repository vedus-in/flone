# MCP access

The app is also an [MCP](https://modelcontextprotocol.io) server, so an AI assistant can work your boards: `POST /api/mcp`, Streamable HTTP transport, stateless.

## Get a token

Sign in, open the account menu at the foot of the sidebar, choose **MCP access**, and create a token. It is shown once.

A token *is* a session — the same `Session` row a browser sign-in creates, with the same SHA-256 storage, the same 30-day rolling expiry, and the same revocation. Two consequences worth being clear about: it carries your full access to every organization you belong to, and it stays valid as long as it keeps being used. Revoke it on the same page.

## Connect a client

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

## Tools

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
| Documents | `list_documents`, `get_document`, `create_document`, `update_document`, `move_document`, `set_document_shared`, `delete_document` | any member; sharing and delete are author/`ADMIN`/`OWNER`, and delete takes the whole subtree |
| Saved views | `list_views`, `create_view`, `delete_view` | any member; delete is creator/`ADMIN` |
| Site admin | `admin_list_users`, `admin_set_registration`, `admin_set_user_admin` | site administrators |

`delete_project` and `delete_organization` require the caller to echo the project key or organization name exactly, the same confirmation the web forms ask for.

Some things are deliberately absent. Signing out would revoke the very token making the call; login, register and creating an MCP token all mint credentials — a caller holding a token is already authenticated, and account creation stays a human act behind the registration flag; and phone verification places a real call, which is not something a model should trigger on someone's handset.

Others are simply not built yet: workflow states and cycles can be read and referred to by name but not created or edited over MCP, and neither can cycle configuration, workspace renaming, notification preferences or pending invitations. The web UI does all of those.

## Verifying it

```bash
FLONE_MCP_TOKEN=<token> bun run mcp:smoke
```

It checks the handshake, that an unauthenticated call is a 401, and that a bad argument comes back as a tool error rather than a transport error. Then it builds a **throwaway organization of its own** — project, two boards, a ticket, a comment — exercises every tool against it, and deletes the organization in a `finally`. Your real boards are never touched, so it is safe to point at production. The three `admin_*` tools are skipped, not failed, when the token does not belong to a site administrator.
