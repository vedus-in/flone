/**
 * Asserts the @mention tokenizer (`src/lib/mentions.ts`).
 *
 * This is the one piece of the feature that decides WHO GETS EMAILED, from
 * nothing but free text, and every way it can be wrong is silent:
 *
 *   1. LONGEST NAME FIRST. Regex alternation is leftmost-first, so `@Dana Reed`
 *      in an org that also has a "Dana" mails the wrong person unless the names
 *      are sorted by length. Nothing about that is visible in the UI -- the
 *      highlight looks right either way.
 *
 *   2. AN EMAIL ADDRESS IS NOT A MENTION. `ping dana@acme.com` must not tag
 *      Dana, or every comment quoting an address becomes a notification.
 *
 *   3. A PARTIAL NAME IS NOT A MENTION. `@Dan` where the member is `Dana` must
 *      match nobody: silently tagging the nearest name is worse than not
 *      tagging.
 *
 *   4. THE RENDERER AND THE MAILER MUST AGREE. Both derive from this file, so
 *      the highlight is the author's only feedback about who will be emailed.
 *      A body that highlights two names and mails three is a lie.
 *
 * Runs on Bun for the TSX in the import graph:
 *
 *   bun scripts/check-mentions.ts
 */

import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { findMentions } from '../src/lib/mentions';
import { Prose } from '../src/components/ui';

const MEMBERS = [
  { id: 'u1', name: 'Dana' },
  { id: 'u2', name: 'Dana Reed' },
  { id: 'u3', name: 'Sam Okoro' },
  { id: 'u4', name: 'J. P. Ng (ops)' },
];

const ids = (body: string) => findMentions(body, MEMBERS).map((member) => member.id);

let passed = 0;
function check(name: string, run: () => void) {
  try {
    run();
  } catch (error) {
    console.error(`FAIL  ${name}`);
    throw error;
  }
  passed += 1;
}

/* 1. The ordinary case, and the ambiguity in it. */
check('a mention names its member', () => {
  assert.deepEqual(ids('thanks @Sam Okoro'), ['u3']);
});

check('the longest matching name wins', () => {
  // Both members are plausible prefixes; only the longer one was typed.
  assert.deepEqual(ids('@Dana Reed can you look?'), ['u2']);
  assert.deepEqual(ids('@Dana can you look?'), ['u1']);
});

check('case does not matter', () => {
  assert.deepEqual(ids('@dana reed and @SAM OKORO'), ['u2', 'u3']);
});

check('a name with regex punctuation is matched literally', () => {
  assert.deepEqual(ids('@J. P. Ng (ops) please review'), ['u4']);
  // The escaping is what stops `.` and `(` from matching anything else.
  assert.deepEqual(ids('@JxPxNgx(ops)'), []);
});

check('the same person twice is reported once', () => {
  assert.deepEqual(ids('@Dana @Dana'), ['u1']);
});

/* 2. What must NOT tag anyone. */
check('an email address is not a mention', () => {
  assert.deepEqual(ids('mail dana@acme.com about it'), []);
  assert.deepEqual(ids('dana.reed@acme.com'), []);
});

check('a partial or extended name is not a mention', () => {
  assert.deepEqual(ids('@Dan'), []);
  assert.deepEqual(ids('@Danae'), []);
});

check('a bare @ tags nobody', () => {
  assert.deepEqual(ids('@ Dana'), []);
  assert.deepEqual(ids('what @'), []);
  assert.deepEqual(ids('user@'), []);
});

check('an unknown name tags nobody', () => {
  assert.deepEqual(ids('@Nobody At All'), []);
});

check('no members means no matches, not a crash', () => {
  assert.deepEqual(findMentions('@Dana', []), []);
});

/* 3. Punctuation around a mention is not part of it. */
check('trailing punctuation ends a mention', () => {
  assert.deepEqual(ids('cc @Dana, @Sam Okoro!'), ['u1', 'u3']);
  assert.deepEqual(ids('(@Dana)'), ['u1']);
});

/* 4. The renderer agrees with the mailer, on the same input. */
const names = MEMBERS.map((member) => member.name);
const html = (body: string) =>
  renderToStaticMarkup(createElement(Prose, { mentions: names, children: body }));

check('a mention renders as a chip', () => {
  const out = html('thanks @Dana Reed');
  assert.match(out, /<span class="mention">@Dana Reed<\/span>/);
});

check('the highlight and the notification pick the same names', () => {
  const body = 'cc @Dana Reed and @Sam Okoro, not dana@acme.com or @Dan';
  const chips = [...html(body).matchAll(/<span class="mention">@([^<]+)<\/span>/g)].map(
    (match) => match[1],
  );
  assert.deepEqual(chips, ['Dana Reed', 'Sam Okoro']);
  assert.deepEqual(ids(body), ['u2', 'u3']);
});

check('a mention inside code stays literal', () => {
  // `code` and `inlineCode` carry their text as a value on their own node type,
  // so the walk never reaches it -- which is what keeps a shell snippet intact.
  assert.doesNotMatch(html('run `deploy @Dana`'), /class="mention"/);
  assert.doesNotMatch(html('```\n@Dana Reed\n```'), /class="mention"/);
});

check('markdown around a mention still renders', () => {
  const out = html('- **cc** @Sam Okoro\n- [docs](https://example.com)');
  assert.match(out, /<strong>cc<\/strong>/);
  assert.match(out, /<span class="mention">@Sam Okoro<\/span>/);
  assert.match(out, /href="https:\/\/example\.com"/);
});

check('without the member list nothing is highlighted', () => {
  const out = renderToStaticMarkup(createElement(Prose, null, 'hi @Dana Reed'));
  assert.doesNotMatch(out, /class="mention"/);
  assert.match(out, /@Dana Reed/);
});

console.log(`check-mentions: ${passed} checks passed`);
