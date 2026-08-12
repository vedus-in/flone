'use server';

/**
 * `/account` -- per-type email notification preferences.
 *
 * Design: docs/superpowers/specs/2026-08-06-email-design.md
 *
 * These gate NOTIFICATIONS only. Security mail -- "your password was changed",
 * "a new MCP access token was created" -- ignores every switch here, because a
 * user who muted notifications has not consented to silent account takeover.
 *
 * The write is scoped by the session's own user id, so this action can only ever
 * change the caller's own row; there is no id in the form to forge.
 */

import { createHash, randomInt } from 'node:crypto';
import { revalidatePath } from 'next/cache';
import { z } from 'zod';

import { requireUser, runAction } from '@/lib/authz';
import { prisma } from '@/lib/db';
import { INVALID_INPUT, field, fieldErrorsOf } from '@/lib/action-input';
import { fail, ok, type ActionResult } from '@/lib/result';
import { speechForCode } from '@/lib/reminder-math';
import { e164Schema, phoneCodeSchema } from '@/lib/validation';
import { REMINDER_VOICE, placeCall } from '@/lib/voice';

/**
 * An unchecked checkbox submits NOTHING, so absence is the meaningful value and
 * every field defaults to `false`. Reading `=== 'on'` rather than "is present"
 * keeps a crafted `notifyAssigned=maybe` from being truthy.
 */
const preferencesSchema = z.object({
  notifyAssigned: z.literal('on').optional(),
  notifyComments: z.literal('on').optional(),
  notifyOrgMembership: z.literal('on').optional(),
});

export async function updateNotificationPreferences(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  return runAction(async () => {
    const user = await requireUser();

    const parsed = preferencesSchema.safeParse({
      notifyAssigned: formData.get('notifyAssigned') ?? undefined,
      notifyComments: formData.get('notifyComments') ?? undefined,
      notifyOrgMembership: formData.get('notifyOrgMembership') ?? undefined,
    });

    // Nothing here can fail in a way worth reporting: an unparseable value is
    // an unchecked box.
    const values = parsed.success ? parsed.data : {};

    await prisma.user.updateMany({
      where: { id: user.id },
      data: {
        notifyAssigned: values.notifyAssigned === 'on',
        notifyComments: values.notifyComments === 'on',
        notifyOrgMembership: values.notifyOrgMembership === 'on',
      },
    });

    revalidatePath('/account');
    return ok('Preferences saved.');
  });
}

/* -------------------------------------------------------------------------- */
/* Phone                                                                       */
/*                                                                             */
/* Design: docs/superpowers/specs/2026-08-12-reminder-calls-design.md          */
/*                                                                             */
/* A NUMBER IS SET ONLY BY ITS OWNER AND ONLY EVER ON THIS PAGE. Every write    */
/* below is scoped to `user.id` from the session, so there is no id in any of   */
/* these forms to forge. That is the first half of what keeps reminder calls    */
/* from being a robocall vector; `phoneVerified` is the second, because any     */
/* member may schedule a daily reminder for themselves and would otherwise be   */
/* able to point one at a stranger's handset.                                   */
/* -------------------------------------------------------------------------- */

/**
 * Ten minutes. Long enough to walk to the phone that just rang, short enough
 * that an abandoned attempt is not still guessable at the end of the day.
 */
const CODE_TTL_MS = 10 * 60 * 1000;

/** Never exported: the hash must not appear on any object outside this file. */
const hashCode = (code: string) => createHash('sha256').update(code, 'utf8').digest('hex');

/**
 * `randomInt`, not `randomBytes(4) % 1_000_000`. The modulo is biased -- 2^32 is
 * not a multiple of a million, so the low codes come up slightly more often --
 * and `randomInt` rejects-and-retries to stay uniform. Six digits is a small
 * enough space that shaving bits off it actually matters.
 */
const mintCode = () => String(randomInt(0, 1_000_000)).padStart(6, '0');

const CALL_FAILED =
  'Could not place the call. Check the number is right and try again in a moment.';

/* -------------------------------------------------------------------------- */

