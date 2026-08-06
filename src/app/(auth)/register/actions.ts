'use server';

import { randomUUID } from 'node:crypto';
import { z } from 'zod';

import { isNextControlFlowError } from '@/lib/authz';
import { prisma } from '@/lib/db';
import { sendAccountExistsMail, sendVerificationMail } from '@/lib/mailer';
import { hashPassword } from '@/lib/password';
import { LIMITS, clientIp, consume, registerIpKey } from '@/lib/rate-limit';
import { ERRORS, ok, type ActionResult } from '@/lib/result';
import { rotatePresentedSession } from '@/lib/session';
import { isRegistrationOpen } from '@/lib/settings';
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
 * THIS ACTION IS THE ENFORCEMENT POINT FOR THE REGISTRATION GATE. `/register`
 * also calls `isRegistrationOpen()` so a closed instance does not draw a form
 * that cannot work, but that is cosmetic: a Server Action is a directly
 * addressable POST endpoint and is reachable whatever the page rendered.
 *
 * ENUMERATION (was SPEC 4.4 / 8.2, now closed). This action used to answer "an
 * account with that email already exists", which made it an oracle for whether
 * any address had an account. It no longer does. BOTH branches now:
 *
 *   1. send exactly one email -- a verification link to a new address, a "you
 *      already have an account" notice to an existing one;
 *   2. spend roughly the same CPU, because the taken branch runs a scrypt hash
 *      it throws away;
 *   3. return the IDENTICAL `ok()` result, which renders the same "check your
 *      inbox" screen.
 *
 * All three are load-bearing. A difference in ANY of them -- including latency
 * -- reopens the oracle, which is why the discarded hash below must not be
 * removed however dead it looks.
 *
 * NO SESSION IS CREATED HERE. Registering is a claim to own an address, not
 * proof of it; the session is minted by `/verify` once the emailed link is
 * clicked. `signIn` refuses to sign in an account whose `emailVerified` is null.
 *
 * Nothing here is ever logged: not the password, not the hash, not the token.
 */

const CHECK_FIELDS = 'Please check the highlighted fields.';
const REGISTRATION_CLOSED = 'Registration is currently closed.';

/**
 * The single success literal, returned whether or not the address was free.
 * Deliberately says nothing about which branch ran.
 */
const CHECK_INBOX = 'Check your inbox for a link to confirm your email address.';

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

/**
 * The "this address already has an account" branch, returning the same literal
 * as the success path.
 *
 * `password` is hashed and the result THROWN AWAY. That call is the entire
 * point of this function and MUST NOT be removed: the free-address branch
 * spends ~250 ms in scrypt, and without a matching cost here the taken branch
 * answers a quarter of a second sooner. The response bodies would be identical
 * and the timing alone would still enumerate every account on the instance.
 * This is the same device `signIn` uses with `DUMMY_HASH`.
 *
 * Pass `null` when a hash has already been paid for on this request.
 */
async function accountAlreadyExists(
  email: string,
  password: string | null,
): Promise<ActionResult> {
  if (password !== null) {
    await hashPassword(password);
  }

  sendAccountExistsMail(email);
  return ok(CHECK_INBOX);
}


async function attemptRegister(formData: FormData): Promise<ActionResult> {
  // FIRST, before the rate limiter and long before any scrypt work: a closed
  // instance must cost a single cheap read and nothing else. `isRegistrationOpen`
  // carries the bootstrap exception -- with zero users it returns true whatever
  // the flag says, so a disabled flag on an empty database cannot lock everyone
  // out permanently.
  if (!(await isRegistrationOpen())) {
    return { ok: false, error: REGISTRATION_CLOSED };
  }

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
  if (existing) return await accountAlreadyExists(email, password);

  // ~250 ms of CPU, gated by the semaphore inside `hashPassword`.
  const passwordHash = await hashPassword(password);

  let userId: string;
  try {
    // The count and the insert must agree, so both happen in ONE transaction:
    // the very first account on an instance is its first site administrator, and
    // nothing else can hand out `isAdmin` (SPEC -- site administration).
    //
    // ACCEPTED RISK: under READ COMMITTED two simultaneous first registrations
    // can both observe an empty table and both become admins. That is harmless
    // -- an admin governs registration and other admins, never tenant data --
    // and it is strictly safer than the alternative failure mode, an instance
    // with users and no admin at all.
    //
    // `isAdmin` is INSTANCE-level and grants NO access to any organization's
    // projects, boards, tickets or comments.
    const created = await prisma.$transaction(async (tx) => {
      const userCount = await tx.user.count();
      return tx.user.create({
        data: { name, email, passwordHash, isAdmin: userCount === 0 },
        select: { id: true },
      });
    });
    userId = created.id;
  } catch (e) {
    // The race: someone else inserted this address between the read above and
    // this write. The hash is already spent, so pass `null` rather than burning
    // a second one -- the CPU the branch exists to match has been paid.
    if (isUniqueViolation(e)) return await accountAlreadyExists(email, null);
    throw e;
  }

  // Registration is not an authentication of an existing identity, but a
  // request may still arrive carrying a stale cookie. Drop it before the user
  // goes to their inbox, so no fixated session survives the flow.
  await rotatePresentedSession();

  await sendVerificationMail({ id: userId, name, email });

  // NO SESSION. `/verify` mints it once the emailed link is clicked.
  return ok(CHECK_INBOX);
}

export async function register(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  try {
    // No `redirect()` any more, so there is no success path to keep outside the
    // try/catch: registering ends on the same page with the "check your inbox"
    // panel. Redirecting instead would have to redirect BOTH branches to the
    // same URL to stay non-enumerable, and a URL is a weaker guarantee of that
    // than one shared return.
    return await attemptRegister(formData);
  } catch (e) {
    if (isNextControlFlowError(e)) throw e;
    console.error(`[register] unexpected_failure ref=${randomUUID().slice(0, 8)}`);
    return { ok: false, error: ERRORS.UNEXPECTED };
  }
}
