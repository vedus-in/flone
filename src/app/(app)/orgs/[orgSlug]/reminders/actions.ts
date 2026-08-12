'use server';

/**
 * Reminder Server Actions.
 *
 * Design: docs/superpowers/specs/2026-08-11-reminders-design.md
 *
 * The universal rules hold unchanged: the literal first statement is
 * `await requireUser()` (inside `requireOrgBySlug`), every input is re-parsed
 * with zod, and every client-supplied id is proved to belong to the
 * already-authorized organization before it is stored.
 *
 * Two ids arrive from the form and both are dangerous on their own:
 *
 *   - `scope` may name a project. `requireProjectInOrg` proves it is a project
 *     of THIS organization, so a forged id cannot attach a reminder to another
 *     tenant's project -- and cannot be used to probe whether one exists.
 *   - `recipientId` names the person who will receive mail. `assertOrgMember`
 *     is the same guard issue assignment uses, so this cannot be turned into a
 *     way to send mail to an arbitrary account.
 */

import { revalidatePath } from 'next/cache';
import { Role } from '@prisma/client';
import { z } from 'zod';

import {
  assertOrgMember,
  atLeast,
  remindersPath,
  requireOrgBySlug,
  requireProjectInOrg,
  runAction,
} from '@/lib/authz';
import { prisma } from '@/lib/db';
import { INVALID_INPUT, field, fieldErrorsOf, fieldList } from '@/lib/action-input';
import { fail, ok, type ActionResult } from '@/lib/result';
import { toInstant } from '@/lib/reminder-math';
import {
  cuid,
  localDateTimeSchema,
  reminderRepeatSchema,
  reminderTitleSchema,
  slugSchema,
  tzOffsetSchema,
} from '@/lib/validation';

/** The scope selector's value when the reminder is about the whole organization. */
const ORG_SCOPE = 'ORG';

const IN_THE_PAST = 'Pick a time in the future.';

const NOT_YOURS = 'You can only delete reminders you set or receive.';

/**
 * A minute of slack. The form submits a whole minute, so a reminder set for
 * 09:00 at 09:00:30 is the user agreeing with themselves, not a mistake.
 */
const PAST_SLACK_MS = 60_000;

const NO_RECIPIENT = 'Choose at least one person to remind.';

/**
 * Bounded so one submit cannot fan out to an unbounded number of rows. Every
 * candidate has to be a member of the organization anyway, so this is a sanity
 * cap rather than a security control.
 */
const MAX_RECIPIENTS = 50;

const createSchema = z.object({
  orgSlug: slugSchema,
  title: reminderTitleSchema,
  runAt: localDateTimeSchema,
  tzOffsetMinutes: tzOffsetSchema,
  repeat: reminderRepeatSchema,
  scope: z.union([z.literal(ORG_SCOPE), cuid]),
  /**
   * ONE REMINDER PER PERSON, not one reminder with many recipients.
   *
   * A row is what the scheduler claims, and it claims with a compare-and-swap
   * on `nextRunAt`. Sharing a row between recipients would mean one claim
   * covering N sends: a process killed halfway through the loop has already
   * advanced the schedule, so everyone after the failure silently loses that
   * occurrence. Per-person rows give per-person delivery, and they also settle
   * what deleting means -- removing yourself from a reminder cannot cancel it
   * for the rest of the team, because it was never their row.
   */
  recipientIds: z.array(cuid).min(1, NO_RECIPIENT).max(MAX_RECIPIENTS),
});

/* -------------------------------------------------------------------------- */
/* createReminder                                                              */
/* -------------------------------------------------------------------------- */

