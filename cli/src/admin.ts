import { resolveBoard, type NavOrg, type Project } from './api.js';
import { CliError } from './mcp.js';
import { confirm } from './prompt.js';
import { style, table } from './render.js';
import type { Ctx } from './commands.js';

/**
 * Organizations, members, projects, boards and site administration.
 *
 * Deliberately not in the interactive board: these are rare, one-shot acts, and
 * a form-heavy terminal UI for something used twice a year earns nothing. They
 * are also the destructive ones, and a typed command with a confirmation is a
 * better place for that than a keystroke.
 *
 * The admin subcommands are visible to everyone and simply fail server-side for
 * non-admins. Hiding them would be a guess about the caller's role that the
 * server is about to make properly anyway.
 */

type Users = {
  registrationOpen: boolean;
  total: number;
  shown: number;
  users: { userId: string; name: string; email: string; isAdmin: boolean; createdAt: string }[];
};

type Org = {
  organization: string;
  orgSlug: string;
  yourRole: string;
  members: { membershipId: string; userId: string; name: string; email: string; role: string }[];
  projects: { projectKey: string; name: string; boards: { boardId: string; name: string }[] }[];
};

function arg(argv: string[], index: number, what: string): string {
  const value = argv[index];
  if (value === undefined || value.trim() === '') throw new CliError(what);
  return value;
}

function flag(ctx: Ctx, key: string): string | undefined {
  const value = ctx.flags[key];
  return typeof value === 'string' ? value : undefined;
}

function report(ctx: Ctx, data: unknown, human: () => void): void {
  if (ctx.json) {
    console.log(JSON.stringify(data, null, 2));
    return;
  }
  human();
}

/** The organization a command acts on: `--org`, or the only one you belong to. */
async function orgSlug(ctx: Ctx): Promise<string> {
  const wanted = flag(ctx, 'org');
  const { organizations } = await ctx.call<{ organizations: NavOrg[] }>('list_boards');

  if (wanted) {
    const match = organizations.find(
      (org) => org.slug === wanted || org.name.toLowerCase() === wanted.toLowerCase(),
    );
    if (!match) throw new CliError(`No organization "${wanted}".`);
    return match.slug;
  }

  if (organizations.length === 1) return organizations[0]!.slug;
  if (organizations.length === 0) throw new CliError('You are not a member of any organization.');

  throw new CliError(
    `Which organization? Pass --org. You belong to: ${organizations.map((o) => o.slug).join(', ')}.`,
  );
}

/* -------------------------------------------------------------------------- */
/* org                                                                         */
/* -------------------------------------------------------------------------- */

export async function org(ctx: Ctx, argv: string[]): Promise<void> {
  const sub = argv[0] ?? 'ls';
  const rest = argv.slice(1);

  switch (sub) {
    case 'ls': {
      const { organizations } = await ctx.call<{ organizations: NavOrg[] }>('list_boards');
      report(ctx, organizations, () =>
        console.log(
          table(
            organizations.map((entry) => [
              style.cyan(entry.slug),
              entry.name,
              style.dim(entry.role.toLowerCase()),
              style.dim(
                `${entry.workspaces.flatMap((workspace) => workspace.projects).length} projects`,
              ),
            ]),
            ['SLUG', 'NAME', 'ROLE', ''],
          ),
        ),
      );
      return;
    }

    case 'show': {
      const result = await ctx.call<Org>('get_organization', { orgSlug: await orgSlug(ctx) });
      report(ctx, result, () => {
        console.log(`${style.bold(result.organization)} ${style.dim(`(${result.yourRole.toLowerCase()})`)}\n`);
        console.log(style.dim('Members'));
        console.log(
          table(
            result.members.map((member) => [
              member.name,
              style.dim(member.email),
              member.role.toLowerCase(),
            ]),
          ),
        );
        console.log(`\n${style.dim('Projects')}`);
        console.log(
          table(
            result.projects.map((entry) => [
              style.cyan(entry.projectKey),
              entry.name,
              style.dim(entry.boards.map((board) => board.name).join(', ')),
            ]),
          ),
        );
      });
      return;
    }

    case 'new': {
      const name = arg(rest, 0, 'What is it called? e.g. `flone org new "Acme"`.');
      const result = await ctx.call<{ orgSlug: string }>('create_organization', { name });
      report(ctx, result, () => console.log(`${style.green('created')} ${result.orgSlug}`));
      return;
    }

    case 'rename': {
      const name = arg(rest, 0, 'Rename it to what?');
      const result = await ctx.call('rename_organization', { orgSlug: await orgSlug(ctx), name });
      report(ctx, result, () => console.log(`${style.green('renamed')} to ${name}`));
      return;
    }

    case 'rm': {
      const slug = await orgSlug(ctx);
      const detail = await ctx.call<Org>('get_organization', { orgSlug: slug });
      const projects = detail.projects.length;
      if (
        !(await confirm(
          `Permanently delete "${detail.organization}", its ${projects} project${projects === 1 ? '' : 's'} and every issue in them?`,
          ctx.yes,
        ))
      ) {
        console.log('Left alone.');
        return;
      }
      // The tool demands the name back as a second key. The CLI already made
      // the caller say yes to that exact name, so it supplies it rather than
      // asking them to type it twice.
      const result = await ctx.call('delete_organization', {
        orgSlug: slug,
        confirmName: detail.organization,
      });
      report(ctx, result, () => console.log(`${style.red('deleted')} ${detail.organization}`));
      return;
    }

    case 'member':
      return member(ctx, rest);

    default:
      throw new CliError(`Unknown: flone org ${sub}. Try ls, show, new, rename, rm or member.`);
  }
}

