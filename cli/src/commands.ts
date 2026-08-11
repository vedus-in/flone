import {
  resolveBoard,
  resolveProject,
  type Board,
  type Card,
  type Found,
  type Me,
  type Project,
  type Ticket,
} from './api.js';
import { readConfig, setDefaultProject } from './config.js';
import { CliError, type Call } from './mcp.js';
import { confirm } from './prompt.js';
import { due, labels, priority, status, style, table } from './render.js';

/**
 * The scriptable half of the CLI. Every command is exactly one tool call, plus
 * whatever reads are needed to turn a human's words ("Main", "ENG", "high")
 * into the arguments the tool wants.
 */

export type Ctx = {
  call: Call;
  json: boolean;
  yes: boolean;
  flags: Record<string, string | boolean | string[] | undefined>;
};

function out(ctx: Ctx, data: unknown, human: () => void): void {
  if (ctx.json) {
    console.log(JSON.stringify(data, null, 2));
    return;
  }
  human();
}

function str(ctx: Ctx, key: string): string | undefined {
  const value = ctx.flags[key];
  return typeof value === 'string' ? value : undefined;
}

function list(ctx: Ctx, key: string): string[] | undefined {
  const value = ctx.flags[key];
  if (Array.isArray(value)) return value;
  return typeof value === 'string' ? [value] : undefined;
}

/** Priorities are shouted on the wire and typed in lower case. */
const PRIORITIES = ['NONE', 'LOW', 'MEDIUM', 'HIGH', 'URGENT'];

function priorityArg(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const upper = value.toUpperCase();
  if (!PRIORITIES.includes(upper)) {
    throw new CliError(`Priority must be one of: ${PRIORITIES.join(', ').toLowerCase()}.`);
  }
  return upper;
}

async function project(ctx: Ctx): Promise<{ orgSlug: string; projectKey: string }> {
  return resolveProject(ctx.call, str(ctx, 'project'), readConfig()?.project);
}

async function projectDetail(ctx: Ctx): Promise<Project> {
  return ctx.call<Project>('get_project', await project(ctx));
}

/* -------------------------------------------------------------------------- */
/* Reading                                                                     */
/* -------------------------------------------------------------------------- */

function cardRow(card: Card): string[] {
  return [
    style.cyan(card.ref),
    card.title,
    card.assignee ?? style.dim('—'),
    priority(card.priority),
    due(card.dueDate),
    labels(card.labels),
    card.comments > 0 ? style.dim(`${card.comments}c`) : '',
  ];
}

/** The board, grouped by column — the same view the web UI opens on. */
export async function ls(ctx: Ctx): Promise<void> {
  const detail = await projectDetail(ctx);
  const boardId = resolveBoard(detail, str(ctx, 'board'));
  const board = await ctx.call<Board>('get_board', { boardId });

  const wantedStatus = str(ctx, 'status')?.toLowerCase();
  const mine = ctx.flags['mine'] === true;
  const me = mine ? await ctx.call<Me>('whoami') : null;

  const columns = board.columns
    .filter((column) => !wantedStatus || column.name.toLowerCase() === wantedStatus)
    .map((column) => ({
      ...column,
      tickets: me ? column.tickets.filter((card) => card.assignee === me.name) : column.tickets,
    }));

  if (wantedStatus && columns.length === 0) {
    throw new CliError(
      `No column "${str(ctx, 'status')}" on ${board.board}. It has: ${board.columns
        .map((column) => column.name)
        .join(', ')}.`,
    );
  }

  out(ctx, { ...board, columns }, () => {
    console.log(`${style.bold(board.project)} ${style.dim(`· ${board.board}`)}\n`);

    for (const column of columns) {
      const heading = status(column.name, column.type);
      console.log(`${heading} ${style.dim(`(${column.tickets.length})`)}`);

      if (column.tickets.length === 0) {
        console.log(style.dim('  —\n'));
        continue;
      }

      console.log(
        `${table(column.tickets.map(cardRow))
          .split('\n')
          .map((line) => `  ${line}`)
          .join('\n')}\n`,
      );
    }
  });
}

