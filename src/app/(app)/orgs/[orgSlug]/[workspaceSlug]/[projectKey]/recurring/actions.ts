'use server';

/**
 * Recurring ticket Server Actions, at PROJECT scope.
 *
 * Design: docs/superpowers/specs/2026-08-16-recurring-tickets-design.md, §8-§9.
 *
 * The universal rules hold unchanged (SPEC 6.1): the literal first statement is
 * `await requireUser()`, every input is re-parsed with zod using the shared
 * schemas, and every client-supplied id is proved to belong to the
 * already-authorized project before it is written:
 *
 *   - the template, by a `findFirst` carrying `projectId` from the upward walk,
 *     so an id from another tenant is not found rather than refused -- there is
 *     no existence oracle here either;
 *   - `assigneeId`, by the same `isOrgMember` rejection `createIssue` uses, so
 *     a template cannot be pointed at an account outside the organization and
 *     then mail it on a cadence;
 *   - `labelIds`, by `filterLabelsInProject`, capped at 20 as on `createIssue`.
 *
 * Authorization mirrors the TICKET, not the project settings (design §9): any
 * member may see, create, edit, pause and resume, because automating what they
 * could already do by hand is not an escalation. Deleting is the creator,
 * ADMIN or OWNER -- the same rule as deleting a ticket, and for the same
 * reason: a member must not be able to destroy someone else's accumulated
 * checklist.
 */

import { revalidatePath } from 'next/cache';
import { Priority, Role, TicketRepeat } from '@prisma/client';
import { z } from 'zod';

import {
  atLeast,
  canSeeProject,
  filterLabelsInProject,
  recurringPath,
  requireProjectByKeyInOrg,
  requireUser,
  runAction,
} from '@/lib/authz';
import { prisma } from '@/lib/db';
import { INVALID_INPUT, field, fieldErrorsOf, fieldList } from '@/lib/action-input';
import { fail, ok, type ActionResult } from '@/lib/result';
import { nextOccurrence, rollToWeekday, toInstant } from '@/lib/reminder-math';
import {
  cuid,
  localDateTimeSchema,
  projectKeySchema,
  recurringTitleSchema,
  slugSchema,
  ticketDescriptionSchema,
  ticketRepeatSchema,
  tzOffsetSchema,
} from '@/lib/validation';

const NOT_A_MEMBER = 'That person cannot be assigned work in this project.';

const NOT_YOURS = 'Only the person who set this up, or an admin, can delete it.';

const IN_THE_PAST = 'Pick a time in the future.';

/**
 * A minute of slack, the same one `createReminder` allows and the same message.
 * The form submits a whole minute, so a first ticket set for 09:00 at 09:00:30
 * is the user agreeing with themselves, not a mistake.
 */
const PAST_SLACK_MS = 60_000;

/**
 * Non-throwing "may this person be given work here?".
 *
 * Scoped to the PROJECT, not the organization: on a private project the people
 * who may hold an issue are the ones who can open it, and putting somebody
 * else's name in the assignee column would both hand them nothing and tell
 * everyone the project exists. `canSeeProject` is the same predicate every
 * loader runs, asked about the candidate instead of the caller.
 *
 * Non-throwing because `assertOrgMember` answers with NOT_FOUND, which is right
 * when the caller should not learn whether the account exists. Here the caller
 * is already inside the organization and picked a name from a list, so a plain
 * rejection reads better than a 404 -- and the project id still comes from the
 * upward walk.
 */
async function isOrgMember(projectId: string, userId: string): Promise<boolean> {
  return canSeeProject(projectId, userId);
}

/**
 * The first occurrence, from the wall clock the form submitted.
 *
 * WEEKDAYS is rolled forward here as well as inside `nextOccurrence`, using the
 * same function: a template whose first run was picked on a Saturday would
 * otherwise store a Saturday anchor, spawn nothing that day, and look broken
 * until Monday. Rolling at creation makes the row say what it will do.
 *
 * The past check runs BEFORE the roll on purpose. Checking after it would let a
 * first run picked last Saturday be silently accepted as "next Monday", which
 * is not the date anyone typed.
 */
