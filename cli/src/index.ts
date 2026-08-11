#!/usr/bin/env node
import { createRequire } from 'node:module';
import { parseArgs } from 'node:util';

import { resolveProject, type Project } from './api.js';
import * as manage from './admin.js';
import { login, logout, whoami } from './auth.js';
import * as issues from './commands.js';
import { readConfig } from './config.js';
import { AuthError, CliError, client } from './mcp.js';
import { style } from './render.js';

/**
 * Entry point and dispatch.
 *
 * One flag table for every command rather than one per subcommand: `strict`
 * parsing then catches a mistyped flag instead of silently treating it as a
 * positional, which is the failure mode that gets an issue filed with the title
 * "--titel".
 */

const OPTIONS = {
  json: { type: 'boolean' },
  yes: { type: 'boolean', short: 'y' },
  help: { type: 'boolean', short: 'h' },
  version: { type: 'boolean', short: 'v' },
  host: { type: 'string' },
  'with-token': { type: 'boolean' },

  project: { type: 'string', short: 'p' },
  org: { type: 'string' },
  workspace: { type: 'string' },
  board: { type: 'string', short: 'b' },
  status: { type: 'string', short: 's' },
  mine: { type: 'boolean', short: 'm' },

  title: { type: 'string' },
  desc: { type: 'string' },
  priority: { type: 'string' },
  due: { type: 'string' },
  assign: { type: 'string', short: 'a' },
  label: { type: 'string', short: 'l', multiple: true },
  cycle: { type: 'string' },
  pos: { type: 'string' },
  limit: { type: 'string' },

  name: { type: 'string' },
  key: { type: 'string' },
  role: { type: 'string' },
} as const;

const HELP = `${style.bold('flone')} — Flone from your terminal

  flone                          open the interactive board
  flone login [--with-token]     sign in (stores a token)
  flone logout                   sign out and revoke the token
  flone whoami                   who you are and what you can reach
  flone use [KEY]                show or set the default project

${style.dim('Issues')}
  flone ls                       the board, grouped by status
                                 --board --status --mine
  flone show ENG-12              one issue in full, with comments
  flone new "title"              --desc --status --board --priority
                                 --assign --label --due --cycle
  flone edit ENG-12              --title --desc --priority --due
                                 --assign --board --label --cycle
  flone mv ENG-12 "In Progress"  --pos 0
  flone rm ENG-12                --yes
  flone comment ENG-12 "text"
  flone search "query"           --limit

${style.dim('Everything else')}
  flone org ls|show|new|rename|rm
  flone org member ls|add|role|rm
  flone project ls|show|new|edit|rm
  flone board ls|new|rename|rm
  flone admin users|registration|set-admin

${style.dim('Anywhere')}
  --project ENG   act on a project other than the default
  --json          print the raw tool result, for scripts
  --host URL      talk to a different server

Issues are named by ref (ENG-12) or by id. FLONE_TOKEN and FLONE_URL override
the stored login, so CI never needs to run \`flone login\`.`;

function version(): string {
  const require = createRequire(import.meta.url);
  return (require('../package.json') as { version: string }).version;
}

async function main(): Promise<void> {
  let parsed: ReturnType<typeof parseArgs<{ options: typeof OPTIONS; allowPositionals: true }>>;
  try {
    parsed = parseArgs({ args: process.argv.slice(2), options: OPTIONS, allowPositionals: true });
  } catch (e) {
    // A mistyped flag is a user error with a perfectly good message attached,
    // not a crash. Without this it prints as "Unexpected failure".
    throw new CliError(`${(e as Error).message}\nRun \`flone help\` for the flags.`);
  }

  const { values, positionals } = parsed;

  if (values.version) {
    console.log(version());
    return;
  }

  const [command, ...rest] = positionals;

  if (values.help || command === 'help' || (command === undefined && !process.stdout.isTTY)) {
    console.log(HELP);
    return;
  }

  // Sign-in is the one thing that works without a stored credential.
  if (command === 'login') {
    return login({ host: values.host, withToken: values['with-token'] });
  }
  if (command === 'logout') return logout();

  const config = readConfig();
  if (!config) {
    throw new AuthError('Not signed in. Run `flone login`.');
  }

  const call = client(values.host ?? config.host, config.token);
  const ctx: issues.Ctx = {
    call,
    json: values.json === true,
    yes: values.yes === true,
    flags: values as issues.Ctx['flags'],
  };

  switch (command) {
    case undefined: {
      // Interactive by default, but only where there is a terminal to draw on.
      // Loaded lazily so a scripted `flone ls` never pays for React and Ink.
      const { runBoard } = await import('./tui.js');
      return runBoard(ctx);
    }

    case 'whoami':
      return whoami();
    case 'use':
      return issues.use(ctx, rest[0]);

    case 'ls':
      return issues.ls(ctx);
    case 'show':
      return issues.show(ctx, rest[0]);
    case 'new':
      return issues.create(ctx, rest[0]);
    case 'edit':
      return issues.edit(ctx, rest[0]);
    case 'mv':
      return issues.move(ctx, rest[0], rest[1]);
    case 'rm':
      return issues.remove(ctx, rest[0]);
    case 'comment':
      return issues.comment(ctx, rest[0], rest[1]);
    case 'search':
      return issues.search(ctx, rest[0]);

    case 'org':
      return manage.org(ctx, rest);
    case 'project':
      return manage.project(ctx, rest);
    case 'admin':
      return manage.admin(ctx, rest);

    case 'board': {
      // Board commands all act within one project, so it is resolved once here.
      const where = await resolveProject(call, values.project, config.project);
      const detail = await call<Project>('get_project', where);
      return manage.board(ctx, rest, detail);
    }

    default:
      throw new CliError(`Unknown command: ${command}. Run \`flone help\`.`);
  }
}

main().catch((e: unknown) => {
  // Everything a person should see is a CliError carrying a written message —
  // ours or the server's. Anything else is a bug, and prints as one.
  if (e instanceof CliError) {
    console.error(style.red(e.message));
    process.exit(1);
  }
  console.error(style.red('Unexpected failure.'));
  console.error(e);
  process.exit(1);
});