export async function show(ctx: Ctx, ref: string | undefined): Promise<void> {
  if (!ref) throw new CliError('Which issue? e.g. `flone show ENG-12`.');
  const ticket = await ctx.call<Ticket>('get_ticket', { ticketId: ref });

  out(ctx, ticket, () => {
    console.log(`${style.cyan(ticket.ref)}  ${style.bold(ticket.title)}`);

    const facts = [
      ['Status', status(ticket.status, ticket.statusType)],
      ['Priority', priority(ticket.priority)],
      ['Assignee', ticket.assignee ? `${ticket.assignee.name} <${ticket.assignee.email}>` : '—'],
      ['Due', ticket.dueDate ? due(ticket.dueDate) : '—'],
      ['Board', ticket.board ?? '—'],
      ['Cycle', ticket.cycle ?? '—'],
      ['Labels', ticket.labels.length > 0 ? labels(ticket.labels) : '—'],
      ['Created', `${ticket.createdAt.slice(0, 10)} by ${ticket.createdBy}`],
    ];
    console.log(table(facts.map(([key, value]) => [style.dim(`${key}`), value ?? ''])));

    if (ticket.description) console.log(`\n${ticket.description}`);

    if (ticket.parent) {
      console.log(`\n${style.dim('Parent')}  ${style.cyan(ticket.parent.ref)} ${ticket.parent.title}`);
    }

    if (ticket.subIssues.length > 0) {
      console.log(`\n${style.dim('Sub-issues')}`);
      console.log(
        table(
          ticket.subIssues.map((child) => [style.cyan(child.ref), child.title, style.dim(child.status)]),
        ),
      );
    }

    if (ticket.comments.length > 0) {
      console.log(`\n${style.dim(`Comments (${ticket.comments.length})`)}`);
      for (const comment of ticket.comments) {
        console.log(
          `\n  ${style.bold(comment.author)} ${style.dim(comment.createdAt.slice(0, 10))}\n  ${comment.body.split('\n').join('\n  ')}`,
        );
      }
    }
  });
}

export async function search(ctx: Ctx, query: string | undefined): Promise<void> {
  if (!query) throw new CliError('What are you looking for? e.g. `flone search "login bug"`.');

  const limit = str(ctx, 'limit');
  if (limit !== undefined && !/^[1-9][0-9]*$/.test(limit)) {
    throw new CliError('--limit takes a whole number, 1 to 50.');
  }

  const result = await ctx.call<{ count: number; tickets: Found[] }>('search_tickets', {
    query,
    ...(limit ? { limit: Number(limit) } : {}),
  });

  out(ctx, result, () => {
    if (result.count === 0) {
      console.log(style.dim(`Nothing matches "${query}".`));
      return;
    }
    console.log(
      table(
        result.tickets.map((found) => [
          style.cyan(found.ref),
          found.title,
          status(found.status, found.statusType),
          found.assignee ?? style.dim('—'),
          priority(found.priority),
          style.dim(found.project),
        ]),
        ['REF', 'TITLE', 'STATUS', 'ASSIGNEE', 'PRI', 'PROJECT'],
      ),
    );
  });
}

/* -------------------------------------------------------------------------- */
/* Writing                                                                     */
/* -------------------------------------------------------------------------- */

export async function create(ctx: Ctx, title: string | undefined): Promise<void> {
  if (!title) throw new CliError('What is it called? e.g. `flone new "Fix the login bug"`.');

  const where = await project(ctx);
  const result = await ctx.call<{ ref: string; url: string; status: string }>('create_ticket', {
    ...where,
    title,
    ...defined({
      description: str(ctx, 'desc'),
      status: str(ctx, 'status'),
      board: str(ctx, 'board'),
      priority: priorityArg(str(ctx, 'priority')),
      assignee: str(ctx, 'assign'),
      labels: list(ctx, 'label'),
      cycle: str(ctx, 'cycle') ? Number(str(ctx, 'cycle')) : undefined,
    }),
  });

  out(ctx, result, () => {
    console.log(`${style.green('created')} ${style.cyan(result.ref)}  ${title}`);
    console.log(style.dim(result.url));
  });
}

/**
 * `update_ticket` reads an ABSENT key as "leave it alone" and an empty string as
 * "clear it", so only flags the caller actually typed may be sent. A parser that
 * helpfully defaulted these to `''` would silently wipe descriptions.
 */
