'use server';

import { randomUUID } from 'node:crypto';
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { z } from 'zod';

import { isNextControlFlowError } from '@/lib/authz';
import { prisma } from '@/lib/db';
import { DUMMY_HASH, hashPassword, needsRehash, verifyPassword } from '@/lib/password';
import { LIMITS, clientIp, consume, loginEmailKey, loginIpKey, reset } from '@/lib/rate-limit';
import { ERRORS, type ActionResult } from '@/lib/result';
import {
  createSession,
  purgeExpiredSessions,
  rotatePresentedSession,
  setSessionCookie,
} from '@/lib/session';
import { emailSchema, loginPasswordSchema } from '@/lib/validation';

/**
 * SPEC 6.2 -- `signIn`.
 *
 * Enumeration resistance is the whole design here:
 *
 *  - exactly ONE database round-trip and exactly ONE scrypt invocation on both
 *    the known-email and unknown-email branches;
 *  - every failure -- zod rejection, unknown email, wrong password, corrupt
 *    stored hash -- returns the identical literal `ERRORS.INVALID_CREDENTIALS`;
 *  - the email-keyed rate limit is consumed even when the email does not exist,
 *    otherwise the presence of the throttle message becomes exactly the oracle
 *    the dummy hash exists to close.
 *
 * Nothing in this file is ever logged: not the password, not the normalized
 * email, not the stored hash, not the session token (SPEC 4.7).
 */

const signInSchema = z.object({
  email: emailSchema,
  // min(1) rather than min(12): a too-short password must fail as a credential
  // error, never as a validation error that reveals the policy comparison ran.
  password: loginPasswordSchema,
});

/** The single failure literal. Every unhappy path funnels through here. */
function invalidCredentials(): ActionResult {
  return { ok: false, error: ERRORS.INVALID_CREDENTIALS };
}

async function attemptSignIn(formData: FormData): Promise<ActionResult> {
  // Limits are consumed BEFORE any hashing, so a throttled request costs
  // microseconds instead of ~250 ms of CPU (SPEC 4.3).
  const ip = await clientIp();
  if (!consume(loginIpKey(ip), LIMITS.LOGIN_IP.limit, LIMITS.LOGIN_IP.windowMs)) {
    return { ok: false, error: ERRORS.RATE_LIMITED };
  }

  const parsed = signInSchema.safeParse({
    email: formData.get('email'),
    password: formData.get('password'),
  });

  // Per-field zod messages are deliberately collapsed into the one literal.
  if (!parsed.success) return invalidCredentials();

  const { email, password } = parsed.data;

  // Consumed for unknown emails too -- see the file header.
  if (!consume(loginEmailKey(email), LIMITS.LOGIN_EMAIL.limit, LIMITS.LOGIN_EMAIL.windowMs)) {
    return { ok: false, error: ERRORS.RATE_LIMITED };
  }

  const user = await prisma.user.findUnique({
    where: { email },
    select: { id: true, passwordHash: true },
  });

  let verified = false;
  if (user) {
    verified = await verifyPassword(password, user.passwordHash);
  } else {
    // Result deliberately discarded. MUST NOT be removed: without it an unknown
    // email answers ~250 ms faster than a known one and the account list leaks.
    await verifyPassword(password, DUMMY_HASH);
  }

  if (!user || !verified) return invalidCredentials();

  // Transparent parameter upgrade on a successful login (SPEC 4.1). Best effort:
  // a failed re-hash must never cost the user their sign-in.
  if (needsRehash(user.passwordHash)) {
    const upgraded = await hashPassword(password);
    await prisma.user
      .update({ where: { id: user.id }, data: { passwordHash: upgraded } })
      .catch(() => undefined);
  }

  // Rotation first: a token the request already carried must not survive
  // authentication (session fixation).
  await rotatePresentedSession();

  const { token, expiresAt } = await createSession(user.id);
  await setSessionCookie(token, expiresAt);

  // Table hygiene, never a security control -- expiry is enforced on every read.
  await purgeExpiredSessions(user.id);

  // A legitimate user must never stay throttled after proving who they are.
  reset(loginEmailKey(email));

  revalidatePath('/', 'layout');
  return { ok: true };
}

export async function signIn(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  let outcome: ActionResult;

  try {
    outcome = await attemptSignIn(formData);
  } catch (e) {
    if (isNextControlFlowError(e)) throw e;
    // A short code plus a correlation id. Never `e.message`, never the FormData,
    // never a Prisma message (SPEC 4.7).
    console.error(`[signIn] unexpected_failure ref=${randomUUID().slice(0, 8)}`);
    return { ok: false, error: ERRORS.UNEXPECTED };
  }

  // `redirect()` throws to signal, so it is called AFTER the try/catch closes
  // and on the success path only (SPEC 6.1 rule 7).
  if (outcome.ok) redirect('/');
  return outcome;
}
