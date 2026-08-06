'use server';

import { randomUUID } from 'node:crypto';
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { EmailTokenPurpose, Prisma, Role } from '@prisma/client';
import { z } from 'zod';

import { isNextControlFlowError } from '@/lib/authz';
import { prisma } from '@/lib/db';
import { consumeToken, peekToken } from '@/lib/email-token';
import { hashPassword } from '@/lib/password';
import { ERRORS, fail, ok, type ActionResult } from '@/lib/result';
import {
  createSession,
  readSession,
  rotatePresentedSession,
  setSessionCookie,
} from '@/lib/session';
import { emailTokenSchema, passwordSchema, userNameSchema } from '@/lib/validation';

/**
 * `/invite` -- accept an invitation to an organization.
 *
 * Design: docs/superpowers/specs/2026-08-06-email-design.md
 *
 * THE INVITATION IS BOUND TO AN ADDRESS, NOT TO WHOEVER OPENS THE LINK. This is
 * the security property of the whole flow and the reason for the
 * `WRONG_ACCOUNT` branch below.
 *
 * An invitation link travels by email, and email gets forwarded, quoted,
 * archived and leaked. If accepting simply granted membership to the current
 * session, then anyone who came into possession of Bob's link -- while signed in
 * as themselves -- would silently join the organization as themselves. So
 * membership is only ever granted to the account owning the invited address:
 * either by signing in as it, or by creating it here with that address.
 *
 * The role comes from the TOKEN, never from this form. An invitee must not be
 * able to choose what they are granted.
 *
 * This action bypasses `isRegistrationOpen()`. An admin naming one address is an
 * explicit per-address grant, and it is the only way a closed instance can
 * onboard anybody; the registration flag governs open public signup, which is
 * what it was built for.
 */

const INVALID_LINK = 'That invitation is invalid, expired, or already used.';
const CHECK_FIELDS = 'Please check the highlighted fields.';
const WRONG_ACCOUNT =
  'That invitation was sent to a different address. Sign out and open the link again.';
const SIGN_IN_FIRST =
  'An account already exists for that address. Sign in, then open the invitation link again.';

const FIELD_MESSAGES = {
  name: 'Enter your name (1 to 80 characters).',
  password: 'Use at least 12 characters.',
} as const;

const acceptSchema = z.object({
  token: emailTokenSchema,
  name: userNameSchema,
  password: passwordSchema,
});

function fieldErrorsFrom(
  issues: ReadonlyArray<{ path: ReadonlyArray<PropertyKey> }>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const issue of issues) {
    const key = issue.path[0];
    if (typeof key !== 'string') continue;
    if (!(key in FIELD_MESSAGES)) continue;
    if (key in out) continue;
    out[key] = FIELD_MESSAGES[key as keyof typeof FIELD_MESSAGES];
  }
  return out;
}

function isUniqueViolation(e: unknown): boolean {
  return e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002';
}

/**
 * Grants membership, treating "already a member" as success.
 *
 * Two invitations to the same address, both accepted, is a real race and the
 * `(userId, organizationId)` unique index is what makes it harmless -- the
 * second one has nothing left to do.
 */
async function grantMembership(
  userId: string,
  organizationId: string,
  role: Role,
): Promise<void> {
  try {
    await prisma.membership.create({
      data: { userId, organizationId, role },
      select: { id: true },
    });
  } catch (e) {
    if (!isUniqueViolation(e)) throw e;
  }
}

