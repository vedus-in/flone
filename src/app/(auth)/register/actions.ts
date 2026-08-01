'use server';

import { randomUUID } from 'node:crypto';
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { z } from 'zod';

import { isNextControlFlowError } from '@/lib/authz';
import { prisma } from '@/lib/db';
import { hashPassword } from '@/lib/password';
import { LIMITS, clientIp, consume, registerIpKey } from '@/lib/rate-limit';
import { ERRORS, type ActionResult } from '@/lib/result';
import { createSession, rotatePresentedSession, setSessionCookie } from '@/lib/session';
import { emailSchema, passwordSchema, userNameSchema } from '@/lib/validation';

/**
 * SPEC 6.2 -- `register`.
 *
 * Three fields. It does NOT create an organization: `/` dispatches a zero-org
 * user to `/orgs/new`, which is the single org-creation path in the app
 * (SPEC 7.3). A user can end up with zero orgs anyway -- removed from their only
 * one, or the org deleted -- so that path has to exist regardless, and having it
 * exercised on every signup is better than having two.
 *
 * ACCEPTED RISK (SPEC 4.4 / 8.2): registration reveals whether an email is
 * already registered. Hiding it requires the "we sent you an email" pattern and
 * email sending is out of scope. The disclosure is bounded at 5 registrations
 * per IP per hour; login stays fully generic because login is what
 * credential-stuffing bots actually spray.
 *
 * Nothing here is ever logged: not the password, not the hash, not the token.
 */

const EMAIL_TAKEN = 'An account with that email already exists.';
const CHECK_FIELDS = 'Please check the highlighted fields.';

/**
 * Closed literals. zod's own messages are never surfaced, so no schema internal
 * can leak into the UI and no message can drift per-field.
 */
const FIELD_MESSAGES = {
  name: 'Enter your name (1 to 80 characters).',
  email: 'Enter a valid email address.',
  password: 'Use at least 12 characters.',
} as const;

type FieldName = keyof typeof FIELD_MESSAGES;

const registerSchema = z.object({
  name: userNameSchema,
  email: emailSchema,
  password: passwordSchema,
});

/**
 * Typed structurally rather than as `z.ZodIssue` so the mapping does not depend
 * on a zod type name (the `path` element type differs between zod majors).
 */
function fieldErrorsFrom(
  issues: ReadonlyArray<{ path: ReadonlyArray<PropertyKey> }>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const issue of issues) {
    const key = issue.path[0];
    if (typeof key !== 'string') continue;
    if (!(key in FIELD_MESSAGES)) continue;
    if (key in out) continue;
    out[key] = FIELD_MESSAGES[key as FieldName];
  }
  return out;
}

/**
 * Structural check on the Prisma unique-violation code. The code is used to
 * branch and is NEVER returned to the client (SPEC 9).
 */
function isUniqueViolation(e: unknown): boolean {
  return (
    typeof e === 'object' &&
    e !== null &&
    'code' in e &&
    (e as { code?: unknown }).code === 'P2002'
  );
}

function emailTaken(): ActionResult {
  return { ok: false, error: EMAIL_TAKEN };
}

async function attemptRegister(formData: FormData): Promise<ActionResult> {
  // Consumed before any hashing (SPEC 4.3).
  const ip = await clientIp();
  if (!consume(registerIpKey(ip), LIMITS.REGISTER_IP.limit, LIMITS.REGISTER_IP.windowMs)) {
    return { ok: false, error: ERRORS.RATE_LIMITED };
  }

  const parsed = registerSchema.safeParse({
    name: formData.get('name'),
    email: formData.get('email'),
    password: formData.get('password'),
  });

  if (!parsed.success) {
    return {
      ok: false,
      error: CHECK_FIELDS,
      fieldErrors: fieldErrorsFrom(parsed.error.issues),
    };
  }

  const { name, email, password } = parsed.data;

  // Pre-check for the common case; the `P2002` branch below covers the race
  // between this read and the insert, which is real rather than theoretical.
  const existing = await prisma.user.findUnique({ where: { email }, select: { id: true } });
  if (existing) return emailTaken();

  // ~250 ms of CPU, gated by the semaphore inside `hashPassword`.
  const passwordHash = await hashPassword(password);

  let userId: string;
  try {
    const created = await prisma.user.create({
      data: { name, email, passwordHash },
      select: { id: true },
    });
    userId = created.id;
  } catch (e) {
    if (isUniqueViolation(e)) return emailTaken();
    throw e;
  }

  // Registration is not an authentication of an existing identity, but a
  // request may still arrive carrying a stale cookie. Drop it before minting a
  // new token so no fixated session can survive.
  await rotatePresentedSession();

  const { token, expiresAt } = await createSession(userId);
  await setSessionCookie(token, expiresAt);

  revalidatePath('/', 'layout');
  return { ok: true };
}

export async function register(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  let outcome: ActionResult;

  try {
    outcome = await attemptRegister(formData);
  } catch (e) {
    if (isNextControlFlowError(e)) throw e;
    console.error(`[register] unexpected_failure ref=${randomUUID().slice(0, 8)}`);
    return { ok: false, error: ERRORS.UNEXPECTED };
  }

  // After the try/catch closes, success path only (SPEC 6.1 rule 7).
  // `/` then dispatches the brand-new zero-org user to `/orgs/new`.
  if (outcome.ok) redirect('/');
  return outcome;
}