function anchorFor(
  runAt: string,
  tzOffsetMinutes: number,
  repeat: TicketRepeat,
): { anchor: Date } | { error: ActionResult } {
  // `localDateTimeSchema` already proved this parses; the null branch is for
  // the type checker, not for a reachable input.
  const instant = toInstant(runAt, tzOffsetMinutes);
  if (!instant) return { error: fail(INVALID_INPUT, { runAt: 'That is not a real date and time.' }) };

  // A first run in the past would spawn on the very next tick, which reads as a
  // bug however it was meant -- and every later occurrence is computed from
  // this anchor, so it would stay wrong.
  if (instant.getTime() < Date.now() - PAST_SLACK_MS) {
    return { error: fail(IN_THE_PAST, { runAt: IN_THE_PAST }) };
  }

  return {
    anchor: repeat === TicketRepeat.WEEKDAYS ? rollToWeekday(instant, tzOffsetMinutes) : instant,
  };
}

/* -------------------------------------------------------------------------- */
/* createRecurringTicket                                                       */
/* -------------------------------------------------------------------------- */

const createSchema = z.object({
  orgSlug: slugSchema,
  projectKey: projectKeySchema,
  title: recurringTitleSchema,
  description: ticketDescriptionSchema,
  priority: z.nativeEnum(Priority).default(Priority.NONE),
  /** The empty string means "nobody", which is a legal template. */
  assigneeId: z.union([cuid, z.literal('')]).default(''),
  repeat: ticketRepeatSchema,
  runAt: localDateTimeSchema,
  tzOffsetMinutes: tzOffsetSchema,
  labelIds: z.array(cuid).max(20).default([]),
});

export async function createRecurringTicket(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  return runAction(async () => {
    const user = await requireUser();

    const parsed = createSchema.safeParse({
      orgSlug: field(formData, 'orgSlug'),
      projectKey: field(formData, 'projectKey'),
      title: field(formData, 'title'),
      description: field(formData, 'description'),
      priority: field(formData, 'priority') || undefined,
      assigneeId: field(formData, 'assigneeId'),
      repeat: field(formData, 'repeat'),
      runAt: field(formData, 'runAt'),
      tzOffsetMinutes: field(formData, 'tzOffsetMinutes'),
      labelIds: [...new Set(fieldList(formData, 'labelIds'))],
    });
    if (!parsed.success) return fail(INVALID_INPUT, fieldErrorsOf(parsed.error));
    const input = parsed.data;

    // Walks project -> workspace -> organization -> membership in one query.
    // Any role may create: these are tickets the same person could file by hand.
    const ctx = await requireProjectByKeyInOrg(input.orgSlug, input.projectKey);

    if (input.assigneeId !== '' && !(await isOrgMember(ctx.project.id, input.assigneeId))) {
      return fail(NOT_A_MEMBER);
    }
    const labelIds = await filterLabelsInProject(ctx.project.id, input.labelIds);

    const anchored = anchorFor(input.runAt, input.tzOffsetMinutes, input.repeat);
    if ('error' in anchored) return anchored.error;

    await prisma.recurringTicket.create({
      data: {
        projectId: ctx.project.id,
        title: input.title,
        description: input.description.length > 0 ? input.description : null,
        priority: input.priority,
        assigneeId: input.assigneeId === '' ? null : input.assigneeId,
        repeat: input.repeat,
        anchorAt: anchored.anchor,
        // The FIRST occurrence is the anchor itself, not `nextOccurrence` of
        // it: that function answers what comes after an occurrence that has
        // already fired, so seeding with it would skip the first ticket.
        nextRunAt: anchored.anchor,
        tzOffsetMinutes: input.tzOffsetMinutes,
        // Identity comes from the session. Never from the form.
        createdById: user.id,
        ...(labelIds.length > 0 ? { labels: { connect: labelIds.map((id) => ({ id })) } } : {}),
      },
    });

    revalidatePath(recurringPath(ctx.org, ctx.project));
    return ok('Recurring ticket scheduled.');
  });
}

/* -------------------------------------------------------------------------- */
/* updateRecurringTicket                                                       */
/*                                                                             */
/* CONTENT vs SCHEDULE -- why this takes a discriminant.                        */
/*                                                                             */
/* One action, two closed shapes, chosen by a hidden `part` field, and the zod  */
/* union is what enforces the split: a CONTENT submit carries no `runAt` to     */
/* parse and a SCHEDULE submit carries no `title`, so neither branch is even    */
/* ABLE to half-write the other's columns. The scheduler reads `anchorAt`,      */
/* `repeat`, `tzOffsetMinutes` and `nextRunAt` together; a row where those four */
/* disagree spawns at a time nobody picked, and the tick has no way to notice.  */
/*                                                                             */
/* The design doc (§8) says "one edit form, full replace". It cannot be one     */
/* form. `anchorAt` is a time in the PAST for every template that has spawned   */
/* even once, so a full replace would have to re-submit it and the              */
/* first-run-in-the-past guard would then reject every description edit -- i.e. */
/* exactly the edit the feature exists for. Two forms in one panel is the       */
/* smallest thing that keeps the guard and keeps the living checklist editable. */
/* -------------------------------------------------------------------------- */

