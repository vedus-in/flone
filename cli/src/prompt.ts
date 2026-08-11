import { createInterface } from 'node:readline/promises';
import { Writable } from 'node:stream';

import { CliError } from './mcp.js';

/**
 * Echo is suppressed by giving readline an output stream that drops what it is
 * told to write. A `Writable` rather than the usual `_writeToOutput` monkey
 * patch: same effect, entirely public API.
 */
export async function ask(question: string, hidden = false): Promise<string> {
  if (!process.stdin.isTTY) {
    throw new CliError(
      'No terminal to prompt on. Pipe a token to `flone login --with-token`, or set FLONE_TOKEN.',
    );
  }

  let muted = false;
  const output = new Writable({
    write(chunk, encoding, done) {
      if (!muted) process.stdout.write(chunk as Buffer, encoding);
      done();
    },
  });

  const rl = createInterface({ input: process.stdin, output, terminal: true });
  try {
    process.stdout.write(question);
    muted = hidden;
    const answer = await rl.question('');
    if (hidden) process.stdout.write('\n');
    return answer.trim();
  } finally {
    muted = false;
    rl.close();
  }
}

/**
 * Destructive commands stop here. A non-TTY has nobody to ask, so it must be
 * told `--yes` explicitly rather than defaulting either way: a script that
 * deletes when it meant to prompt is the worse of the two failures.
 */
export async function confirm(question: string, yes: boolean): Promise<boolean> {
  if (yes) return true;

  if (!process.stdin.isTTY) {
    throw new CliError('Refusing to do that unprompted. Pass --yes if you mean it.');
  }

  const answer = await ask(`${question} [y/N] `);
  return /^y(es)?$/i.test(answer);
}
