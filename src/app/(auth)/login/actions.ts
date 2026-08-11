'use server';

import { randomUUID } from 'node:crypto';
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';

import { isNextControlFlowError } from '@/lib/authz';
import { ERRORS, type ActionResult } from '@/lib/result';
import { setSessionCookie } from '@/lib/session';
import { attemptSignIn } from '@/lib/sign-in';

/**
 * SPEC §6.2 — `signIn`, the browser transport.
 *
 * The credential checks — rate limits, dummy hash, the single failure literal,
 * the email-verification gate — live in `@/lib/sign-in` and are shared with
 * `/api/cli/login`. What is left here is the part that only makes sense for a
 * browser: set the cookie, revalidate, redirect.
 *
 * Nothing in this file is ever logged: not the password, not the normalized
 * email, not the session token (SPEC §4.7).
 */

async function attempt(formData: FormData): Promise<ActionResult> {
  const outcome = await attemptSignIn(formData.get('email'), formData.get('password'));

  // `reason` is for HTTP status codes; the browser only ever needed the message.
  if (!outcome.ok) return { ok: false, error: outcome.error };

  await setSessionCookie(outcome.token, outcome.expiresAt);

  revalidatePath('/', 'layout');
  return { ok: true };
}

export async function signIn(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  let outcome: ActionResult;

  try {
    outcome = await attempt(formData);
  } catch (e) {
    if (isNextControlFlowError(e)) throw e;
    // A short code plus a correlation id. Never `e.message`, never the FormData,
    // never a Prisma message (SPEC §4.7).
    console.error(`[signIn] unexpected_failure ref=${randomUUID().slice(0, 8)}`);
    return { ok: false, error: ERRORS.UNEXPECTED };
  }

  // `redirect()` throws to signal, so it is called AFTER the try/catch closes
  // and on the success path only (SPEC §6.1 rule 7).
  if (outcome.ok) redirect('/');
  return outcome;
}
