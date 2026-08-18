#!/usr/bin/env node
/**
 * End-to-end check of the ATTACHMENT routes against a RUNNING server.
 *
 *   FLONE_MCP_TOKEN=<token> bun run smoke:attachments
 *   FLONE_URL=https://flone.example.com FLONE_MCP_TOKEN=... bun run smoke:attachments
 *
 * WHY THIS EXISTS. `check:bucket` asserts the rules as pure functions and cannot
 * see the routes; `mcp:smoke` exercises every tool and cannot see them either,
 * because an upload is multipart HTTP rather than a tool call. So the three things
 * KANB-11 actually asks for -- that an unauthorized caller is refused, that a
 * 25 MB file and a wrong type are refused THROUGH THE ROUTE, and that deleting an
 * issue takes its bucket objects with it -- had no automated check at all. They do
 * now, and the last one is the only thing anywhere that proves the purge reaches
 * the bucket rather than just Postgres.
 *
 * The routes take the session as `Authorization: Bearer`, exactly as `/api/mcp`
 * does -- the same credential, the same `requireUser`. That is what lets this run
 * without a browser.
 *
 * It builds a THROWAWAY organization of its own and deletes it in a `finally`, so
 * it is safe to point at production. ONE CAVEAT, by design: the compose-surface
 * upload (project target, no issue) leaves a 68-byte object in the bucket, because
 * nothing deletes an attachment that never belonged to an issue. That is the
 * documented orphan class, and this script is what proves it is only 68 bytes.
 *
 * WITHOUT A TOKEN the unauthenticated half still runs and the rest is SKIPPED, not
 * failed -- the same shape `mcp:smoke` uses for the admin tools.
 */

import assert from 'node:assert/strict';

const BASE = (process.env.FLONE_URL ?? 'http://localhost:3000').replace(/\/+$/, '');
const UPLOAD = `${BASE}/api/attachments`;
const TOKEN = process.env.FLONE_MCP_TOKEN;

const step = (message) => console.log(`  ${message}`);
let passed = 0;
async function check(name, run) {
  await run();
  passed += 1;
  step(name);
}

/** A 1x1 transparent PNG -- the smallest thing that is genuinely an image. */
const PIXEL = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8AAAwAB/wD/xk4AAAAASUVORK5CYII=',
  'base64',
);

/** `file` is `{ blob, name }`; every other field is sent as a plain text part. */
function upload({ token = TOKEN, file, ...fields }) {
  const form = new FormData();
  for (const [key, value] of Object.entries(fields)) form.set(key, value);
  if (file) form.set('file', file.blob, file.name);

  return fetch(UPLOAD, {
    method: 'POST',
    headers: token ? { authorization: `Bearer ${token}` } : {},
    body: form,
    redirect: 'manual',
  });
}

const png = (bytes = PIXEL) => ({
  blob: new Blob([bytes], { type: 'image/png' }),
  name: 'pixel.png',
});

function serve(url) {
  return fetch(`${BASE}${url}`, {
    headers: { authorization: `Bearer ${TOKEN}` },
    redirect: 'manual',
  });
}

console.log(`attachments smoke: ${UPLOAD}`);

/* -- unauthenticated: runs with or without a token ------------------------- */

await check('unauthenticated upload -> 401', async () => {
  const response = await upload({ token: '', projectId: 'cnotarealprojectid000000', file: png() });
  assert.equal(response.status, 401, `got ${response.status}`);
});

await check('unauthenticated serve -> 401, and never cached', async () => {
  const response = await fetch(`${BASE}/api/attachments/0f2a4c11-1111-4111-8111-111111111111`, {
    redirect: 'manual',
  });
  assert.equal(response.status, 401, `got ${response.status}`);
  assert.match(response.headers.get('cache-control') ?? '', /no-store/);
});

await check('a malformed attachment id -> 404 without a lookup', async () => {
  const response = await fetch(`${BASE}/api/attachments/not-an-id`, { redirect: 'manual' });
  assert.equal(response.status, 404, `got ${response.status}`);
});

if (!TOKEN) {
  console.log(`\nattachments smoke: ${passed} checks passed, authenticated checks SKIPPED.`);
  console.log('Set FLONE_MCP_TOKEN (app: account menu -> MCP access) to run the rest.');
  process.exit(0);
}

/* -- a throwaway organization to work in ----------------------------------- */

let nextId = 0;
async function tool(name, args = {}) {
  const response = await fetch(`${BASE}/api/mcp`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      authorization: `Bearer ${TOKEN}`,
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: (nextId += 1),
      method: 'tools/call',
      params: { name, arguments: args },
    }),
  });
  const body = await response.json();
  assert.ok(body?.result, `${name}: ${JSON.stringify(body?.error ?? body)}`);
  const text = body.result.content?.[0]?.text ?? '';
  assert.equal(body.result.isError, undefined, `${name} failed: ${text}`);
  return JSON.parse(text);
}

