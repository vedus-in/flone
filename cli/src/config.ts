import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, platform } from 'node:os';
import { join } from 'node:path';

/**
 * Where the session token lives.
 *
 * The token IS a session — the same row the browser cookie points at, with the
 * same rights and the same 30-day rolling expiry. It is stored in plain text at
 * mode 0600, which is what gh, npm and aws all do: an attacker who can read
 * another user's home directory has already won, and encrypting it under a key
 * stored beside it would only look like security.
 */

export type Config = { host: string; token: string; project?: string };

const DEFAULT_HOST = 'http://localhost:3000';

/** Windows has no mode bits to speak of; `chmod` there is a documented no-op. */
const POSIX = platform() !== 'win32';

export function configDir(): string {
  if (process.env.FLONE_CONFIG_DIR) return process.env.FLONE_CONFIG_DIR;

  if (!POSIX) {
    const appData = process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming');
    return join(appData, 'flone');
  }

  const xdg = process.env.XDG_CONFIG_HOME;
  return join(xdg && xdg.trim() !== '' ? xdg : join(homedir(), '.config'), 'flone');
}

export function configPath(): string {
  return join(configDir(), 'config.json');
}

function readFile(): Partial<Config> | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(configPath(), 'utf8'));
    return parsed && typeof parsed === 'object' ? (parsed as Partial<Config>) : null;
  } catch {
    // Absent, unreadable or corrupt all mean the same thing to a caller: no
    // stored credential. A parse failure must not crash `flone login`, which is
    // the command that would fix it.
    return null;
  }
}

/**
 * Environment beats file, so CI can authenticate without a login step and
 * without writing anything to disk. `FLONE_TOKEN` alone is enough; the host
 * falls back to the stored one, then to localhost.
 */
export function readConfig(): Config | null {
  const file = readFile();
  const host = trimSlash(process.env.FLONE_URL ?? file?.host ?? DEFAULT_HOST);
  const token = process.env.FLONE_TOKEN ?? file?.token;

  if (!token) return null;
  return { host, token, ...(file?.project ? { project: file.project } : {}) };
}

/** The host to talk to before anyone has signed in — used by `flone login`. */
export function defaultHost(): string {
  return trimSlash(process.env.FLONE_URL ?? readFile()?.host ?? DEFAULT_HOST);
}

export function writeConfig(config: Config): void {
  mkdirSync(configDir(), { recursive: true, ...(POSIX ? { mode: 0o700 } : {}) });

  const path = configPath();
  writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });

  // `writeFileSync`'s mode applies only when it CREATES the file. Overwriting a
  // config that was somehow left world-readable would otherwise keep it that way.
  if (POSIX) chmodSync(path, 0o600);
}

/**
 * Reads the stored config, merges the default project, writes it back.
 *
 * Deliberately NOT `writeConfig({...readConfig(), project})`: `readConfig()`
 * folds in `FLONE_TOKEN`, so that spelling would quietly persist a CI
 * environment's credential to the developer's disk.
 */
export function setDefaultProject(projectKey: string): void {
  const file = readFile();
  if (!file?.token || !file.host) {
    throw new Error('No stored login to attach a default project to. Run `flone login` first.');
  }
  writeConfig({ host: file.host, token: file.token, project: projectKey });
}

export function clearConfig(): void {
  rmSync(configPath(), { force: true });
}

function trimSlash(url: string): string {
  return url.replace(/\/+$/, '');
}