const CONTENT = 'CONTENT';
const SCHEDULE = 'SCHEDULE';

const scopeFields = { orgSlug: slugSchema, projectKey: projectKeySchema, recurringTicketId: cuid };

const updateSchema = z.discriminatedUnion('part', [
  z.object({
    part: z.literal(CONTENT),
    ...scopeFields,
    title: recurringTitleSchema,
    description: ticketDescriptionSchema,
    priority: z.nativeEnum(Priority).default(Priority.NONE),
    assigneeId: z.union([cuid, z.literal('')]).default(''),
    labelIds: z.array(cuid).max(20).default([]),
  }),
  z.object({
    part: z.literal(SCHEDULE),
    ...scopeFields,
    repeat: ticketRepeatSchema,
    runAt: localDateTimeSchema,
    tzOffsetMinutes: tzOffsetSchema,
  }),
]);

export async function updateRecurringTicket(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  return runAction(async () => {
    await requireUser();

    // Both shapes are read out of the one FormData; the discriminant decides
    // which one is parsed, and zod strips whatever the other branch would have
    // wanted. A CONTENT form simply does not render the schedule controls, so
    // those keys arrive empty and are discarded.
    const parsed = updateSchema.safeParse({
      part: field(formData, 'part'),
      orgSlug: field(formData, 'orgSlug'),
      projectKey: field(formData, 'projectKey'),
      recurringTicketId: field(formData, 'recurringTicketId'),
      title: field(formData, 'title'),
      description: field(formData, 'description'),
      priority: field(formData, 'priority') || undefined,
      assigneeId: field(formData, 'assigneeId'),
      labelIds: [...new Set(fieldList(formData, 'labelIds'))],
      repeat: field(formData, 'repeat'),
      runAt: field(formData, 'runAt'),
      tzOffsetMinutes: field(formData, 'tzOffsetMinutes'),
    });
    if (!parsed.success) return fail(INVALID_INPUT, fieldErrorsOf(parsed.error));
    const input = parsed.data;

    // Any member may edit, exactly as any member may edit a ticket -- and it is
    // the assignee's escape hatch when a template is filling their board.
    const ctx = await requireProjectByKeyInOrg(input.orgSlug, input.projectKey);
    // Scoped to the project the caller was just authorized for, so an id from
    // another tenant produces the same null a forged one does -- one query, no
    // existence oracle.
    const template = await prisma.recurringTicket.findFirst({
      where: { id: input.recurringTicketId, projectId: ctx.project.id },
      select: { id: true, nextRunAt: true },
    });
    if (!template) return fail(INVALID_INPUT);

    if (input.part === CONTENT) {
      if (input.assigneeId !== '' && !(await isOrgMember(ctx.project.id, input.assigneeId))) {
        return fail(NOT_A_MEMBER);
      }
      const labelIds = await filterLabelsInProject(ctx.project.id, input.labelIds);

      await prisma.recurringTicket.update({
        where: { id: template.id },
        data: {
          title: input.title,
          description: input.description.length > 0 ? input.description : null,
          priority: input.priority,
          assigneeId: input.assigneeId === '' ? null : input.assigneeId,
          // `set` replaces the whole relation, so a label unticked here is
          // detached rather than silently left on.
          labels: { set: labelIds.map((id) => ({ id })) },
        },
      });

      revalidatePath(recurringPath(ctx.org, ctx.project));
      return ok('Recurring ticket updated.');
    }

    const anchored = anchorFor(input.runAt, input.tzOffsetMinutes, input.repeat);
    if ('error' in anchored) return anchored.error;

    await prisma.recurringTicket.update({
      where: { id: template.id },
      data: {
        repeat: input.repeat,
        anchorAt: anchored.anchor,
        tzOffsetMinutes: input.tzOffsetMinutes,
        // A PAUSED template stays paused. Pause is the off switch, and
        // rescheduling one must not turn it back on behind the person who
        // stopped it -- Resume is the only thing that does that.
        nextRunAt: template.nextRunAt === null ? null : anchored.anchor,
      },
    });

    revalidatePath(recurringPath(ctx.org, ctx.project));
    return ok('Schedule updated.');
  });
}