/* -------------------------------------------------------------------------- */
/* org member                                                                  */
/* -------------------------------------------------------------------------- */

/** Members are addressed by email; nobody should ever have to see a membershipId. */
async function membershipFor(ctx: Ctx, slug: string, email: string): Promise<string> {
  const detail = await ctx.call<Org>('get_organization', { orgSlug: slug });
  const match = detail.members.find(
    (candidate) => candidate.email.toLowerCase() === email.toLowerCase(),
  );
  if (!match) throw new CliError(`${email} is not a member of ${detail.organization}.`);
  return match.membershipId;
}

async function member(ctx: Ctx, argv: string[]): Promise<void> {
  const sub = argv[0] ?? 'ls';
  const slug = await orgSlug(ctx);

  switch (sub) {
    case 'ls': {
      const detail = await ctx.call<Org>('get_organization', { orgSlug: slug });
      report(ctx, detail.members, () =>
        console.log(
          table(
            detail.members.map((entry) => [entry.name, entry.email, entry.role.toLowerCase()]),
            ['NAME', 'EMAIL', 'ROLE'],
          ),
        ),
      );
      return;
    }

    case 'add': {
      const email = arg(argv, 1, 'Add whom? e.g. `flone org member add sam@acme.com`.');
      const result = await ctx.call('add_member', {
        orgSlug: slug,
        email,
        role: (flag(ctx, 'role') ?? 'MEMBER').toUpperCase(),
      });
      report(ctx, result, () => console.log(`${style.green('added')} ${email}`));
      return;
    }

    case 'role': {
      const email = arg(argv, 1, 'Change whose role?');
      const role = arg(argv, 2, 'To what role? OWNER, ADMIN or MEMBER.').toUpperCase();
      const result = await ctx.call('set_member_role', {
        orgSlug: slug,
        membershipId: await membershipFor(ctx, slug, email),
        role,
      });
      report(ctx, result, () => console.log(`${style.green('updated')} ${email} → ${role.toLowerCase()}`));
      return;
    }

    case 'rm': {
      const email = arg(argv, 1, 'Remove whom?');
      if (!(await confirm(`Remove ${email} from the organization?`, ctx.yes))) {
        console.log('Left alone.');
        return;
      }
      const result = await ctx.call('remove_member', {
        orgSlug: slug,
        membershipId: await membershipFor(ctx, slug, email),
      });
      report(ctx, result, () => console.log(`${style.red('removed')} ${email}`));
      return;
    }

    default:
      throw new CliError(`Unknown: flone org member ${sub}. Try ls, add, role or rm.`);
  }
}

/* -------------------------------------------------------------------------- */
/* project                                                                     */
/* -------------------------------------------------------------------------- */

