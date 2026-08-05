#!/usr/bin/env node
/**
 * End-to-end check of /api/mcp against a RUNNING server.
 *
 *   KANBAN_MCP_TOKEN=<token> bun run mcp:smoke
 *   KANBAN_URL=https://kanban.example.com KANBAN_MCP_TOKEN=... bun run mcp:smoke
 *
 * It builds a THROWAWAY organization of its own — project, two boards, a ticket,
 * a comment — exercises every tool against it, then deletes the organization in
 * a `finally`. Your real boards are never touched, so this is safe to point at
 * production.
 *
 * The three admin_* tools are skipped, not failed, when the token does not
 * belong to a site administrator.
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

/** For tools that may legitimately be refused (the admin ones, for a non-admin). */
async function tryCall(name, args = {}) {
  const { body } = await rpc('tools/call', { name, arguments: args });
  const text = body?.result?.content?.[0]?.text ?? '';
  if (body?.result?.isError) return { ok: false, message: text };
  return { ok: true, data: JSON.parse(text) };
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
  'add_member',
  'admin_list_users',
  'admin_set_registration',
  'admin_set_user_admin',
  'create_board',
  'create_comment',
  'create_organization',
  'create_project',
  'create_ticket',
  'delete_board',
  'delete_comment',
  'delete_organization',
  'delete_project',
  'delete_ticket',
  'get_board',
  'get_organization',
  'get_ticket',
  'list_boards',
  'move_ticket',
  'move_ticket_to_board',
  'remove_member',
  'rename_board',
  'rename_organization',
  'search_tickets',
  'set_member_role',
  'update_comment',
  'update_project',
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


/* -- read the tree ---------------------------------------------------------- */

const before = await call('list_boards');
step(`list_boards -> ${before.organizations.length} organizations`);

/* -- a throwaway organization, so nothing real is touched ------------------- */

const stamp = new Date().toISOString().replace(/[:.]/g, '-');
let orgName = `MCP smoke ${stamp}`;

const org = await call('create_organization', { name: orgName });
assert.ok(org.orgSlug, 'create_organization must return the new slug');
const orgSlug = org.orgSlug;
step(`create_organization -> ${orgSlug}`);

try {
  const detail = await call('get_organization', { orgSlug });
  assert.equal(detail.yourRole, 'OWNER', 'the creator must be OWNER');
  assert.equal(detail.members.length, 1);
  assert.ok(detail.members[0].membershipId, 'members need a membershipId');
  step(`get_organization -> OWNER, ${detail.members.length} member`);

  /* -- project + boards --------------------------------------------------- */

  const project = await call('create_project', {
    orgSlug,
    name: 'Smoke',
    key: 'SMOKE',
    description: 'Created by scripts/mcp-smoke.mjs.',
  });
  const projectKey = project.projectKey ?? 'SMOKE';
  step(`create_project -> ${projectKey}`);

  const board = await call('create_board', { orgSlug, projectKey, name: 'Main' });
  assert.ok(board.boardId, 'create_board must return the new board id');
  const spare = await call('create_board', { orgSlug, projectKey, name: 'Spare' });
  step(`create_board -> ${board.boardId}, ${spare.boardId}`);

  const boardData = await call('get_board', { boardId: board.boardId });
  assert.deepEqual(
    boardData.columns.map((column) => column.name),
    ['To Do', 'In Progress', 'Done'],
    'a new board is seeded with three columns',
  );
  step('get_board -> To Do / In Progress / Done');

  /* -- ticket lifecycle ---------------------------------------------------- */

  const title = `smoke ticket ${stamp}`;
  const ticket = await call('create_ticket', {
    boardId: board.boardId,
    title,
    description: 'Safe to delete.',
    column: 'In Progress',
  });
  assert.ok(ticket.ticketId, 'create_ticket must return the new ticket id');
  assert.equal(ticket.column, 'In Progress', 'column must be addressable by name');
  step(`create_ticket -> ${ticket.ref} in ${ticket.column}`);

  const me = detail.members[0];
  const updated = await call('update_ticket', {
    ticketId: ticket.ticketId,
    priority: 'HIGH',
    dueDate: '2030-01-01',
    assignee: me.email,
  });
  assert.deepEqual(updated.updated, ['priority', 'dueDate', 'assignee']);

  await call('move_ticket', { ticketId: ticket.ticketId, column: 'Done', position: 0 });

  const comment = await call('create_comment', { ticketId: ticket.ticketId, body: 'first' });
  assert.equal(comment.ok, true);

  const withComment = await call('get_ticket', { ticketId: ticket.ticketId });
  assert.equal(withComment.priority, 'HIGH');
  assert.equal(withComment.dueDate, '2030-01-01');
  assert.equal(withComment.column, 'Done');
  assert.equal(withComment.assignee.email, me.email);
  assert.equal(withComment.comments.length, 1);
  step('update + move + assign + comment ok');

  const commentId = withComment.comments[0].commentId;
  await call('update_comment', { commentId, body: 'edited' });
  const edited = await call('get_ticket', { ticketId: ticket.ticketId });
  assert.equal(edited.comments[0].body, 'edited');
  await call('delete_comment', { commentId });
  const cleared = await call('get_ticket', { ticketId: ticket.ticketId });
  assert.equal(cleared.comments.length, 0);
  step('comment edit + delete ok');

  const found = await call('search_tickets', { query: title });
  assert.ok(
    found.tickets.some((row) => row.ticketId === ticket.ticketId),
    'search_tickets must find the ticket it just created',
  );
  step('search_tickets ok');

  const moved = await call('move_ticket_to_board', {
    ticketId: ticket.ticketId,
    toBoardId: spare.boardId,
  });
  assert.equal(moved.board, 'Spare');
  step(`move_ticket_to_board -> ${moved.ref} on ${moved.board}`);

  /* -- renames ------------------------------------------------------------- */

  await call('rename_board', { boardId: spare.boardId, name: 'Spare renamed' });
  await call('update_project', { orgSlug, projectKey, name: 'Smoke renamed' });
  orgName = `MCP smoke renamed ${stamp}`;
  await call('rename_organization', { orgSlug, name: orgName });
  const renamed = await call('get_organization', { orgSlug });
  assert.equal(renamed.organization, orgName);
  assert.equal(renamed.projects[0].name, 'Smoke renamed');
  // Renaming must not wipe the field that was not passed.
  assert.equal(
    renamed.projects[0].description,
    'Created by scripts/mcp-smoke.mjs.',
    'update_project must leave an omitted description alone',
  );
  step('rename board + project + organization ok (description preserved)');

  /* -- guard rails --------------------------------------------------------- */

  const wrongConfirm = await tryCall('delete_project', {
    orgSlug,
    projectKey,
    confirmKey: 'NOPE',
  });
  assert.equal(wrongConfirm.ok, false, 'delete_project must reject a wrong confirmKey');
  step('delete_project rejects a wrong confirmation');

  /* -- teardown of the inner resources ------------------------------------- */

  await call('delete_ticket', { ticketId: ticket.ticketId });
  await call('delete_board', { boardId: spare.boardId });
  await call('delete_project', { orgSlug, projectKey, confirmKey: projectKey });
  step('delete ticket + board + project ok');

  /* -- site administration (optional: only a site admin may) --------------- */

  const admin = await tryCall('admin_list_users');
  if (admin.ok) {
    assert.ok(admin.data.total >= 1);
    assert.ok(typeof admin.data.registrationOpen === 'boolean');
    step(`admin_list_users -> ${admin.data.total} accounts`);
  } else {
    step(`admin tools not available to this token (${admin.message}) — skipped`);
  }
} finally {
  await call('delete_organization', { orgSlug, confirmName: orgName });
  step(`delete_organization -> ${orgSlug}`);
}

console.log('\nAll good.');