/* -------------------------------------------------------------------------- */
/* setRecurringTicketPaused                                                    */
/* -------------------------------------------------------------------------- */

const pauseSchema = z.object({
  ...scopeFields,
  /**
   * One action with a boolean rather than two, because pausing and resuming are
   * the same write to the same column -- `nextRunAt` -- and two actions would
   * be two chances for one of them to also touch the anchor.
   */
  paused: z.enum(['true', 'false']),
});

export async function setRecurringTicketPaused(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  return runAction(async () => {
    await requireUser();

    const parsed = pauseSchema.safeParse({
      orgSlug: field(formData, 'orgSlug'),
      projectKey: field(formData, 'projectKey'),
      recurringTicketId: field(formData, 'recurringTicketId'),
      paused: field(formData, 'paused'),
    });
    if (!parsed.success) return fail(INVALID_INPUT, fieldErrorsOf(parsed.error));

    // Any member, same as editing. A template nobody can stop is worse than one
    // anybody can restart.
    const ctx = await requireProjectByKeyInOrg(parsed.data.orgSlug, parsed.data.projectKey);
    const template = await prisma.recurringTicket.findFirst({
      where: { id: parsed.data.recurringTicketId, projectId: ctx.project.id },
      select: { id: true, anchorAt: true, repeat: true, tzOffsetMinutes: true },
    });
    if (!template) return fail(INVALID_INPUT);

    const paused = parsed.data.paused === 'true';

    // Pause is `nextRunAt = null` and NOTHING else, so the accumulated
    // description, the labels and the anchor all survive it -- a strategy
    // pulled from deployment keeps its refined checklist for the day it comes
    // back, which is the whole reason this is not a delete.
    //
    // Resume recomputes from the ANCHOR against now, which `nextOccurrence`
    // guarantees is strictly in the future. Restoring the stored anchor
    // directly would make a template paused for a month spawn on the very next
    // tick, and a monthly one spawn a ticket dated last month.
    const nextRunAt = paused
      ? null
      : nextOccurrence(template.anchorAt, template.repeat, new Date(), template.tzOffsetMinutes);

    await prisma.recurringTicket.update({
      where: { id: template.id },
      data: { nextRunAt },
    });

    revalidatePath(recurringPath(ctx.org, ctx.project));
    return ok(paused ? 'Paused. No more tickets until you resume it.' : 'Resumed.');
  });
}

/* -------------------------------------------------------------------------- */
/* deleteRecurringTicket                                                       */
/* -------------------------------------------------------------------------- */

const deleteSchema = z.object(scopeFields);

/**
 * The only irreversible one, and the only role-gated one.
 *
 * Creator, ADMIN or OWNER -- the same rule as deleting a ticket. A template's
 * description is accumulated process, so a member deleting a colleague's is
 * destroying work, not tidying up. Pause is what everyone else has.
 */
export async function deleteRecurringTicket(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  return runAction(async () => {
    await requireUser();

    const parsed = deleteSchema.safeParse({
      orgSlug: field(formData, 'orgSlug'),
      projectKey: field(formData, 'projectKey'),
      recurringTicketId: field(formData, 'recurringTicketId'),
    });
    if (!parsed.success) return fail(INVALID_INPUT, fieldErrorsOf(parsed.error));

    const ctx = await requireProjectByKeyInOrg(parsed.data.orgSlug, parsed.data.projectKey);
    const template = await prisma.recurringTicket.findFirst({
      where: { id: parsed.data.recurringTicketId, projectId: ctx.project.id },
      select: { id: true, createdById: true },
    });
    if (!template) return fail(INVALID_INPUT);

    if (template.createdById !== ctx.user.id && !atLeast(ctx.role, Role.ADMIN)) {
      return fail(NOT_YOURS);
    }

    // Scoped to the authorized project as well as the id, exactly as
    // `deleteReminder` scopes to the organization: the guard above proved the
    // row, and this makes the WRITE itself unable to reach outside it.
    //
    // Tickets already spawned are untouched -- they are ordinary tickets with
    // no link back, which is what makes deleting a template safe.
    await prisma.recurringTicket.deleteMany({
      where: { id: template.id, projectId: ctx.project.id },
    });

    revalidatePath(recurringPath(ctx.org, ctx.project));
    return ok();
  });
}