export async function project(ctx: Ctx, argv: string[]): Promise<void> {
  const sub = argv[0] ?? 'ls';
  const rest = argv.slice(1);

  if (sub === 'ls') {
    const { organizations } = await ctx.call<{ organizations: NavOrg[] }>('list_boards');
    const rows = organizations.flatMap((entry) =>
      entry.workspaces.flatMap((workspace) =>
        workspace.projects.map((item) => [
          style.cyan(item.key),
          item.name,
          style.dim(entry.slug),
          style.dim(workspace.name),
        ]),
      ),
    );
    report(ctx, organizations, () => console.log(table(rows, ['KEY', 'NAME', 'ORG', 'WORKSPACE'])));
    return;
  }

  if (sub === 'show') {
    const detail = await ctx.call<Project>('get_project', {
      orgSlug: await orgSlug(ctx),
      projectKey: arg(rest, 0, 'Which project? e.g. `flone project show ENG`.').toUpperCase(),
    });
    report(ctx, detail, () => {
      console.log(`${style.bold(detail.project)} ${style.dim(detail.projectKey)}\n`);
      console.log(style.dim('Statuses'));
      console.log(table(detail.states.map((state) => [state.name, style.dim(state.type)])));
      console.log(`\n${style.dim('Boards')}`);
      console.log(
        table(detail.boards.map((board) => [board.name, style.dim(`${board.tickets} issues`)])),
      );
      if (detail.labels.length > 0) {
        console.log(`\n${style.dim('Labels')}  ${detail.labels.map((l) => l.name).join(', ')}`);
      }
    });
    return;
  }

  if (sub === 'new') {
    const name = arg(rest, 0, 'What is it called? e.g. `flone project new "Engineering" --key ENG`.');
    const key = flag(ctx, 'key');
    if (!key) throw new CliError('A project needs a key: --key ENG.');

    const result = await ctx.call<{ projectKey: string }>('create_project', {
      orgSlug: await orgSlug(ctx),
      name,
      key: key.toUpperCase(),
      // Required once an organization has more than one workspace. Omitted
      // rather than guessed: the server's message names the choices.
      ...(flag(ctx, 'workspace') !== undefined ? { workspaceSlug: flag(ctx, 'workspace') } : {}),
      ...(flag(ctx, 'desc') !== undefined ? { description: flag(ctx, 'desc') } : {}),
    });
    report(ctx, result, () => console.log(`${style.green('created')} ${result.projectKey}`));
    return;
  }

  if (sub === 'edit') {
    const key = arg(rest, 0, 'Which project?').toUpperCase();
    const changes = {
      ...(flag(ctx, 'name') !== undefined ? { name: flag(ctx, 'name') } : {}),
      ...(flag(ctx, 'desc') !== undefined ? { description: flag(ctx, 'desc') } : {}),
    };
    if (Object.keys(changes).length === 0) throw new CliError('Pass --name or --desc.');

    const result = await ctx.call('update_project', {
      orgSlug: await orgSlug(ctx),
      projectKey: key,
      ...changes,
    });
    report(ctx, result, () => console.log(`${style.green('updated')} ${key}`));
    return;
  }

  if (sub === 'rm') {
    const key = arg(rest, 0, 'Which project?').toUpperCase();
    const slug = await orgSlug(ctx);
    const detail = await ctx.call<Project>('get_project', { orgSlug: slug, projectKey: key });
    const issues = detail.boards.reduce((sum, board) => sum + board.tickets, 0);

    if (
      !(await confirm(
        `Permanently delete project ${key} "${detail.project}" and its ${issues} issue${issues === 1 ? '' : 's'}?`,
        ctx.yes,
      ))
    ) {
      console.log('Left alone.');
      return;
    }

    // `confirmKey` echoes the key back; the confirmation above already named it.
    const result = await ctx.call('delete_project', {
      orgSlug: slug,
      projectKey: key,
      confirmKey: key,
    });
    report(ctx, result, () => console.log(`${style.red('deleted')} ${key}`));
    return;
  }

  throw new CliError(`Unknown: flone project ${sub}. Try ls, show, new, edit or rm.`);
}

/* -------------------------------------------------------------------------- */
/* board                                                                       */
/* -------------------------------------------------------------------------- */

