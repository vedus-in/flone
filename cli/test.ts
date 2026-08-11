import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

/**
 * One runnable check for the CLI. No framework: a stub MCP server plus
 * assertions about what the commands actually put on the wire.
 *
 *   node --experimental-strip-types test.ts
 *
 * It runs the built entry point as a subprocess, which is the only way to prove
 * the parts that matter here — argument parsing, the absent-vs-empty rule in
 * `edit`, and the exit codes — behave as a shell will see them.
 */

const run = promisify(execFile);

type Recorded = { tool: string; args: Record<string, unknown> };

let recorded: Recorded[] = [];
let reply: (tool: string, args: Record<string, unknown>) => unknown = () => ({ ok: true });
let status = 200;

function start(): Promise<{ server: Server; url: string }> {
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      if (status !== 200) {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ jsonrpc: '2.0', id: 1, error: { message: 'nope' } }));
        return;
      }

      const message = JSON.parse(body) as {
        id: number;
        params: { name: string; arguments: Record<string, unknown> };
      };
      const { name, arguments: args } = message.params;
      recorded.push({ tool: name, args });

      const result = reply(name, args);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          jsonrpc: '2.0',
          id: message.id,
          result:
            result instanceof Error
              ? { content: [{ type: 'text', text: result.message }], isError: true }
              : { content: [{ type: 'text', text: JSON.stringify(result) }] },
        }),
      );
    });
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      resolve({ server, url: `http://127.0.0.1:${port}` });
    });
  });
}

/* -------------------------------------------------------------------------- */

const NAV = {
  organizations: [
    {
      id: 'o1',
      name: 'Acme',
      slug: 'acme',
      role: 'OWNER',
      workspaces: [
        { id: 'w1', name: 'General', slug: 'general', projects: [{ id: 'p1', key: 'ENG', name: 'Engineering' }] },
      ],
    },
  ],
};

const PROJECT = {
  project: 'Engineering',
  projectKey: 'ENG',
  organization: 'Acme',
  orgSlug: 'acme',
  yourRole: 'OWNER',
  states: [
    { stateId: 's1', name: 'To Do', type: 'UNSTARTED' },
    { stateId: 's2', name: 'In Progress', type: 'STARTED' },
  ],
  labels: [],
  boards: [{ boardId: 'b1', name: 'Main', status: 'ACTIVE', tickets: 1 }],
  currentCycle: 1,
};

const BOARD = {
  board: 'Main',
  boardId: 'b1',
  project: 'Engineering',
  projectKey: 'ENG',
  orgSlug: 'acme',
  columns: [
    {
      name: 'To Do',
      stateId: 's1',
      type: 'UNSTARTED',
      tickets: [
        {
          ticketId: 't1',
          ref: 'ENG-1',
          title: 'Fix the login bug',
          priority: 'HIGH',
          dueDate: null,
          assignee: 'Sam',
          labels: [],
          comments: 2,
          updatedAt: '2026-08-01T00:00:00.000Z',
        },
      ],
    },
    { name: 'In Progress', stateId: 's2', type: 'STARTED', tickets: [] },
  ],
  members: [{ userId: 'u1', name: 'Sam', email: 'sam@acme.com', role: 'OWNER' }],
};

const TICKET = {
  ticketId: 't1',
  ref: 'ENG-1',
  title: 'Fix the login bug',
  description: 'It logs you out.',
  status: 'To Do',
  statusType: 'UNSTARTED',
  priority: 'HIGH',
  dueDate: null,
  assignee: { id: 'u1', name: 'Sam', email: 'sam@acme.com' },
  labels: [],
  board: 'Main',
  cycle: null,
  parent: null,
  subIssues: [],
  createdBy: 'Sam',
  createdAt: '2026-08-01T00:00:00.000Z',
  updatedAt: '2026-08-01T00:00:00.000Z',
  url: '/orgs/acme/general/ENG/issue/1',
  comments: [{ commentId: 'c1', author: 'Sam', body: 'on it', createdAt: '2026-08-01T00:00:00.000Z' }],
};

const DEFAULTS: Record<string, unknown> = {
  whoami: { userId: 'u1', name: 'Sam', email: 'sam@acme.com' },
  list_boards: NAV,
  get_project: PROJECT,
  get_board: BOARD,
  get_ticket: TICKET,
  search_tickets: { query: 'x', count: 0, tickets: [] },
};

/* -------------------------------------------------------------------------- */

const home = mkdtempSync(join(tmpdir(), 'flone-test-'));
const { server, url } = await start();

const CLI = join(import.meta.dirname, 'dist', 'index.js');

async function flone(
  args: string[],
): Promise<{ stdout: string; stderr: string; code: number }> {
  recorded = [];
  try {
    const { stdout, stderr } = await run(process.execPath, [CLI, ...args], {
      env: {
        ...process.env,
        FLONE_CONFIG_DIR: home,
        FLONE_URL: url,
        FLONE_TOKEN: 'test-token',
        NO_COLOR: '1',
      },
    });
    return { stdout, stderr, code: 0 };
  } catch (e) {
    const failure = e as { stdout: string; stderr: string; code: number };
    return { stdout: failure.stdout, stderr: failure.stderr, code: failure.code };
  }
}

