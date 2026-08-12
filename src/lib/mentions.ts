/**
 * @mentions in a comment body.
 *
 * A mention is the literal text `@<member name>`. There is no id in the stored
 * body and no mention table: THE BODY IS THE RECORD. The highlight in the
 * rendered comment and the notification email are both derived from it by the
 * same tokenizer below, so the two can never disagree about who was tagged --
 * including after an edit, where a stored list would have to be reconciled.
 *
 * Nothing here is trusted for authorization. `findMentions` only ever reports
 * members from the list it is handed, and every caller builds that list from an
 * already-authorized organization, so a body cannot name its way out of the
 * tenant.
 *
 * ponytail: name matching, not ids. Two members with the same display name are
 * both notified, and renaming a member unlinks their existing mentions. Store
 * `@[Name](userId)` and parse that instead if either ever matters.
 */

export type Mentionable = { id: string; name: string };

const REGEX_SPECIAL = /[.*+?^${}()|[\]\\]/g;

/**
 * One alternation over the known names, LONGEST FIRST -- regex alternation is
 * leftmost-first, so without the sort `@Dana` would win over `@Dana Reed` and
 * tag the wrong person.
 *
 * The lookarounds are what keep `dana@acme.com` (a preceding word character)
 * and `@Danae` (a trailing one) from matching `@Dana`.
 *
 * Returns null when there is nothing to match, because an empty alternation
 * `@()` matches a bare `@`.
 */
export function mentionPattern(names: readonly string[]): RegExp | null {
  const usable = [...new Set(names.map((name) => name.trim()).filter(Boolean))].sort(
    (a, b) => b.length - a.length,
  );
  if (usable.length === 0) return null;

  const alternation = usable.map((name) => name.replace(REGEX_SPECIAL, '\\$&')).join('|');
  return new RegExp(`(?<![\\w@])@(${alternation})(?![\\w])`, 'gi');
}

/** The members named in `body`, deduplicated, in the order they were given. */
export function findMentions<T extends Mentionable>(body: string, members: readonly T[]): T[] {
  const pattern = mentionPattern(members.map((member) => member.name));
  if (!pattern) return [];

  const named = new Set(
    Array.from(body.matchAll(pattern), (match) => match[1].toLocaleLowerCase()),
  );
  return members.filter((member) => named.has(member.name.trim().toLocaleLowerCase()));
}

/* -------------------------------------------------------------------------- */
/* Rendering                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * The shape of an mdast node, to the extent this file touches one. Written out
 * rather than imported so nothing here depends on a transitive package of
 * react-markdown.
 */
type MdNode = { type: string; value?: string; data?: unknown; children?: MdNode[] };

function mention(text: string): MdNode {
  // `data.hName` is mdast-util-to-hast's escape hatch for a node type it does
  // not know: it renders this one as `<span class="mention">`, styled by the
  // `markdown` utility in globals.css.
  return {
    type: 'mention',
    data: { hName: 'span', hProperties: { className: 'mention' } },
    children: [{ type: 'text', value: text }],
  };
}

/** Null when the text holds no mention, so the caller can keep the node as-is. */
function splitText(value: string, pattern: RegExp): MdNode[] | null {
  pattern.lastIndex = 0;
  const parts: MdNode[] = [];
  let cut = 0;

  for (const match of value.matchAll(pattern)) {
    const start = match.index ?? 0;
    if (start > cut) parts.push({ type: 'text', value: value.slice(cut, start) });
    parts.push(mention(match[0]));
    cut = start + match[0].length;
  }

  if (parts.length === 0) return null;
  if (cut < value.length) parts.push({ type: 'text', value: value.slice(cut) });
  return parts;
}

/**
 * A remark plugin that wraps every mention in a span. Only `text` nodes are
 * touched, so an `@name` inside a code span or fenced block stays literal --
 * those carry their content as `value` on a node of another type.
 */
export function remarkMentions(names: readonly string[]) {
  const pattern = mentionPattern(names);

  function walk(node: MdNode): void {
    if (!node.children || node.children.length === 0 || !pattern) return;

    const next: MdNode[] = [];
    let changed = false;

    for (const child of node.children) {
      const parts = child.type === 'text' ? splitText(child.value ?? '', pattern) : null;
      if (parts) {
        next.push(...parts);
        changed = true;
      } else {
        walk(child);
        next.push(child);
      }
    }

    if (changed) node.children = next;
  }

  return () => walk;
}