export async function board(ctx: Ctx, argv: string[], detail: Project): Promise<void> {
  const sub = argv[0] ?? 'ls';
  const rest = argv.slice(1);

  switch (sub) {
    case 'ls':
      report(ctx, detail.boards, () =>
        console.log(
          table(
            detail.boards.map((entry) => [
              entry.name,
              style.dim(entry.status.toLowerCase()),
              style.dim(`${entry.tickets} issues`),
            ]),
            ['NAME', 'STATUS', ''],
          ),
        ),
      );
      return;

    case 'new': {
      const name = arg(rest, 0, 'What is it called? e.g. `flone board new "Sprint 4"`.');
      const result = await ctx.call('create_board', {
        orgSlug: detail.orgSlug,
        projectKey: detail.projectKey,
        name,
      });
      report(ctx, result, () => console.log(`${style.green('created')} board ${name}`));
      return;
    }

    case 'rename': {
      const name = arg(rest, 1, 'Rename it to what? e.g. `flone board rename Main "Sprint 4"`.');
      const result = await ctx.call('rename_board', {
        boardId: resolveBoard(detail, arg(rest, 0, 'Rename which board?')),
        name,
      });
      report(ctx, result, () => console.log(`${style.green('renamed')} to ${name}`));
      return;
    }

    case 'rm': {
      const target = arg(rest, 0, 'Delete which board?');
      const boardId = resolveBoard(detail, target);
      const found = detail.boards.find((entry) => entry.boardId === boardId)!;

      if (
        !(await confirm(
          `Delete board "${found.name}"? Its ${found.tickets} issue${found.tickets === 1 ? '' : 's'} survive and simply lose their board.`,
          ctx.yes,
        ))
      ) {
        console.log('Left alone.');
        return;
      }

      const result = await ctx.call('delete_board', { boardId });
      report(ctx, result, () => console.log(`${style.red('deleted')} board ${found.name}`));
      return;
    }

    default:
      throw new CliError(`Unknown: flone board ${sub}. Try ls, new, rename or rm.`);
  }
}

/* -------------------------------------------------------------------------- */
/* admin                                                                       */
/* -------------------------------------------------------------------------- */

export async function admin(ctx: Ctx, argv: string[]): Promise<void> {
  const sub = argv[0];

  switch (sub) {
    case 'users': {
      const result = await ctx.call<Users>('admin_list_users');
      report(ctx, result, () => {
        console.log(
          table(
            result.users.map((user) => [
              user.name,
              user.email,
              user.isAdmin ? style.yellow('admin') : '',
            ]),
            ['NAME', 'EMAIL', ''],
          ),
        );
        console.log(
          style.dim(
            `\n${result.shown} of ${result.total} · registration ${result.registrationOpen ? 'open' : 'closed'}`,
          ),
        );
      });
      return;
    }

    case 'registration': {
      const value = arg(argv, 1, 'On or off? e.g. `flone admin registration off`.');
      const enabled = /^(on|open|true|yes)$/i.test(value);
      const result = await ctx.call('admin_set_registration', { enabled });
      report(ctx, result, () =>
        console.log(`Registration is now ${enabled ? style.green('open') : style.red('closed')}.`),
      );
      return;
    }

    case 'set-admin': {
      const email = arg(argv, 1, 'Which user? Pass their email.');
      const value = arg(argv, 2, 'On or off?');
      const isAdmin = /^(on|true|yes)$/i.test(value);

      const result = await ctx.call<Users>('admin_list_users');
      const user = result.users.find((entry) => entry.email.toLowerCase() === email.toLowerCase());
      if (!user) throw new CliError(`No user ${email}.`);

      if (!(await confirm(`${isAdmin ? 'Grant' : 'Revoke'} site admin for ${email}?`, ctx.yes))) {
        console.log('Left alone.');
        return;
      }

      const done = await ctx.call('admin_set_user_admin', { userId: user.userId, isAdmin });
      report(ctx, done, () =>
        console.log(`${email} is ${isAdmin ? style.yellow('now an admin') : 'no longer an admin'}.`),
      );
      return;
    }

    default:
      throw new CliError(`Unknown: flone admin ${sub ?? ''}. Try users, registration or set-admin.`);
  }
}