async function attemptAccept(formData: FormData): Promise<ActionResult & { slug?: string }> {
  const rawToken = emailTokenSchema.safeParse(formData.get('token'));
  if (!rawToken.success) return fail(INVALID_LINK);

  // PEEK first, spend later. The branches below can legitimately refuse -- wrong
  // account, account already exists -- and a refusal must not burn the
  // invitation, or the invitee is locked out by their own mistake.
  const payload = await peekToken(rawToken.data, EmailTokenPurpose.INVITE);
  if (!payload?.organizationId || !payload.role) return fail(INVALID_LINK);

  const org = await prisma.organization.findUnique({
    where: { id: payload.organizationId },
    select: { id: true, slug: true },
  });
  // The organization was deleted while the invitation sat in a mailbox. The
  // token cascaded with it in most cases; this covers the rest.
  if (!org) return fail(INVALID_LINK);

  const session = await readSession();

  /* ---------------------------------------------------------------------- */
  /* Signed in                                                               */
  /* ---------------------------------------------------------------------- */

  if (session) {
    // The binding check. Case-folding is not needed: both sides were stored
    // through `emailSchema`, which lowercases.
    if (session.user.email !== payload.email) return fail(WRONG_ACCOUNT);

    const spent = await consumeToken(rawToken.data, EmailTokenPurpose.INVITE);
    if (!spent) return fail(INVALID_LINK);

    await grantMembership(session.user.id, org.id, payload.role);

    revalidatePath('/', 'layout');
    return { ...ok(), slug: org.slug };
  }

  /* ---------------------------------------------------------------------- */
  /* Signed out                                                              */
  /* ---------------------------------------------------------------------- */

  const existing = await prisma.user.findUnique({
    where: { email: payload.email },
    select: { id: true },
  });

  // They have an account already. Do NOT consume: they need to come back to this
  // same link after signing in.
  if (existing) return fail(SIGN_IN_FIRST);

  const parsed = acceptSchema.safeParse({
    token: rawToken.data,
    name: formData.get('name'),
    password: formData.get('password'),
  });
  if (!parsed.success) {
    return fail(CHECK_FIELDS, fieldErrorsFrom(parsed.error.issues));
  }

  // ~250 ms of CPU. Done BEFORE the token is spent, so a failure here leaves the
  // invitation usable.
  const passwordHash = await hashPassword(parsed.data.password);

  const spent = await consumeToken(rawToken.data, EmailTokenPurpose.INVITE);
  if (!spent) return fail(INVALID_LINK);

  let userId: string;
  try {
    // `emailVerified` is set on creation: clicking a link sent to the address is
    // the same proof a verification mail asks for, so an invitee never sees a
    // second confirmation step.
    //
    // No `isRegistrationOpen()` check -- see the file header.
    const created = await prisma.user.create({
      data: {
        name: parsed.data.name,
        email: payload.email,
        passwordHash,
        emailVerified: new Date(),
      },
      select: { id: true },
    });
    userId = created.id;
  } catch (e) {
    if (!isUniqueViolation(e)) throw e;

    // The address registered independently between the check above and this
    // insert. The token is already spent, so the grant must not be dropped on
    // the floor: hand the membership to the account that now owns the address
    // and send them to sign in. Their own password stands; nothing here touches it.
    const raced = await prisma.user.findUnique({
      where: { email: payload.email },
      select: { id: true },
    });
    if (raced) await grantMembership(raced.id, org.id, payload.role);
    return fail(SIGN_IN_FIRST);
  }

  await grantMembership(userId, org.id, payload.role);

  // A stale cookie may still be attached even though this branch is signed out.
  await rotatePresentedSession();

  const { token, expiresAt } = await createSession(userId);
  await setSessionCookie(token, expiresAt);

  revalidatePath('/', 'layout');
  return { ...ok(), slug: org.slug };
}

export async function acceptInvitation(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  let outcome: ActionResult & { slug?: string };

  try {
    outcome = await attemptAccept(formData);
  } catch (e) {
    if (isNextControlFlowError(e)) throw e;
    console.error(`[acceptInvitation] unexpected_failure ref=${randomUUID().slice(0, 8)}`);
    return fail(ERRORS.UNEXPECTED);
  }

  // Success path only, after the try/catch closes (SPEC 6.1 rule 7).
  if (outcome.ok && outcome.slug) redirect(`/orgs/${outcome.slug}`);
  return outcome;
}
