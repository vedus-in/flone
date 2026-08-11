import { clearConfig, configPath, defaultHost, readConfig, writeConfig } from './config.js';
import { CliError, client } from './mcp.js';
import type { Me, NavOrg } from './api.js';
import { ask } from './prompt.js';
import { style } from './render.js';

/**
 * Sign-in, sign-out, and "who am I".
 *
 * The token this stores IS a session — the same row the browser's cookie points
 * at, carrying the full rights of the account. `flone logout` therefore revokes
 * it server-side rather than only forgetting it, because a file you deleted is
 * not a credential anyone else has stopped honouring.
 */

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8').trim();
}

type LoginResponse = { token?: string; error?: string; user?: { name: string; email: string } };

export async function login(flags: {
  host?: string;
  withToken?: boolean;
}): Promise<void> {
  const host = (flags.host ?? defaultHost()).replace(/\/+$/, '');

  if (flags.withToken) {
    const token = process.stdin.isTTY ? await ask('Token: ', true) : await readStdin();
    if (token === '') throw new CliError('No token given.');

    // Proved before it is stored, so a typo fails here rather than on the next
    // unrelated command.
    const me = await client(host, token)<Me>('whoami');
    writeConfig({ host, token });
    console.log(`Signed in to ${host} as ${style.bold(me.name)} <${me.email}>.`);
    return;
  }

  const email = await ask('Email: ', false);
  const password = await ask('Password: ', true);

  let response: Response;
  try {
    response = await fetch(`${host}/api/cli/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email, password }),
    });
  } catch (e) {
    throw new CliError(`Could not reach ${host} (${(e as Error).message}).`);
  }

  let body: LoginResponse;
  try {
    body = (await response.json()) as LoginResponse;
  } catch {
    throw new CliError(`${host} did not return JSON. Is that a Flone server?`);
  }

  if (!response.ok || !body.token) {
    // The server's own wording, verbatim. It is written to be shown to people,
    // and rephrasing it here is how a CLI accidentally becomes an account
    // oracle the login path was carefully built to close.
    throw new CliError(body.error ?? `Sign-in failed (${response.status}).`);
  }

  writeConfig({ host, token: body.token });
  const who = body.user ? `${style.bold(body.user.name)} <${body.user.email}>` : 'you';
  console.log(`Signed in to ${host} as ${who}.`);
  console.log(style.dim(`Token stored in ${configPath()}.`));
}

export async function logout(): Promise<void> {
  const config = readConfig();
  if (!config) {
    console.log('Not signed in.');
    return;
  }

  let revoked = false;
  try {
    const response = await fetch(`${config.host}/api/cli/login`, {
      method: 'DELETE',
      headers: { authorization: `Bearer ${config.token}` },
    });
    revoked = response.ok;
  } catch {
    revoked = false;
  }

  clearConfig();

  if (revoked) {
    console.log('Signed out. The token has been revoked.');
    return;
  }

  // Local state is cleared either way, but saying "signed out" while a live
  // 30-day credential is still out there would be a lie.
  console.log('Local token removed, but the server could not be reached to revoke it.');
  console.log(style.dim(`Revoke it at ${config.host}/tokens if this machine is not yours.`));
}

export async function whoami(): Promise<void> {
  const config = readConfig();
  if (!config) throw new CliError('Not signed in. Run `flone login`.');

  const call = client(config.host, config.token);
  const me = await call<Me>('whoami');
  const { organizations } = await call<{ organizations: NavOrg[] }>('list_boards');

  console.log(`${style.bold(me.name)} <${me.email}>`);
  console.log(style.dim(`${config.host}`));

  for (const org of organizations) {
    const projects = org.workspaces.flatMap((workspace) => workspace.projects);
    console.log(
      `\n${style.cyan(org.name)} ${style.dim(`(${org.role.toLowerCase()})`)}\n  ${
        projects.length === 0
          ? style.dim('no projects')
          : projects.map((project) => `${project.key} ${style.dim(project.name)}`).join('\n  ')
      }`,
    );
  }
}