function sent(tool: string): Record<string, unknown> {
  const found = recorded.find((entry) => entry.tool === tool);
  assert.ok(found, `expected a ${tool} call, got: ${recorded.map((r) => r.tool).join(', ') || 'none'}`);
  return found.args;
}

reply = (tool) => DEFAULTS[tool] ?? { ok: true };

/* -- reads ----------------------------------------------------------------- */

{
  const { stdout, code } = await flone(['ls']);
  assert.equal(code, 0);
  assert.match(stdout, /ENG-1/);
  assert.match(stdout, /Fix the login bug/);
  assert.match(stdout, /To Do/);
  assert.equal(sent('get_board').boardId, 'b1');
}

{
  // A ref is passed straight through: resolution is the server's job, so the
  // CLI must not try to be clever and send an id it guessed.
  const { stdout } = await flone(['show', 'ENG-1']);
  assert.equal(sent('get_ticket').ticketId, 'ENG-1');
  assert.match(stdout, /It logs you out/);
  assert.match(stdout, /on it/);
}

{
  const { stdout } = await flone(['show', 'ENG-1', '--json']);
  assert.deepEqual(JSON.parse(stdout), TICKET);
}

/* -- writes ---------------------------------------------------------------- */

{
  await flone(['new', 'Ship it', '--priority', 'high', '--label', 'bug', '--label', 'ui']);
  const args = sent('create_ticket');
  assert.equal(args.title, 'Ship it');
  assert.equal(args.projectKey, 'ENG');
  assert.equal(args.orgSlug, 'acme');
  assert.equal(args.priority, 'HIGH', 'priority is upper-cased for the wire');
  assert.deepEqual(args.labels, ['bug', 'ui'], '--label repeats into an array');
  assert.ok(!('description' in args), 'flags that were not typed are not sent');
}

{
  // THE case this test exists for. `update_ticket` reads an absent key as
  // "leave alone" and an empty string as "clear it", so a parser that defaulted
  // --desc to '' would silently wipe every description it touched.
  await flone(['edit', 'ENG-1', '--priority', 'low']);
  const args = sent('update_ticket');
  assert.deepEqual(Object.keys(args).sort(), ['priority', 'ticketId']);
  assert.equal(args.priority, 'LOW');
}

{
  // ...and an explicitly empty one MUST still be sent, or clearing is impossible.
  await flone(['edit', 'ENG-1', '--desc', '']);
  assert.equal(sent('update_ticket').description, '');
}

{
  const { code, stderr } = await flone(['edit', 'ENG-1']);
  assert.equal(code, 1, 'an edit with no changes is refused rather than sent');
  assert.match(stderr, /Nothing to change/);
  assert.equal(recorded.length, 0);
}

{
  await flone(['mv', 'ENG-1', 'In Progress', '--pos', '0']);
  const args = sent('move_ticket');
  assert.equal(args.ticketId, 'ENG-1');
  assert.equal(args.status, 'In Progress');
  assert.equal(args.position, 0, 'position is a number, not the string it arrived as');
}

{
  await flone(['comment', 'ENG-1', 'looking now']);
  assert.deepEqual(sent('create_comment'), { ticketId: 'ENG-1', body: 'looking now' });
}

{
  const { stdout } = await flone(['rm', 'ENG-1', '--yes']);
  assert.match(stdout, /deleted ENG-1/);
  // Read first so the confirmation can name what it is about to destroy.
  assert.equal(sent('get_ticket').ticketId, 'ENG-1');
  assert.equal(sent('delete_ticket').ticketId, 't1');
}

{
  const { code, stderr } = await flone(['rm', 'ENG-1']);
  assert.equal(code, 1, 'a destructive command with no TTY and no --yes must refuse');
  assert.match(stderr, /--yes/);
  assert.ok(!recorded.some((entry) => entry.tool === 'delete_ticket'));
}

/* -- errors ---------------------------------------------------------------- */

{
  reply = (tool) => (tool === 'get_ticket' ? new Error('Not found.') : (DEFAULTS[tool] ?? { ok: true }));
  const { code, stderr } = await flone(['show', 'ENG-999']);
  assert.equal(code, 1);
  assert.match(stderr, /Not found\./, "a tool's isError text is shown verbatim");
  reply = (tool) => DEFAULTS[tool] ?? { ok: true };
}

{
  status = 401;
  const { code, stderr } = await flone(['ls']);
  assert.equal(code, 1);
  assert.match(stderr, /flone login/, 'a 401 tells you how to fix it');
  status = 200;
}

{
  const { code, stderr } = await flone(['nonsense']);
  assert.equal(code, 1);
  assert.match(stderr, /Unknown command/);
}

{
  const { code, stderr } = await flone(['ls', '--titel', 'typo']);
  assert.equal(code, 1, 'a mistyped flag is an error, not a silent positional');
  assert.match(stderr, /titel/);
}

/* -------------------------------------------------------------------------- */

server.close();
rmSync(home, { recursive: true, force: true });
console.log('ok — all CLI checks passed');