/**
 * Stores the number UNVERIFIED and phones it with a code.
 *
 * Saving a number always clears `phoneVerified`: changing your handset must not
 * inherit the previous one's confirmation, or the check is a formality anyone
 * can walk past by verifying a number they own and then editing the field.
 */
export async function requestPhoneCode(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  return runAction(async () => {
    const session = await requireUser();

    const parsed = z.object({ phone: e164Schema }).safeParse({
      phone: field(formData, 'phone'),
    });
    if (!parsed.success) return fail(INVALID_INPUT, fieldErrorsOf(parsed.error));

    const code = mintCode();

    await prisma.user.updateMany({
      where: { id: session.id },
      data: {
        phone: parsed.data.phone,
        phoneVerified: null,
        phoneCodeHash: hashCode(code),
        phoneCodeExpiresAt: new Date(Date.now() + CODE_TTL_MS),
      },
    });

    // The number is saved BEFORE the call is attempted, so a provider outage
    // leaves the field populated and the page showing "not confirmed" rather
    // than throwing away what the user typed.
    const placed = await placeCall({
      to: parsed.data.phone,
      say: speechForCode(code),
      voice: REMINDER_VOICE,
    });

    revalidatePath('/account');
    if (!placed) return fail(CALL_FAILED);

    return ok('Calling you now. Enter the six digits you hear.');
  });
}

/**
 * Spends the one guess.
 *
 * THE CODE IS BURNED ON EVERY ATTEMPT, right or wrong. That single rule is what
 * makes six digits sufficient with no attempt counter and no rate limiter: a
 * wrong answer costs the attacker a whole new phone call to the real handset,
 * which is both a one-in-a-million retry and an alarm ringing in the victim's
 * pocket.
 *
 * The success path is ONE statement. A read-then-write would let two concurrent
 * submissions both observe a valid code, and more importantly would leave a
 * window in which the code is spent but the number is not yet confirmed.
 */
export async function verifyPhoneCode(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  return runAction(async () => {
    const session = await requireUser();

    const parsed = z.object({ code: phoneCodeSchema }).safeParse({
      code: field(formData, 'code'),
    });
    // A malformed code still burns nothing: it never reached the comparison, so
    // treating it as a spent guess would let a stray keystroke cost a call.
    if (!parsed.success) return fail(INVALID_INPUT, fieldErrorsOf(parsed.error));

    const now = new Date();

    const { count } = await prisma.user.updateMany({
      where: {
        id: session.id,
        phoneCodeHash: hashCode(parsed.data.code),
        phoneCodeExpiresAt: { gt: now },
      },
      data: { phoneVerified: now, phoneCodeHash: null, phoneCodeExpiresAt: null },
    });

    revalidatePath('/account');
    if (count === 1) return ok('Phone number confirmed. Reminders can call you now.');

    // Wrong, expired, or already spent -- one answer for all three, so nothing
    // here distinguishes "no code outstanding" from "wrong digits".
    await prisma.user.updateMany({
      where: { id: session.id },
      data: { phoneCodeHash: null, phoneCodeExpiresAt: null },
    });
    return fail('That code is not right. Ask for a new call and try again.', {
      code: 'That code is not right.',
    });
  });
}

/**
 * Removes the number.
 *
 * Reminders already scheduled to CALL this person are left alone rather than
 * deleted or rewritten: they keep showing on the reminders page with the same
 * "nothing will be delivered" warning an unconfirmed email address gets. Silently
 * converting somebody's call reminders to email would be a worse surprise than
 * a visible warning, and deleting them would destroy work the user did not ask
 * to lose.
 */
export async function removePhone(
  _prev: ActionResult | null,
  _formData: FormData,
): Promise<ActionResult> {
  return runAction(async () => {
    const session = await requireUser();

    await prisma.user.updateMany({
      where: { id: session.id },
      data: { phone: null, phoneVerified: null, phoneCodeHash: null, phoneCodeExpiresAt: null },
    });

    revalidatePath('/account');
    return ok('Phone number removed.');
  });
}
