# flone

Flone from your terminal — boards, issues and comments, interactive or scripted.

```bash
npm install -g flone
```

Needs Node 20 or newer. Works on Windows, macOS and Linux.

## Getting started

```bash
flone login --host https://your-flone-instance
flone use ENG        # remember a default project
flone               # open the board
```

`flone login` asks for your email and password and stores a token. That token
**is a session** — the same credential your browser holds, carrying the full
rights of your account. It lives in `~/.config/flone/config.json`
(`%APPDATA%\flone\config.json` on Windows) at mode `0600`, which is the same
posture `gh`, `npm` and `aws` take. `flone logout` revokes it server-side rather
than only forgetting it locally.

If you would rather mint a token in the browser, create one at `/tokens` and
pipe it in:

```bash
echo "$TOKEN" | flone login --with-token --host https://your-flone-instance
```

## The board

`flone` with no arguments opens the interactive board.

| Key | |
| --- | --- |
| `←` `→` `h` `l` | previous / next column |
| `↑` `↓` `j` `k` | previous / next issue |
| `enter` | show or hide the detail pane |
| `n` | new issue in the selected column |
| `e` | rename the selected issue |
| `m` | pick a status |
| `[` `]` | nudge one column left or right |
| `a` | assign |
| `p` | set priority |
| `c` | comment |
| `d` | delete (asks first) |
| `b` | open a different board |
| `r` | refresh |
| `?` | help |
| `q` `esc` | quit |

The board is a snapshot. Flone has no realtime channel, so it refreshes on `r`
and after every change, and deliberately does not poll.

## Commands

Issues are named by ref (`ENG-12`) or by id, anywhere one is taken.

```bash
flone ls                          # the board, grouped by status
flone ls --board Main --mine
flone ls --status "In Progress"

flone show ENG-12
flone search "login bug" --limit 50

flone new "Fix the login bug" --priority high --assign sam@acme.com --label bug
flone edit ENG-12 --title "Better title" --due 2026-09-01
flone edit ENG-12 --desc ""       # an empty value clears; an absent flag leaves alone
flone mv ENG-12 "In Progress" --pos 0
flone comment ENG-12 "on it"
flone rm ENG-12 --yes
```

Organizations, projects, boards, members and site administration are commands
rather than screens, because they are rare and mostly destructive:

```bash
flone org ls | show | new | rename | rm
flone org member ls | add <email> --role ADMIN | role <email> OWNER | rm <email>
flone project ls | show | new "Name" --key ENG | edit | rm
flone board ls | new "Sprint 4" | rename Main "Sprint 4" | rm
flone admin users | registration off | set-admin <email> on
```

Every destructive command confirms first, and refuses outright without a
terminal unless you pass `--yes`.

## Scripting

`--json` on any command prints the raw tool result and nothing else:

```bash
flone search "flaky" --json | jq -r '.tickets[].ref'
```

`FLONE_TOKEN` and `FLONE_URL` override the stored login, so CI never runs
`flone login`:

```yaml
env:
  FLONE_URL: https://your-flone-instance
  FLONE_TOKEN: ${{ secrets.FLONE_TOKEN }}
```

Colour is suppressed when output is not a terminal, and when `NO_COLOR` is set.

## How it works

The CLI is a thin client over Flone's existing MCP endpoint (`/api/mcp`) — the
same JSON-RPC surface that agents use, covering organizations, projects, boards,
issues, comments and administration. Every command is exactly one tool call.
Sign-in is the one thing that endpoint cannot do (it is what issues the token it
requires), so that goes to `/api/cli/login`.

Nothing here imports the application. It is an ordinary HTTP client and points
wherever you tell it.

## Developing

```bash
npm install
npm run build
npm test
```

The test stands up a stub MCP server and asserts what each command puts on the
wire. It needs no database and no running Flone.
