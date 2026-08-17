import 'server-only';
import { headers } from 'next/headers';

/**
 * SPEC 4.3 -- in-process fixed-window rate limiter.
 *
 * Memory must be bounded or the limiter is itself a DoS: expired entries are
 * swept every 500th call, the map is hard-capped, and eviction is in insertion
 * order when full.
 *
 * ACCEPTED RISK (SPEC 8.1): counters live in one Node process, so a redeploy or
 * crash zeroes every bucket, and running more than one replica silently
 * multiplies every limit by N. scrypt itself is the real floor.
 */

type Bucket = { count: number; resetAt: number };

const buckets = new Map<string, Bucket>();

const MAX_KEYS = 20_000;
const SWEEP_EVERY = 500;

let callCount = 0;

function sweep(now: number): void {
  for (const [key, bucket] of buckets) {
    if (bucket.resetAt <= now) buckets.delete(key);
  }
}

function evictOldest(): void {
  const oldest = buckets.keys().next();
  if (!oldest.done) buckets.delete(oldest.value);
}

/**
 * Records one attempt against `key`. Returns `true` when the attempt is allowed
 * and `false` when the window is exhausted.
 *
 * MUST be consumed BEFORE any scrypt call, so a throttled request costs
 * microseconds instead of 250 ms of CPU.
 */
export function consume(key: string, limit: number, windowMs: number): boolean {
  const now = Date.now();

  callCount += 1;
  if (callCount % SWEEP_EVERY === 0) sweep(now);

  const existing = buckets.get(key);

  if (!existing || existing.resetAt <= now) {
    if (!existing && buckets.size >= MAX_KEYS) evictOldest();
    buckets.set(key, { count: 1, resetAt: now + windowMs });
    return true;
  }

  if (existing.count >= limit) return false;

  existing.count += 1;
  return true;
}

/** Clears a bucket. Called on successful login so a legitimate user is never stuck. */
export function reset(key: string): void {
  buckets.delete(key);
}

/* -------------------------------------------------------------------------- */
/* Bucket configuration (SPEC 4.3)                                             */
/* -------------------------------------------------------------------------- */

const FIFTEEN_MINUTES = 15 * 60 * 1000;
const ONE_HOUR = 60 * 60 * 1000;

export const LIMITS = {
  LOGIN_IP: { limit: 30, windowMs: FIFTEEN_MINUTES },
  LOGIN_EMAIL: { limit: 10, windowMs: FIFTEEN_MINUTES },
  REGISTER_IP: { limit: 5, windowMs: ONE_HOUR },

  /**
   * Email-sending buckets.
   *
   * These throttle a mailbox as much as a database: without them, anyone can
   * point the reset form at someone else's address and flood their inbox on
   * demand, which is harassment and gets the sending domain blocked. Both the
   * address and the origin are limited, because either alone is trivially
   * sidestepped -- one attacker, many victims is caught by the IP bucket; many
   * attackers, one victim by the email bucket.
   */
  RESET_EMAIL: { limit: 3, windowMs: ONE_HOUR },
  RESET_IP: { limit: 10, windowMs: ONE_HOUR },
  VERIFY_EMAIL: { limit: 3, windowMs: ONE_HOUR },
  VERIFY_IP: { limit: 10, windowMs: ONE_HOUR },

  /**
   * Image uploads, keyed on the USER rather than the origin.
   *
   * What this rations is bucket space, not CPU, and every uploader is already an
   * authenticated member -- so the account is the only thing worth counting, and
   * it is the one identifier a client cannot rotate. At 10 MB a file this caps one
   * account at 600 MB an hour, which is far above pasting screenshots into issues
   * and far below anything worth a storage bill.
   */
  UPLOAD_USER: { limit: 60, windowMs: ONE_HOUR },
} as const;

export function loginIpKey(ip: string): string {
  return `login:ip:${ip}`;
}

/** Keyed on the NORMALIZED email. Must be consumed even when the email is unknown. */
export function loginEmailKey(normalizedEmail: string): string {
  return `login:email:${normalizedEmail}`;
}

export function registerIpKey(ip: string): string {
  return `register:ip:${ip}`;
}

/**
 * Consumed on the NORMALIZED email whether or not an account exists -- the
 * throttle message must not become the oracle the generic response exists to
 * close.
 */
export function resetEmailKey(normalizedEmail: string): string {
  return `reset:email:${normalizedEmail}`;
}

export function resetIpKey(ip: string): string {
  return `reset:ip:${ip}`;
}

export function verifyEmailKey(normalizedEmail: string): string {
  return `verify:email:${normalizedEmail}`;
}

export function verifyIpKey(ip: string): string {
  return `verify:ip:${ip}`;
}

/** The session user's id, which is never client-supplied. */
export function uploadUserKey(userId: string): string {
  return `upload:user:${userId}`;
}

/* -------------------------------------------------------------------------- */
/* Client IP                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Prefer `x-real-ip`, fall back to the leftmost `x-forwarded-for` entry, else
 * the constant `'unknown'`.
 *
 * ACCEPTED RISK (SPEC 8.4): `x-forwarded-for` is client-controllable when the
 * proxy appends rather than replaces, so IP buckets can be rotated away. The
 * email-keyed bucket -- which cannot be spoofed -- is the account-takeover
 * control.
 */
export async function clientIp(): Promise<string> {
  const h = await headers();

  const real = h.get('x-real-ip')?.trim();
  if (real) return real.slice(0, 64);

  const forwarded = h.get('x-forwarded-for');
  if (forwarded) {
    const first = forwarded.split(',')[0]?.trim();
    if (first) return first.slice(0, 64);
  }

  return 'unknown';
}
