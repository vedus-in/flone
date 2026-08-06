'use server';

import { randomUUID } from 'node:crypto';
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { EmailTokenPurpose } from '@prisma/client';

import { isNextControlFlowError } from '@/lib/authz';
import { prisma } from '@/lib/db';
import { consumeToken } from '@/lib/email-token';
import { sendVerificationMail } from '@/lib/mailer';
import {
  LIMITS,
  clientIp,
  consume,
  verifyEmailKey,
  verifyIpKey,
} from '@/lib/rate-limit';
import { ERRORS, fail, ok, type ActionResult } from '@/lib/result';
import { createSession, rotatePresentedSession, setSessionCookie } from '@/lib/session';
import { emailSchema, emailTokenSchema } from '@/lib/validation';

/**
 * `/verify` -- confirm an address, or ask for another link.
 *
 * Design: docs/superpowers/specs/2026-08-06-email-design.md
 *
 * CONFIRMATION IS A POST, NOT A GET. The emailed link opens a page with a
 * button; this action runs when the button is pressed. Consuming the token
 * during the GET would be simpler and is wrong: corporate link scanners,
 * Outlook Safe Links and mail-client prefetchers all fetch URLs found in mail,
 * so a one-time token would routinely be spent before the human ever clicked --
 * and the session cookie would be handed to the scanner rather than the reader.
 */

const INVALID_LINK = 'That link is invalid, expired, or already used. Request a new one below.';

/**
 * Deliberately says nothing about whether the address exists or whether it
 * still needed confirming. This form is reachable by anyone.
 */
const RESENT = 'If that address still needs confirming, we have sent it a new link.';

/* -------------------------------------------------------------------------- */
/* confirmEmail                                                                */
/* -------------------------------------------------------------------------- */

async function attemptConfirm(formData: FormData): Promise<ActionResult> {
  const parsed = emailTokenSchema.safeParse(formData.get('token'));
  if (!parsed.success) return fail(INVALID_LINK);

  const payload = await consumeToken(parsed.data, EmailTokenPurpose.EMAIL_VERIFY);
  // Missing, wrong purpose, expired and already-spent are one answer, so no
  // probe can tell them apart.
  if (!payload?.userId) return fail(INVALID_LINK);

  // `updateMany` rather than `update`: a user deleted between the consume and
  // here is a no-op instead of a thrown P2025 that becomes a 500.
  const { count } = await prisma.user.updateMany({
    where: { id: payload.userId },
    data: { emailVerified: new Date() },
  });
  if (count !== 1) return fail(INVALID_LINK);

  // A stale cookie may still be attached even though this flow is unauthenticated.
  await rotatePresentedSession();

  const { token, expiresAt } = await createSession(payload.userId);
  await setSessionCookie(token, expiresAt);

  revalidatePath('/', 'layout');
  return ok();
}

export async function confirmEmail(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  let outcome: ActionResult;

  try {
    outcome = await attemptConfirm(formData);
  } catch (e) {
    if (isNextControlFlowError(e)) throw e;
    console.error(`[confirmEmail] unexpected_failure ref=${randomUUID().slice(0, 8)}`);
    return fail(ERRORS.UNEXPECTED);
  }

  // `redirect()` throws to signal, so it is called after the try/catch closes
  // and on the success path only (SPEC 6.1 rule 7). `/` then dispatches a
  // brand-new zero-org user to `/orgs/new`.
  if (outcome.ok) redirect('/');
  return outcome;
}

/* -------------------------------------------------------------------------- */
/* resendVerification                                                          */
/* -------------------------------------------------------------------------- */

async function attemptResend(formData: FormData): Promise<ActionResult> {
  const ip = await clientIp();
  if (!consume(verifyIpKey(ip), LIMITS.VERIFY_IP.limit, LIMITS.VERIFY_IP.windowMs)) {
    return fail(ERRORS.RATE_LIMITED);
  }

  const parsed = emailSchema.safeParse(formData.get('email'));
  // Even a malformed address returns the success literal: "that is not a valid
  // email" here would be harmless, but two different answers on this form is
  // exactly the shape that grows into an oracle.
  if (!parsed.success) return ok(RESENT);

  const email = parsed.data;

  // Consumed for unknown addresses too, or the presence of the throttle message
  // becomes the oracle the generic response exists to close.
  if (!consume(verifyEmailKey(email), LIMITS.VERIFY_EMAIL.limit, LIMITS.VERIFY_EMAIL.windowMs)) {
    return fail(ERRORS.RATE_LIMITED);
  }

  const user = await prisma.user.findFirst({
    where: { email, emailVerified: null },
    select: { id: true, name: true, email: true },
  });

  if (user) await sendVerificationMail(user);

  return ok(RESENT);
}

export async function resendVerification(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  try {
    return await attemptResend(formData);
  } catch (e) {
    if (isNextControlFlowError(e)) throw e;
    console.error(`[resendVerification] unexpected_failure ref=${randomUUID().slice(0, 8)}`);
    return fail(ERRORS.UNEXPECTED);
  }
}
