#!/usr/bin/env node
/**
 * End-to-end check of /api/mcp against a RUNNING server.
 *
 *   KANBAN_MCP_TOKEN=<token> bun run mcp:smoke
 *   KANBAN_URL=https://kanban.example.com KANBAN_MCP_TOKEN=... bun run mcp:smoke
 *
 * It creates a ticket on the first board it can see and deletes it again, so it
 * exercises the write path for real. Nothing else is touched.
 */

import assert from 'node:assert/strict';

const BASE = (process.env.KANBAN_URL ?? 'http://localhost:3000').replace(/\/+$/, '');
const ENDPOINT = `${BASE}/api/mcp`;
const TOKEN = process.env.KANBAN_MCP_TOKEN;

if (!TOKEN) {
  console.error('KANBAN_MCP_TOKEN is not set. Create one in the app: account menu -> MCP access.');
  process.exit(2);
}

let nextId = 0;

async function rpc(method, params, { token = TOKEN } = {}) {
  const response = await fetch(ENDPOINT, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: (nextId += 1), method, params }),
  });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : null };
}

/** Unwraps a tools/call result; asserts it did not come back as an error. */
async function call(name, args = {}) {
  const { body } = await rpc('tools/call', { name, arguments: args });
  assert.ok(body?.result, `${name}: ${JSON.stringify(body?.error ?? body)}`);
  const text = body.result.content?.[0]?.text ?? '';
  assert.equal(body.result.isError, undefined, `${name} failed: ${text}`);
  return JSON.parse(text);
}

const step = (message) => console.log(`  ${message}`);

console.log(`MCP smoke: ${ENDPOINT}`);

/* -- handshake ------------------------------------------------------------- */

const init = await rpc('initialize', {
  protocolVersion: '2025-06-18',
  capabilities: {},
  clientInfo: { name: 'mcp-smoke', version: '0' },
});
assert.equal(init.status, 200, `initialize returned ${init.status}`);
assert.equal(init.body.result.serverInfo.name, 'kanban');
assert.equal(init.body.result.protocolVersion, '2025-06-18');
assert.ok(init.body.result.capabilities.tools);
step(`initialize ok (protocol ${init.body.result.protocolVersion})`);

/* -- notifications get 202 and no body ------------------------------------- */

const notified = await fetch(ENDPOINT, {
  method: 'POST',
  headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` },
  body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
});
assert.equal(notified.status, 202, 'a notification must be accepted with 202');
step('notifications/initialized -> 202');

/* -- a bad token must be 401, not an empty tool list ----------------------- */

const anonymous = await rpc('tools/list', {}, { token: '' });
assert.equal(anonymous.status, 401, 'an unauthenticated call must be 401');
const wrong = await rpc('tools/list', {}, { token: 'not-a-real-token' });
assert.equal(wrong.status, 401, 'a bad token must be 401');
step('unauthenticated -> 401');

/* -- tools ----------------------------------------------------------------- */

const { body: listed } = await rpc('tools/list');
const names = listed.result.tools.map((tool) => tool.name).sort();
assert.deepEqual(names, [
  'comment_ticket',
  'create_ticket',
  'delete_ticket',
  'get_board',
  'get_ticket',
  'list_boards',
  'move_ticket',
  'search_tickets',
  'update_ticket',
]);
for (const tool of listed.result.tools) {
  assert.equal(tool.inputSchema.type, 'object', `${tool.name} needs an object inputSchema`);
  assert.ok(tool.description, `${tool.name} needs a description`);
  assert.equal(tool.run, undefined, `${tool.name} must not leak its handler`);
}
step(`tools/list -> ${names.length} tools`);

/* -- a tool error is a result, not a transport error ----------------------- */

const bogus = await rpc('tools/call', {
  name: 'get_ticket',
  arguments: { ticketId: 'definitely-not-a-cuid' },
});
assert.equal(bogus.status, 200);
assert.equal(bogus.body.result.isError, true, 'a bad argument must come back as isError');
step('bad argument -> isError result');

/* -- read ------------------------------------------------------------------ */

const { organizations } = await call('list_boards');
const board = organizations
  .flatMap((org) => org.projects)
  .flatMap((project) => project.boards)[0];

if (!board) {
  console.log('\nNo board visible to this token — read path verified, write path skipped.');
  process.exit(0);
}

const boardData = await call('get_board', { boardId: board.id });
assert.ok(boardData.columns.length > 0, 'a board must have columns');
step(`get_board -> ${boardData.board} (${boardData.columns.length} columns)`);

/* -- write, then clean up -------------------------------------------------- */

const title = `mcp smoke ${new Date().toISOString()}`;
const created = await call('create_ticket', {
  boardId: board.id,
  title,
  description: 'Created by scripts/mcp-smoke.mjs. Safe to delete.',
});
assert.ok(created.ticketId, 'create_ticket must return the new ticket id');
step(`create_ticket -> ${created.ref}`);

try {
  const fetched = await call('get_ticket', { ticketId: created.ticketId });
  assert.equal(fetched.title, title);

  const updated = await call('update_ticket', {
    ticketId: created.ticketId,
    priority: 'HIGH',
    dueDate: '2030-01-01',
  });
  assert.deepEqual(updated.updated, ['priority', 'dueDate']);

  const lastColumn = boardData.columns[boardData.columns.length - 1].name;
  await call('move_ticket', { ticketId: created.ticketId, column: lastColumn, position: 0 });
  await call('comment_ticket', { ticketId: created.ticketId, body: 'smoke test comment' });

  const after = await call('get_ticket', { ticketId: created.ticketId });
  assert.equal(after.priority, 'HIGH');
  assert.equal(after.dueDate, '2030-01-01');
  assert.equal(after.column, lastColumn);
  assert.equal(after.comments.length, 1);
  step(`update + move + comment ok (now in ${after.column})`);

  const found = await call('search_tickets', { query: title });
  assert.ok(
    found.tickets.some((ticket) => ticket.ticketId === created.ticketId),
    'search_tickets must find the ticket it just created',
  );
  step('search_tickets ok');
} finally {
  await call('delete_ticket', { ticketId: created.ticketId });
  step(`delete_ticket -> ${created.ref}`);
}

console.log('\nAll good.');
