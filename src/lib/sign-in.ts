import 'server-only';

import { z } from 'zod';

import { prisma } from '@/lib/db';
import { sendVerificationMail } from '@/lib/mailer';
import { DUMMY_HASH, hashPassword, needsRehash, verifyPassword } from '@/lib/password';
import { LIMITS, clientIp, consume, loginEmailKey, loginIpKey, reset } from '@/lib/rate-limit';
import { ERRORS } from '@/lib/result';
import { createSession, purgeExpiredSessions, rotatePresentedSession } from '@/lib/session';
import { emailSchema, loginPasswordSchema } from '@/lib/validation';

/**
 * SPEC §6.2 — credential verification, shared by every transport.
 *
 * This used to live inside the `signIn` Server Action. It moved here when the
 * CLI needed to sign in over HTTP: a Server Action is not callable from outside
 * a browser, and the alternative — a second copy of the checks below — is how
 * one transport quietly loses the dummy hash and starts leaking the account
 * list. There is one implementation; the callers differ only in what they do
 * with the token afterwards.
 *
 * Enumeration resistance is the whole design:
 *
 *  - exactly ONE database round-trip and exactly ONE scrypt invocation on both
 *    the known-email and unknown-email branches;
 *  - every failure — zod rejection, unknown email, wrong password, corrupt
 *    stored hash — returns the identical literal `ERRORS.INVALID_CREDENTIALS`;
 *  - the email-keyed rate limit is consumed even when the email does not exist,
 *    otherwise the presence of the throttle message becomes exactly the oracle
 *    the dummy hash exists to close.
 *
 * What deliberately did NOT move: `setSessionCookie`, `revalidatePath` and
 * `redirect`. All three are browser-shaped and two of them are legal only
 * inside a Server Action, so they stay with the caller that has a browser.
 *
 * Nothing in this file is ever logged: not the password, not the normalized
 * email, not the stored hash, not the session token (SPEC §4.7).
 */

const signInSchema = z.object({
  email: emailSchema,
  // min(1) rather than min(12): a too-short password must fail as a credential
  // error, never as a validation error that reveals the policy comparison ran.
  password: loginPasswordSchema,
});

export type SignInOutcome =
  | {
      ok: true;
      token: string;
      expiresAt: Date;
      user: { id: string; name: string; email: string };
    }
  | { ok: false; error: string; reason: 'INVALID' | 'RATE_LIMITED' | 'UNVERIFIED' };

/**
 * The one message here that is NOT `INVALID_CREDENTIALS`. Reachable only after
 * the password has been verified — see the comment at the branch.
 */
export const UNVERIFIED = 'Confirm your email address to sign in. We have sent you a new link.';

/** The single failure literal. Every unhappy path funnels through here. */
function invalidCredentials(): SignInOutcome {
  return { ok: false, error: ERRORS.INVALID_CREDENTIALS, reason: 'INVALID' };
}

/**
 * `reason` exists so an HTTP caller can pick a status code. It is NOT extra
 * information: each value maps one-to-one onto a message the app already
 * returns in plain text, so a client learns nothing from the code that the
 * body did not already tell it.
 */
export async function attemptSignIn(
  rawEmail: unknown,
  rawPassword: unknown,
): Promise<SignInOutcome> {
  // Limits are consumed BEFORE any hashing, so a throttled request costs
  // microseconds instead of ~250 ms of CPU (SPEC §4.3).
  const ip = await clientIp();
  if (!consume(loginIpKey(ip), LIMITS.LOGIN_IP.limit, LIMITS.LOGIN_IP.windowMs)) {
    return { ok: false, error: ERRORS.RATE_LIMITED, reason: 'RATE_LIMITED' };
  }

  const parsed = signInSchema.safeParse({ email: rawEmail, password: rawPassword });

  // Per-field zod messages are deliberately collapsed into the one literal.
  if (!parsed.success) return invalidCredentials();

  const { email, password } = parsed.data;

  // Consumed for unknown emails too — see the file header.
  if (!consume(loginEmailKey(email), LIMITS.LOGIN_EMAIL.limit, LIMITS.LOGIN_EMAIL.windowMs)) {
    return { ok: false, error: ERRORS.RATE_LIMITED, reason: 'RATE_LIMITED' };
  }

  const user = await prisma.user.findUnique({
    where: { email },
    select: { id: true, name: true, passwordHash: true, emailVerified: true },
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

  /*
   * The verification gate, and its POSITION IS THE DESIGN: it sits AFTER the
   * password check, never before.
   *
   * Answering "confirm your email" to anyone who merely typed an address would
   * be a perfect account oracle. Answering it to someone who has just proved
   * they know the password tells them nothing they did not already know, so
   * this branch is safe here and would not be one line earlier.
   *
   * A fresh link is sent on every attempt — the common case is someone who lost
   * the first one — and `issueToken` retires the previous token, so a mailbox
   * cannot accumulate live credentials. The email bucket consumed above is what
   * bounds this.
   */
  if (user.emailVerified === null) {
    await sendVerificationMail({ id: user.id, name: user.name, email });
    return { ok: false, error: UNVERIFIED, reason: 'UNVERIFIED' };
  }

  // Transparent parameter upgrade on a successful login (SPEC §4.1). Best
  // effort: a failed re-hash must never cost the user their sign-in.
  if (needsRehash(user.passwordHash)) {
    const upgraded = await hashPassword(password);
    await prisma.user
      .update({ where: { id: user.id }, data: { passwordHash: upgraded } })
      .catch(() => undefined);
  }

  // Rotation first: a token the request already carried must not survive
  // authentication (session fixation). On the CLI path the request carries
  // nothing, so this is a no-op there rather than a special case.
  await rotatePresentedSession();

  const { token, expiresAt } = await createSession(user.id);

  // Table hygiene, never a security control — expiry is enforced on every read.
  await purgeExpiredSessions(user.id);

  // A legitimate user must never stay throttled after proving who they are.
  reset(loginEmailKey(email));

  return { ok: true, token, expiresAt, user: { id: user.id, name: user.name, email } };
}
