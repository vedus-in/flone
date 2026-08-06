'use server';

import { randomUUID } from 'node:crypto';
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { EmailTokenPurpose } from '@prisma/client';
import { z } from 'zod';

import { isNextControlFlowError } from '@/lib/authz';
import { prisma } from '@/lib/db';
import { consumeToken } from '@/lib/email-token';
import { sendPasswordChangedMail, sendPasswordResetMail } from '@/lib/mailer';
import { hashPassword } from '@/lib/password';
import { LIMITS, clientIp, consume, resetEmailKey, resetIpKey } from '@/lib/rate-limit';
import { ERRORS, fail, ok, type ActionResult } from '@/lib/result';
import { createSession, rotatePresentedSession, setSessionCookie } from '@/lib/session';
import { emailSchema, emailTokenSchema, passwordSchema } from '@/lib/validation';

/**
 * `/reset` -- request a link, then set a new password.
 *
 * Design: docs/superpowers/specs/2026-08-06-email-design.md
 *
 * Requesting a link ALWAYS answers the same thing. This form is the easiest
 * account oracle to build into an app and the easiest to avoid: one literal,
 * one code path, whether or not the address exists.
 *
 * Nothing here is ever logged: not the password, not the hash, not the token.
 */

const INVALID_LINK = 'That link is invalid, expired, or already used. Request a new one below.';
const CHECK_FIELDS = 'Please check the highlighted fields.';
const PASSWORD_RULE = 'Use at least 12 characters.';

/** The single literal for a request, whatever happened behind it. */
const SENT = 'If an account exists for that address, we have sent it a reset link.';

/* -------------------------------------------------------------------------- */
/* requestReset                                                                */
/* -------------------------------------------------------------------------- */

async function attemptRequest(formData: FormData): Promise<ActionResult> {
  const ip = await clientIp();
  if (!consume(resetIpKey(ip), LIMITS.RESET_IP.limit, LIMITS.RESET_IP.windowMs)) {
    return fail(ERRORS.RATE_LIMITED);
  }

  const parsed = emailSchema.safeParse(formData.get('email'));
  // A malformed address gets the success literal too -- see the file header.
  if (!parsed.success) return ok(SENT);

  const email = parsed.data;

  // Consumed for unknown addresses as well. This bucket is also what stops the
  // form being used to flood somebody else's inbox on demand.
  if (!consume(resetEmailKey(email), LIMITS.RESET_EMAIL.limit, LIMITS.RESET_EMAIL.windowMs)) {
    return fail(ERRORS.RATE_LIMITED);
  }

  const user = await prisma.user.findUnique({
    where: { email },
    select: { id: true, name: true, email: true },
  });

  // An unverified account is deliberately eligible: the reset link proves the
  // address just as well as a verification link, so this doubles as a recovery
  // path for someone who never received the first mail.
  if (user) await sendPasswordResetMail(user);

  return ok(SENT);
}

export async function requestReset(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  try {
    return await attemptRequest(formData);
  } catch (e) {
    if (isNextControlFlowError(e)) throw e;
    console.error(`[requestReset] unexpected_failure ref=${randomUUID().slice(0, 8)}`);
    return fail(ERRORS.UNEXPECTED);
  }
}

/* -------------------------------------------------------------------------- */
/* completeReset                                                               */
/* -------------------------------------------------------------------------- */

const completeSchema = z.object({
  token: emailTokenSchema,
  password: passwordSchema,
});

async function attemptComplete(formData: FormData): Promise<ActionResult> {
  const parsed = completeSchema.safeParse({
    token: formData.get('token'),
    password: formData.get('password'),
  });

  if (!parsed.success) {
    // Distinguish the two failures, because they need different fixes: a bad
    // password is retryable on this page, a bad token is not. Neither says
    // anything about an account.
    const badToken = parsed.error.issues.some((issue) => issue.path[0] === 'token');
    return badToken ? fail(INVALID_LINK) : fail(CHECK_FIELDS, { password: PASSWORD_RULE });
  }

  const payload = await consumeToken(parsed.data.token, EmailTokenPurpose.PASSWORD_RESET);
  if (!payload?.userId) return fail(INVALID_LINK);

  const userId = payload.userId;

  // ~250 ms of CPU, gated by the semaphore inside `hashPassword`.
  const passwordHash = await hashPassword(parsed.data.password);

  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { name: true, email: true },
  });
  if (!user) return fail(INVALID_LINK);

  await prisma.$transaction([
    prisma.user.updateMany({
      where: { id: userId },
      data: {
        passwordHash,
        // The click proved the address. Someone who never confirmed can recover
        // this way and comes out verified.
        emailVerified: new Date(),
      },
    }),
    // EVERY session, not just this browser's.
    //
    // A reset is the response to a suspected compromise, so leaving the
    // attacker's session alive defeats the entire point of the flow. This takes
    // MCP access tokens with it, which is correct -- they are the same `Session`
    // rows, they carry the same full access, and an attacker who minted one
    // would otherwise keep it after the password changed.
    prisma.session.deleteMany({ where: { userId } }),
  ]);

  // Every session for this user is gone; this drops a cookie belonging to some
  // OTHER account before a new one is issued.
  await rotatePresentedSession();

  const { token, expiresAt } = await createSession(userId);
  await setSessionCookie(token, expiresAt);

  // Security notice, never gated by a preference: this is how the real owner
  // finds out that somebody else completed a reset against their account.
  sendPasswordChangedMail(user);

  revalidatePath('/', 'layout');
  return ok();
}

export async function completeReset(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  let outcome: ActionResult;

  try {
    outcome = await attemptComplete(formData);
  } catch (e) {
    if (isNextControlFlowError(e)) throw e;
    console.error(`[completeReset] unexpected_failure ref=${randomUUID().slice(0, 8)}`);
    return fail(ERRORS.UNEXPECTED);
  }

  // Success path only, after the try/catch closes (SPEC 6.1 rule 7).
  if (outcome.ok) redirect('/');
  return outcome;
}
