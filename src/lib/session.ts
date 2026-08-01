import 'server-only';
import { createHash, randomBytes } from 'node:crypto';
import { cache } from 'react';
import { cookies } from 'next/headers';
import { prisma } from '@/lib/db';

/**
 * SPEC §4.2 — opaque session tokens.
 *
 * The raw token is sent to the browser in an httpOnly cookie and NEVER stored.
 * Postgres holds only `sha256(token)` under a unique index, so verification is a
 * lookup by key rather than a comparison — there is no timing surface and
 * deliberately no constant-time compare. SHA-256 (not scrypt) is correct here: a
 * 256-bit uniformly random value has no dictionary, and this runs on every
 * request.
 */

/**
 * The `__Host-` prefix requires Secure, Path=/ and NO Domain attribute — exactly
 * what we set anyway, so the prefix is free. It cannot be used over plain http,
 * hence the dev fallback.
 */
export const SESSION_COOKIE = process.env.NODE_ENV === 'production' ? '__Host-session' : 'session';

export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
export const REFRESH_AFTER_MS = 24 * 60 * 60 * 1000; // refresh once >1 day has elapsed

export type SessionRecord = {
  sessionId: string;
  expiresAt: Date;
  user: { id: string; email: string; name: string };
};

/* -------------------------------------------------------------------------- */
/* Internals                                                                   */
/* -------------------------------------------------------------------------- */

/** Never exported: `tokenHash` must not appear on any object outside this file. */
function hashToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

function cookieAttributes() {
  return {
    httpOnly: true,
    sameSite: 'lax' as const,
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    // No `domain` — required by the __Host- prefix.
  };
}

/** Next control-flow errors must never be swallowed. */
function isNextControlFlowError(e: unknown): boolean {
  if (!e || typeof e !== 'object' || !('digest' in e)) return false;
  const digest = (e as { digest?: unknown }).digest;
  if (typeof digest !== 'string') return false;
  return (
    digest === 'NEXT_NOT_FOUND' ||
    digest.startsWith('NEXT_REDIRECT') ||
    digest.startsWith('NEXT_HTTP_ERROR_FALLBACK')
  );
}

async function presentedToken(): Promise<string | null> {
  const store = await cookies();
  const value = store.get(SESSION_COOKIE)?.value;
  return value && value.length > 0 ? value : null;
}

/* -------------------------------------------------------------------------- */
/* Read                                                                        */
/* -------------------------------------------------------------------------- */

async function loadSession(): Promise<SessionRecord | null> {
  const token = await presentedToken();
  if (!token) return null;

  const tokenHash = hashToken(token);

  const row = await prisma.session.findUnique({
    where: { tokenHash },
    // Explicit select — `passwordHash` must never be hydrated here.
    select: {
      id: true,
      expiresAt: true,
      user: { select: { id: true, email: true, name: true } },
    },
  });

  if (!row) return null;

  const now = Date.now();

  if (row.expiresAt.getTime() <= now) {
    // Opportunistic cleanup. Expiry is enforced on every read regardless, so
    // this is table hygiene and never a security control.
    await prisma.session.deleteMany({ where: { tokenHash } }).catch(() => undefined);
    return null;
  }

  let expiresAt = row.expiresAt;
  const elapsed = SESSION_TTL_MS - (row.expiresAt.getTime() - now);

  if (elapsed > REFRESH_AFTER_MS) {
    const extended = new Date(now + SESSION_TTL_MS);
    const updated = await prisma.session
      .updateMany({ where: { tokenHash }, data: { expiresAt: extended } })
      .catch(() => null);
    if (updated && updated.count > 0) expiresAt = extended;
  }

  return { sessionId: row.id, expiresAt, user: row.user };
}

/**
 * Request-scoped memoization: a page, its layouts and every `require*` helper in
 * the same render share one round-trip.
 *
 * This NEVER calls `cookies().set` — Next 15 forbids mutating cookies during a
 * Server Component render. The rolling refresh is therefore split: the DB row is
 * extended here, the browser cookie is re-issued by `touchSessionCookie()` on the
 * Server Action path (SPEC §7.17).
 */
export const readSession: () => Promise<SessionRecord | null> = cache(loadSession);

/* -------------------------------------------------------------------------- */
/* Write                                                                       */
/* -------------------------------------------------------------------------- */

/** 256 bits of entropy, 43 URL-safe characters. */
export async function createSession(userId: string): Promise<{ token: string; expiresAt: Date }> {
  const token = randomBytes(32).toString('base64url');
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
  await prisma.session.create({
    data: { tokenHash: hashToken(token), userId, expiresAt },
  });
  return { token, expiresAt };
}

/** Only legal inside a Server Action. */
export async function setSessionCookie(token: string, expiresAt: Date): Promise<void> {
  const store = await cookies();
  store.set(SESSION_COOKIE, token, { ...cookieAttributes(), expires: expiresAt });
}

/**
 * Rotation on login: destroy whatever session the request already carries before
 * minting a new one, so a fixated token cannot survive authentication.
 * Multiple concurrent sessions per user remain allowed; there is no cap.
 */
export async function rotatePresentedSession(): Promise<void> {
  const token = await presentedToken();
  if (!token) return;
  await prisma.session.deleteMany({ where: { tokenHash: hashToken(token) } });
}

/** Table hygiene after a successful login. */
export async function purgeExpiredSessions(userId: string): Promise<void> {
  await prisma.session
    .deleteMany({ where: { userId, expiresAt: { lt: new Date() } } })
    .catch(() => undefined);
}

/** Delete the row, then clear the cookie with byte-identical attributes. */
export async function destroySession(): Promise<void> {
  const store = await cookies();
  const token = store.get(SESSION_COOKIE)?.value;
  if (token) {
    await prisma.session.deleteMany({ where: { tokenHash: hashToken(token) } });
  }
  store.set(SESSION_COOKIE, '', { ...cookieAttributes(), maxAge: 0 });
}

/**
 * Re-issues the browser cookie with the refreshed expiry. Called by
 * `requireUser()`; on a render path `cookies().set` throws and we ignore it,
 * which is precisely the "only when invoked from a Server Action" behaviour the
 * spec asks for. Next control-flow errors are re-thrown.
 */
async function touchCookie(): Promise<void> {
  const session = await readSession();
  if (!session) return;
  try {
    const store = await cookies();
    const token = store.get(SESSION_COOKIE)?.value;
    if (!token) return;
    store.set(SESSION_COOKIE, token, { ...cookieAttributes(), expires: session.expiresAt });
  } catch (e) {
    if (isNextControlFlowError(e)) throw e;
    // Not a Server Action - the DB-side extension in readSession() already ran.
  }
}

/**
 * `cache()`d so the N `requireUser()` calls a single request makes attempt the
 * cookie write exactly once.
 */
export const touchSessionCookie: () => Promise<void> = cache(touchCookie);