export async function createReminder(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  return runAction(async () => {
    const parsed = createSchema.safeParse({
      orgSlug: field(formData, 'orgSlug'),
      title: field(formData, 'title'),
      runAt: field(formData, 'runAt'),
      tzOffsetMinutes: field(formData, 'tzOffsetMinutes'),
      repeat: field(formData, 'repeat'),
      scope: field(formData, 'scope'),
      // Unchecked boxes submit nothing, so an empty list is the ordinary way to
      // get this wrong -- it earns a sentence rather than the generic message.
      recipientIds: [...new Set(fieldList(formData, 'recipientIds'))],
    });
    if (!parsed.success) {
      const fieldErrors = fieldErrorsOf(parsed.error);
      if (fieldErrors.recipientIds) return fail(NO_RECIPIENT, fieldErrors);
      return fail(INVALID_INPUT, fieldErrors);
    }
    const input = parsed.data;

    const ctx = await requireOrgBySlug(input.orgSlug);

    // Every member may schedule a reminder, for themselves or for a colleague:
    // it is a nudge, not access to anything. The only thing role-gated here is
    // deleting somebody else's, below. Checked one at a time rather than with a
    // count, so a forged id is NOT_FOUND rather than silently dropped.
    for (const recipientId of input.recipientIds) {
      await assertOrgMember(ctx.org.id, recipientId);
    }

    const project =
      input.scope === ORG_SCOPE ? null : await requireProjectInOrg(ctx.org.id, input.scope);

    // `localDateTimeSchema` already proved this parses; the null branch is for
    // the type checker, not for a reachable input.
    const runAt = toInstant(input.runAt, input.tzOffsetMinutes);
    if (!runAt) return fail(INVALID_INPUT, { runAt: 'That is not a real date and time.' });

    // A first send in the past would go out on the very next tick, which reads
    // as a bug however it was meant. Recurring reminders are advanced from here
    // by whole periods, so this also keeps every later occurrence honest.
    if (runAt.getTime() < Date.now() - PAST_SLACK_MS) {
      return fail(IN_THE_PAST, { runAt: IN_THE_PAST });
    }

    await prisma.reminder.createMany({
      data: input.recipientIds.map((recipientId) => ({
        organizationId: ctx.org.id,
        projectId: project?.id ?? null,
        title: input.title,
        repeat: input.repeat,
        nextRunAt: runAt,
        tzOffsetMinutes: input.tzOffsetMinutes,
        recipientId,
        createdById: ctx.user.id,
      })),
    });

    revalidatePath(remindersPath(ctx.org));

    const count = input.recipientIds.length;
    if (count === 1) {
      return ok(
        input.recipientIds[0] === ctx.user.id
          ? 'Reminder scheduled.'
          : 'Reminder scheduled. They will get an email when it is due.',
      );
    }
    return ok(`Reminder scheduled for ${count} people.`);
  });
}

/* -------------------------------------------------------------------------- */
/* deleteReminder                                                              */
/* -------------------------------------------------------------------------- */

const deleteSchema = z.object({ orgSlug: slugSchema, reminderId: cuid });

/**
 * The off switch. There is no edit: a reminder is four fields, and rescheduling
 * one by deleting and re-adding cannot leave a half-changed row behind for the
 * scheduler to find.
 *
 * Three people may delete one: whoever created it, whoever RECEIVES it, and any
 * admin. The recipient matters -- without them, a colleague could schedule a
 * daily email you had no way to stop.
 */
export async function deleteReminder(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  return runAction(async () => {
    const parsed = deleteSchema.safeParse({
      orgSlug: field(formData, 'orgSlug'),
      reminderId: field(formData, 'reminderId'),
    });
    if (!parsed.success) return fail(INVALID_INPUT, fieldErrorsOf(parsed.error));

    const ctx = await requireOrgBySlug(parsed.data.orgSlug);

    // Scoped to the organization the caller was just authorized for, so an id
    // from another tenant is simply not found.
    const reminder = await prisma.reminder.findFirst({
      where: { id: parsed.data.reminderId, organizationId: ctx.org.id },
      select: { id: true, createdById: true, recipientId: true },
    });
    if (!reminder) return fail(INVALID_INPUT);

    const involved =
      reminder.createdById === ctx.user.id || reminder.recipientId === ctx.user.id;
    if (!involved && !atLeast(ctx.role, Role.ADMIN)) return fail(NOT_YOURS);

    await prisma.reminder.deleteMany({ where: { id: reminder.id, organizationId: ctx.org.id } });

    revalidatePath(remindersPath(ctx.org));
    return ok();
  });
}
