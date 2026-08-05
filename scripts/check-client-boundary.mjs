/**
 * Fails when a Server Component dots into a value imported from a `'use client'`
 * module.
 *
 * A Server Component never executes a client module -- it receives one opaque
 * client reference per export. So a part attached to a component at runtime
 * (`Table.Header = ...`, `EmptyState.Title = ...`) or a plain object export
 * (Untitled UI's `styles`) reads as `undefined` on the server, and React fails
 * at render with error #130 ("element type is invalid").
 *
 * Nothing else catches this. The types are correct -- TypeScript sees the real
 * module. And `next build` only prerenders STATIC routes, so a dynamic page
 * fails the first time a human opens it, in production. That is exactly how
 * /tokens and /orgs/[orgSlug]/settings shipped broken.
 *
 * The fix is always the same: do the property access inside a client module and
 * re-export each part as its own named export. See `src/components/table.tsx`.
 *
 * Run: `bun run check:boundary`
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname, resolve, relative } from 'node:path';

const ROOT = 'src';
const EXTS = ['.tsx', '.ts'];

/** Third-party packages that ship `'use client'` in their component modules. */
const CLIENT_PACKAGES = ['react-aria-components', '@base-ui/react'];

function walk(dir) {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) return walk(full);
    return EXTS.some((ext) => full.endsWith(ext)) ? [full] : [];
  });
}

const files = walk(ROOT);
const source = new Map(files.map((file) => [file, readFileSync(file, 'utf8')]));

const isClient = (file) => /^\s*['"]use client['"]/m.test(source.get(file).slice(0, 400));
const clientFiles = new Set(files.filter(isClient));

function resolveSpec(spec, importer) {
  let base;
  if (spec.startsWith('@/')) base = join(ROOT, spec.slice(2));
  else if (spec.startsWith('.')) base = relative(process.cwd(), resolve(dirname(importer), spec));
  else return null;

  for (const ext of EXTS) {
    if (source.has(base + ext)) return base + ext;
    if (source.has(join(base, `index${ext}`))) return join(base, `index${ext}`);
  }
  return null;
}

const IMPORT = /import\s+(type\s+)?(\{[^}]*\}|[\w*]+)[^'"]*from\s*['"]([^'"]+)['"]/g;
const violations = [];

for (const file of files) {
  if (clientFiles.has(file)) continue; // client modules may dot freely

  const text = source.get(file);
  const body = text.replace(IMPORT, ''); // don't match the import statement itself

  for (const [, typeOnly, clause, spec] of text.matchAll(IMPORT)) {
    if (typeOnly) continue;

    const target = resolveSpec(spec, file);
    const targetIsClient = target
      ? clientFiles.has(target)
      : CLIENT_PACKAGES.some((pkg) => spec === pkg || spec.startsWith(`${pkg}/`));
    if (!targetIsClient) continue;

    const names = clause.startsWith('{')
      ? clause
          .slice(1, -1)
          .split(',')
          .map((part) => part.trim())
          .filter((part) => part && !part.startsWith('type '))
          .map((part) => part.split(' as ').pop().trim())
      : clause === '*'
        ? []
        : [clause.trim()];

    for (const name of names) {
      const hits = [...new Set(body.match(new RegExp(`\\b${name}\\.\\w+`, 'g')) ?? [])];
      if (hits.length > 0) violations.push({ file, name, spec, hits });
    }
  }
}

if (violations.length === 0) {
  console.log('OK — no Server Component dots into a client-module import');
  process.exit(0);
}

console.error(`${violations.length} client-boundary violation(s):\n`);
for (const { file, name, spec, hits } of violations) {
  console.error(`  ${file}`);
  console.error(`      ${name} (from ${spec}) → ${hits.join(', ')}`);
}
console.error('\nThese read as `undefined` at render. Flatten the parts into named');
console.error('exports from a client module — see src/components/table.tsx.');
process.exit(1);