export async function edit(ctx: Ctx, ref: string | undefined): Promise<void> {
  if (!ref) throw new CliError('Which issue? e.g. `flone edit ENG-12 --priority high`.');

  const changes = defined({
    title: str(ctx, 'title'),
    description: str(ctx, 'desc'),
    priority: priorityArg(str(ctx, 'priority')),
    dueDate: str(ctx, 'due'),
    assignee: str(ctx, 'assign'),
    board: str(ctx, 'board'),
    labels: list(ctx, 'label'),
    cycle: str(ctx, 'cycle') ? Number(str(ctx, 'cycle')) : undefined,
  });

  if (Object.keys(changes).length === 0) {
    throw new CliError(
      'Nothing to change. Pass at least one of --title --desc --priority --due --assign --board --label --cycle.',
    );
  }

  const result = await ctx.call<{ ref: string }>('update_ticket', { ticketId: ref, ...changes });

  out(ctx, result, () => {
    console.log(`${style.green('updated')} ${style.cyan(result.ref)}  ${Object.keys(changes).join(', ')}`);
  });
}

export async function move(ctx: Ctx, ref?: string, to?: string): Promise<void> {
  if (!ref || !to) throw new CliError('Move what, where? e.g. `flone mv ENG-12 "In Progress"`.');

  const position = str(ctx, 'pos');
  if (position !== undefined && !/^[0-9]+$/.test(position)) {
    throw new CliError('--pos takes a whole number. 0 puts it at the top.');
  }

  const result = await ctx.call<{ ref: string; status: string; statusType: string }>('move_ticket', {
    ticketId: ref,
    status: to,
    ...(position !== undefined ? { position: Number(position) } : {}),
  });

  out(ctx, result, () => {
    console.log(
      `${style.green('moved')} ${style.cyan(result.ref)} → ${status(result.status, result.statusType)}`,
    );
  });
}

export async function remove(ctx: Ctx, ref: string | undefined): Promise<void> {
  if (!ref) throw new CliError('Which issue? e.g. `flone rm ENG-12`.');

  // Read it first so the prompt names what is about to go, and so a typo fails
  // before anything is destroyed.
  const ticket = await ctx.call<Ticket>('get_ticket', { ticketId: ref });

  const comments = ticket.comments.length;
  const detail = comments > 0 ? ` and its ${comments} comment${comments === 1 ? '' : 's'}` : '';
  if (!(await confirm(`Permanently delete ${ticket.ref} "${ticket.title}"${detail}?`, ctx.yes))) {
    console.log('Left alone.');
    return;
  }

  const result = await ctx.call('delete_ticket', { ticketId: ticket.ticketId });
  out(ctx, result, () => console.log(`${style.red('deleted')} ${ticket.ref}`));
}

export async function comment(ctx: Ctx, ref?: string, body?: string): Promise<void> {
  if (!ref || !body) throw new CliError('Comment on what? e.g. `flone comment ENG-12 "on it"`.');

  const result = await ctx.call<{ commentId: string }>('create_comment', { ticketId: ref, body });
  out(ctx, result, () => console.log(`${style.green('commented')} on ${style.cyan(ref)}`));
}

/** Sets the project the other commands assume, so `--project` stops being typed. */
export async function use(ctx: Ctx, key: string | undefined): Promise<void> {
  const config = readConfig();
  if (!config) throw new CliError('Not signed in. Run `flone login`.');

  if (!key) {
    console.log(config.project ?? style.dim('No default project set.'));
    return;
  }

  // Resolved before it is stored: a default that names nothing would break
  // every later command with a confusing error.
  const resolved = await resolveProject(ctx.call, key, undefined);
  setDefaultProject(resolved.projectKey);
  console.log(`Default project is now ${style.bold(resolved.projectKey)}.`);
}

/** Drops keys whose value is `undefined`, so absent flags are never sent. */
function defined<T extends Record<string, unknown>>(source: T): Partial<T> {
  return Object.fromEntries(
    Object.entries(source).filter(([, value]) => value !== undefined),
  ) as Partial<T>;
}