const stamp = Date.now().toString(36);
const orgName = `Attachment smoke ${stamp}`;
const org = await tool('create_organization', { name: orgName });
step(`create_organization -> ${org.orgSlug}`);

try {
  const workspace = await tool('create_workspace', { orgSlug: org.orgSlug, name: `ws ${stamp}` });
  const project = await tool('create_project', {
    orgSlug: org.orgSlug,
    workspaceSlug: workspace.workspaceSlug,
    name: `Smoke ${stamp}`,
    key: 'SMK',
  });
  const ticket = await tool('create_ticket', {
    orgSlug: org.orgSlug,
    projectKey: 'SMK',
    title: 'Attachment smoke target',
  });

  /* -- the happy path ------------------------------------------------------ */

  let uploaded;
  await check('upload against an issue -> 201 with a relative url', async () => {
    const response = await upload({ ticketId: ticket.ticketId, file: png() });
    assert.equal(response.status, 201, `got ${response.status}: ${await response.text()}`);
    uploaded = await response.json();
    assert.match(uploaded.url, /^\/api\/attachments\/[0-9a-f-]{36}$/);
    assert.equal(uploaded.filename, 'pixel.png');
  });

  let presigned;
  await check('serve -> 302 to a presigned url, uncacheable', async () => {
    const response = await serve(uploaded.url);
    assert.equal(response.status, 302, `got ${response.status}`);
    assert.match(response.headers.get('cache-control') ?? '', /private, no-store/);
    presigned = response.headers.get('location');
    assert.ok(presigned?.includes('X-Amz-Signature='), 'the redirect must be presigned');
  });

  await check('the presigned url returns the image bytes', async () => {
    const response = await fetch(presigned);
    assert.equal(response.status, 200, `got ${response.status}`);
    assert.equal(response.headers.get('content-type'), 'image/png');
    assert.equal((await response.arrayBuffer()).byteLength, PIXEL.byteLength);
  });

  await check('upload against a project (the compose surfaces) -> 201', async () => {
    const projectId = project.projectId ?? project.id;
    assert.ok(projectId, `create_project returned no id: ${JSON.stringify(project)}`);
    const response = await upload({ projectId, file: png() });
    assert.equal(response.status, 201, `got ${response.status}: ${await response.text()}`);
  });

  /* -- the trust boundary, through the route ------------------------------- */

  await check('a .exe renamed .png is refused with a clear error', async () => {
    const blob = new Blob([Buffer.from('MZ ')], { type: 'application/octet-stream' });
    const response = await upload({ ticketId: ticket.ticketId, file: { blob, name: 'setup.png' } });
    assert.equal(response.status, 400, `got ${response.status}`);
    assert.match((await response.json()).error, /PNG, JPEG, GIF and WebP/);
  });

  await check('25 MB is refused with a clear error', async () => {
    const blob = new Blob([Buffer.alloc(25 * 1024 * 1024)], { type: 'image/png' });
    const response = await upload({ ticketId: ticket.ticketId, file: { blob, name: 'huge.png' } });
    assert.equal(response.status, 400, `got ${response.status}`);
    assert.match((await response.json()).error, /larger than 10 MB/);
  });

  await check('an empty file is refused', async () => {
    const blob = new Blob([], { type: 'image/png' });
    const response = await upload({ ticketId: ticket.ticketId, file: { blob, name: 'empty.png' } });
    assert.equal(response.status, 400, `got ${response.status}`);
  });

  await check('an issue in no organization of mine -> 404', async () => {
    const response = await upload({ ticketId: 'c00000000000000000000000', file: png() });
    assert.equal(response.status, 404, `got ${response.status}`);
  });

  await check('no target at all -> 404', async () => {
    const response = await upload({ file: png() });
    assert.equal(response.status, 404, `got ${response.status}`);
  });

  /* -- delete takes the row AND the object -------------------------------- */

  await check('deleting the issue removes the attachment', async () => {
    await tool('delete_ticket', { ticketId: ticket.ticketId });
    const response = await serve(uploaded.url);
    assert.equal(response.status, 404, `got ${response.status}`);
  });

  await check('...and the bucket object is really gone', async () => {
    // The presigned url minted before the delete is still cryptographically valid
    // for another few minutes, so a 404 here is the OBJECT being absent rather than
    // the credential expiring. This is the assertion that proves `purgeTicket-
    // Attachments` reaches the bucket and not just Postgres.
    const response = await fetch(presigned);
    assert.equal(response.status, 404, `the object survived the delete (${response.status})`);
  });
} finally {
  await tool('delete_organization', { orgSlug: org.orgSlug, confirmName: orgName });
  step(`delete_organization -> ${org.orgSlug}`);
}

console.log(`\nattachments smoke: ${passed} checks passed.`);
console.log('One 68-byte compose-surface object is left in the bucket by design.');
