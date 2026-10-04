/**
 * Asserts that no element asks for a focus ring and cancels it in the same
 * breath.
 *
 * THE BUG THIS EXISTS FOR. Tailwind v4 compiles the two utilities like this:
 *
 *   .outline-none { --tw-outline-style: none; outline-style: none; }
 *   .outline-2    { outline-style: var(--tw-outline-style); outline-width: 2px; }
 *
 * `outline-none` is unconditional, so it sets `--tw-outline-style: none` on the
 * element for good. A `focus-visible:outline-2` beside it then widens an outline
 * whose STYLE still resolves through that variable -- to `none`. The ring is
 * 2px wide, the right colour, and never painted.
 *
 * This is a v3 habit that v4 quietly broke: there, `outline-none` meant
 * `outline: 2px solid transparent` and pairing the two was the documented way to
 * swap the browser ring for your own. It now means what it says, and the pairing
 * reads as correct in review while shipping no focus indicator at all.
 *
 * It had shipped on eight elements, including every primary link in the sidebar,
 * where nothing else marked focus -- so keyboard navigation of the app's main
 * nav had no visible position (WCAG 2.4.7). Typecheck cannot see it, the classes
 * look deliberate, and the only way to notice by eye is to tab through a page
 * and watch for nothing happening.
 *
 * Nothing stops it coming back except this file.
 *
 * WHAT IS ALLOWED. Dropping `outline-none` is the fix: `--tw-outline-style` is
 * declared with `initial-value: solid`, so the `focus-visible:outline-*` left
 * behind paints on its own. Suppressing a ring with no replacement is still
 * fine -- `outline-none` alone is how a wrapper hands focus styling to a child,
 * and this says nothing about it. Only the self-cancelling PAIR is an error.
 *
 *   bun scripts/check-focus-ring.ts
 */

import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../src', import.meta.url));

/** The killers, and the thing they kill. Both v4 spellings of "no outline". */
const SUPPRESS = /\boutline-(?:none|hidden)\b/;
const REQUEST = /(?:\bfocus(?:-visible|-within)?|data-\[focus(?:-visible)?\]):outline(?:-(?:\d|\[)|(?![\w-]))/;

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) out.push(...sourceFiles(path));
    else if (/\.tsx?$/.test(entry)) out.push(path);
  }
  return out;
}

/**
 * Per LINE, not per file. A file may legitimately hold one element that
 * suppresses its ring and another that draws one; it is a single class string
 * carrying both that can never paint. Class strings in this repo are written on
 * one line, which is what makes the line the right unit.
 */
const offenders: string[] = [];
let scanned = 0;

for (const path of sourceFiles(ROOT)) {
  const lines = readFileSync(path, 'utf8').split(/\r?\n/);
  scanned += 1;
  lines.forEach((line, index) => {
    if (SUPPRESS.test(line) && REQUEST.test(line)) {
      offenders.push(`${path.slice(ROOT.length - 3)}:${index + 1}\n    ${line.trim()}`);
    }
  });
}

assert.equal(
  offenders.length,
  0,
  `A focus ring is cancelled by an "outline-none"/"outline-hidden" on the same element.\n` +
    `Tailwind v4 resolves outline-style through --tw-outline-style, which those set to\n` +
    `"none" unconditionally -- so the focus-visible outline beside them never paints.\n` +
    `Drop the suppressing class; the initial value of --tw-outline-style is "solid".\n\n` +
    offenders.map((o) => `  ${o}`).join('\n\n'),
);

console.log(`check-focus-ring: ${scanned} files scanned, no self-cancelling focus rings`);
