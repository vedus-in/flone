/**
 * Asserts what `Prose` (`src/components/ui.tsx`) does with a hostile or awkward
 * comment body.
 *
 * `Prose` is four lines of plugin configuration, and every line of it is load
 * bearing in a way a type check cannot see:
 *
 *   1. RAW HTML MUST NOT BECOME HTML. This is the whole XSS posture (§4.9).
 *      Adding `rehype-raw` -- the first thing anyone reaches for when a user
 *      asks why their `<details>` block does not work -- turns every comment
 *      body into markup. Nothing else in the repo would notice: no type error,
 *      no failing page, just a stored `<script>` that runs. The CSP is not
 *      nonce-based and will not save us.
 *
 *   2. `javascript:` LINKS MUST NOT SURVIVE. react-markdown filters URLs by
 *      default; passing a custom `urlTransform` silently removes that.
 *
 *   3. A SINGLE NEWLINE MUST STAY A LINE BREAK. Every comment in the database
 *      was typed into a plain textarea and rendered with `white-space:
 *      pre-wrap`. Dropping `remark-breaks` reflows all of it into paragraphs --
 *      a silent rewrite of existing content, visible only by eye.
 *
 *   4. TABLES MUST RENDER. `remark-gfm` is the only reason they do, and a
 *      pipe table with no GFM degrades to a paragraph of pipes rather than to
 *      an error.
 *
 * Runs on Bun, for the tsconfig `@/` paths and the TSX in the import graph:
 *
 *   bun scripts/check-markdown.ts
 */

import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { Prose } from '../src/components/ui';

const html = (markdown: string) => renderToStaticMarkup(createElement(Prose, null, markdown));

let passed = 0;
function check(name: string, run: () => void) {
  run();
  passed += 1;
  void name;
}

/*
 * 1. Raw HTML is text, not markup. `onerror=` is expected to appear in the
 *    output -- as escaped characters inside a text node, which is exactly the
 *    point. What must never appear is a real tag.
 */
check('script tags are inert', () => {
  const out = html('<script>alert(1)</script>\n\n<img src=x onerror=alert(1)>');
  assert.doesNotMatch(out, /<script|<img/);
  assert.match(out, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.match(out, /&lt;img src=x onerror=alert\(1\)&gt;/);
});

check('inline html is escaped', () => {
  const out = html('Hello <b>there</b> and <div onclick="x()">gone</div>');
  assert.doesNotMatch(out, /<b>|<div onclick/);
  assert.match(out, /&lt;b&gt;there&lt;\/b&gt;/);
});

/* 2. Dangerous URLs are dropped, ordinary ones are kept. */
check('javascript: urls are stripped', () => {
  const out = html('[click](javascript:alert(1))');
  assert.doesNotMatch(out, /javascript:/);
});

check('http links survive', () => {
  assert.match(html('[docs](https://example.com/a)'), /href="https:\/\/example\.com\/a"/);
});

/* 3. remark-breaks: one newline is one line break. */
check('single newlines are line breaks', () => {
  const out = html('line one\nline two');
  assert.match(out, /<br\s*\/?>/);
});

/* 4. remark-gfm: tables, strikethrough, task lists, bare URLs. */
check('pipe tables become tables', () => {
  const out = html('| Command | Result |\n|---|---|\n| `a` | ok |');
  assert.match(out, /<table>/);
  assert.match(out, /<th>Command<\/th>/);
  assert.match(out, /<code>a<\/code>/);
});

check('gfm extras render', () => {
  assert.match(html('~~gone~~'), /<del>/);
  assert.match(html('see https://example.com now'), /<a href="https:\/\/example\.com"/);
});

/**
 * The checkbox is `disabled` because nothing writes back -- a tickable box in a
 * rendered comment is a control that silently discards the click. `globals.css`
 * styles this element on the strength of that.
 */
check('task list checkboxes are disabled', () => {
  const out = html('- [x] done\n- [ ] todo');
  assert.match(out, /<input[^>]*type="checkbox"/);
  assert.match(out, /<input[^>]*disabled/);
});

/* 5. The ordinary case: headings, emphasis and inline code. */
check('common syntax renders', () => {
  const out = html('## Reviewed\n\nSome **bold** and `bun test` here.');
  assert.match(out, /<h2>Reviewed<\/h2>/);
  assert.match(out, /<strong>bold<\/strong>/);
  assert.match(out, /<code>bun test<\/code>/);
});

/* 6. Empty and whitespace-only bodies must not throw. */
check('empty input renders nothing', () => {
  assert.doesNotMatch(html(''), /<p>/);
});

console.log(`check-markdown: ${passed} checks passed`);
