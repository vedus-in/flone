/**
 * Output. Colour when a person is looking, plain text when a pipe is.
 *
 * Hand-rolled rather than pulled from chalk + a table package: it is forty
 * lines, and the two rules that actually matter — honour NO_COLOR, never emit
 * escapes into a pipe — are one line each.
 */

const COLOR =
  process.stdout.isTTY === true &&
  process.env.NO_COLOR === undefined &&
  process.env.TERM !== 'dumb';

const ESC = '\u001B';

function wrap(code: string) {
  return (text: string): string => (COLOR ? `${ESC}[${code}m${text}${ESC}[0m` : text);
}

export const style = {
  bold: wrap('1'),
  dim: wrap('2'),
  red: wrap('31'),
  green: wrap('32'),
  yellow: wrap('33'),
  blue: wrap('34'),
  magenta: wrap('35'),
  cyan: wrap('36'),
  plain: (text: string) => text,
};

/** Length ignoring the escape sequences, so padding lines up when coloured. */
export function width(text: string): number {
  // ponytail: counts code units, so wide CJK and emoji under-measure and a
  // table containing them sits a column or two narrow. Upgrade path: a
  // grapheme/east-asian-width table if anyone files a board in Japanese.
  return text.replace(/\u001B\[[0-9;]*m/g, '').length;
}

export function truncate(text: string, max: number): string {
  if (max <= 0) return '';
  if (width(text) <= max) return text;

  // Slicing raw would cut a colour code in half and leak escapes into the
  // terminal, so a styled cell is truncated by its plain text and re-wrapped.
  const plain = text.replace(/\u001B\[[0-9;]*m/g, '');
  const cut = `${plain.slice(0, Math.max(0, max - 1))}…`;
  return text === plain ? cut : `${ESC}[0m${cut}`;
}

export function pad(text: string, to: number): string {
  return text + ' '.repeat(Math.max(0, to - width(text)));
}

export function terminalWidth(): number {
  return process.stdout.columns && process.stdout.columns > 20 ? process.stdout.columns : 100;
}

/**
 * Columns are sized to their content, then the widest is squeezed until the row
 * fits the terminal — so a long title loses characters before a ref does.
 */
export function table(rows: string[][], head?: string[]): string {
  const all = head ? [head, ...rows] : rows;
  if (all.length === 0) return '';

  const count = Math.max(...all.map((row) => row.length));
  const widths = Array.from({ length: count }, (_, i) =>
    Math.max(...all.map((row) => width(row[i] ?? ''))),
  );

  const GAP = 2;
  const budget = terminalWidth() - GAP * (count - 1);
  let total = widths.reduce((sum, w) => sum + w, 0);

  while (total > budget) {
    const widest = widths.indexOf(Math.max(...widths));
    if (widths[widest]! <= 8) break;
    widths[widest] = widths[widest]! - 1;
    total -= 1;
  }

  const line = (row: string[], paint: (s: string) => string) =>
    row
      .map((cell, i) => pad(truncate(paint(cell ?? ''), widths[i]!), widths[i]!))
      .join(' '.repeat(GAP))
      .trimEnd();

  const body = rows.map((row) => line(row, style.plain));
  return head ? [line(head, style.dim), ...body].join('\n') : body.join('\n');
}

/* -------------------------------------------------------------------------- */
/* Domain colours                                                              */
/* -------------------------------------------------------------------------- */

const PRIORITY: Record<string, (s: string) => string> = {
  URGENT: style.red,
  HIGH: style.yellow,
  MEDIUM: style.blue,
  LOW: style.dim,
  NONE: style.dim,
};

const STATE: Record<string, (s: string) => string> = {
  BACKLOG: style.dim,
  UNSTARTED: style.plain,
  STARTED: style.yellow,
  COMPLETED: style.green,
  CANCELED: style.dim,
};

export function priority(value: string | null | undefined): string {
  if (!value || value === 'NONE') return style.dim('—');
  return (PRIORITY[value] ?? style.plain)(value.toLowerCase());
}

export function status(name: string, type?: string | null): string {
  return (STATE[type ?? ''] ?? style.plain)(name);
}

/** Overdue reads as urgent, because that is the only reason to print a date. */
export function due(date: string | null | undefined): string {
  if (!date) return '';
  const today = new Date().toISOString().slice(0, 10);
  if (date < today) return style.red(date);
  return date === today ? style.yellow('today') : date;
}

export function labels(names: string[] | undefined): string {
  return names && names.length > 0 ? style.magenta(names.join(',')) : '';
}
