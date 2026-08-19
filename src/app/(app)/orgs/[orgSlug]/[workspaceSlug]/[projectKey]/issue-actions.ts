'use server';

/**
 * Issue Server Actions, at PROJECT scope.
 *
 * The successor to the old board-scoped `[boardId]/actions.ts`. Everything the
 * board used to own -- create, move, assign, delete -- moved up a level, because
 * an issue no longer belongs to a board and may have none at all.
 *
 * Universal rules, unchanged from SPEC 6.1:
 *   1. The literal first statement is `await requireUser()`.
 *   2. Input is re-parsed with zod, without exception.
 *   3. Resources resolve only through a `require*` helper, which walks UP from
 *      the leaf id to the Organization inside a single `where` clause.
 *   4. `Ticket.stateId`, `.boardId`, `.cycleId`, `.parentId` and the label set
 *      are NEVER written without the matching `require*InProject` guard first --
 *      the successor to `requireColumnInBoard`, and for the same reason: a
 *      forged id must not be able to reach across a tenant boundary.
 *   5. `revalidatePath` is given concrete paths built from the upward walk.
 */

import { Prisma, Priority } from '@prisma/client';
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { z } from 'zod';

import {
  boardPath,
  canSeeProject,
  filterLabelsInProject,
  issuesPath,
  projectPath,
  requireAuthorOrRole,
  requireBoardInProject,
  requireCycleInProject,
  requireParentInProject,
  requireProject,
  requireStateInProject,
  requireTicket,
  requireUser,
  runAction,
  ticketPath,
  ticketSurfaces,
  type ProjectCtx,
  type StateRef,
  type TicketCtx,
} from '@/lib/authz';
import { deleteObject } from '@/lib/bucket';
import { prisma } from '@/lib/db';
import { appUrl } from '@/lib/email';
import { notifyIssueAssigned, type IssueContext } from '@/lib/mailer';
import { stampsFor } from '@/lib/model';
import { fail, ok, type ActionResult } from '@/lib/result';
import { insertTicket, nextPosition } from '@/lib/ticket-insert';
import { INVALID_INPUT, field, fieldErrorsOf, fieldList } from '@/lib/action-input';
import {
  TICKET_ORDER,
  cuid,
  isoDateSchema,
  ticketDescriptionSchema,
  ticketTitleSchema,
} from '@/lib/validation';

const NOT_A_MEMBER = 'That person cannot be assigned work in this project.';

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

/* -------------------------------------------------------------------------- */
/* Shared helpers                                                              */
/* -------------------------------------------------------------------------- */

/** Every surface the issue appears on, plus the project's issue list. */
function revalidateIssue(ctx: TicketCtx, extra: string[] = []): void {
  for (const path of [...ticketSurfaces(ctx), ...extra]) revalidatePath(path);
}

/**
 * What an email needs to name an issue. Built from the already-authorized
 * context, so nothing here is a second read and nothing is client-supplied.
 *
 * `number` and `title` are passed rather than read off `ctx.ticket` because
 * `createIssue` has neither until its transaction returns -- it holds a
 * `ProjectCtx`, not a `TicketCtx`. One builder either way keeps the link
 * construction in a single place.
 */
function issueContext(ctx: ProjectCtx, number: number, title: string): IssueContext {
  return {
    issueKey: `${ctx.project.key}-${number}`,
    issueTitle: title,
    projectName: ctx.project.name,
    url: appUrl(ticketPath(ctx.org, ctx.project, number)),
  };
}

/* -------------------------------------------------------------------------- */
/* createIssue                                                                 */
/* -------------------------------------------------------------------------- */

const createIssueSchema = z.object({
  projectId: cuid,
  stateId: cuid,
  title: ticketTitleSchema,
  description: ticketDescriptionSchema,
  priority: z.nativeEnum(Priority).default(Priority.NONE),
  /** The empty string means "none" for each of these. */
  assigneeId: z.union([cuid, z.literal('')]).default(''),
  boardId: z.union([cuid, z.literal('')]).default(''),
  cycleId: z.union([cuid, z.literal('')]).default(''),
  parentId: z.union([cuid, z.literal('')]).default(''),
  labelIds: z.array(cuid).max(20).default([]),
});

export async function createIssue(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  return runAction(async () => {
    const user = await requireUser();

    const parsed = createIssueSchema.safeParse({
      projectId: field(formData, 'projectId'),
      stateId: field(formData, 'stateId'),
      title: field(formData, 'title'),
      description: field(formData, 'description'),
      priority: field(formData, 'priority') || undefined,
      assigneeId: field(formData, 'assigneeId'),
      boardId: field(formData, 'boardId'),
      cycleId: field(formData, 'cycleId'),
      parentId: field(formData, 'parentId'),
      labelIds: fieldList(formData, 'labelIds'),
    });
    if (!parsed.success) return fail(INVALID_INPUT, fieldErrorsOf(parsed.error));

    // Walks project -> organization -> membership. Any role may create.
    const ctx = await requireProject(parsed.data.projectId);
    const state = await requireStateInProject(ctx.project.id, parsed.data.stateId);

    // Each of these proves a client-supplied id belongs to THIS project before
    // it is written. `requireParentInProject` additionally refuses a parent that
    // is itself a sub-issue, so the progress rollup stays one level deep.
    if (parsed.data.boardId !== '') {
      await requireBoardInProject(ctx.project.id, parsed.data.boardId);
    }
    if (parsed.data.cycleId !== '') {
      await requireCycleInProject(ctx.project.id, parsed.data.cycleId);
    }
    if (parsed.data.assigneeId !== '' && !(await isOrgMember(ctx.project.id, parsed.data.assigneeId))) {
      return fail(NOT_A_MEMBER);
    }
    // A parent must belong to this project and must not itself be a sub-issue.
    // Checked here rather than inside the transaction below: it runs on the
    // shared client, so calling it in there would not have joined the
    // transaction anyway -- it would just have looked like it had.
    if (parsed.data.parentId !== '') {
      await requireParentInProject(ctx.project.id, '', parsed.data.parentId);
    }
    const labelIds = await filterLabelsInProject(ctx.project.id, parsed.data.labelIds);

    const description = parsed.data.description.length > 0 ? parsed.data.description : null;

    // The numbering transaction, the position append and the lifecycle stamps
    // all live in `src/lib/ticket-insert.ts` -- shared verbatim with the
    // recurring-ticket scheduler, which must file its tickets exactly as a
    // person would. Every id handed over has been proved above; `insertTicket`
    // checks none of them itself, which is why it is not an action.
    const created = await insertTicket({
      projectId: ctx.project.id,
      state,
      title: parsed.data.title,
      description,
      priority: parsed.data.priority,
      assigneeId: parsed.data.assigneeId === '' ? null : parsed.data.assigneeId,
      boardId: parsed.data.boardId === '' ? null : parsed.data.boardId,
      cycleId: parsed.data.cycleId === '' ? null : parsed.data.cycleId,
      parentId: parsed.data.parentId === '' ? null : parsed.data.parentId,
      labelIds,
      // Identity comes from the session. Never from the form.
      createdById: user.id,
    });

    // The other of the two `assigneeId` write points. Filing an issue already
    // assigned to someone notifies them exactly as reassigning one does; the
    // rule that the actor is never mailed lives in `notifyIssueAssigned`, so
    // assigning yourself on creation stays silent.
    if (parsed.data.assigneeId !== '') {
      await notifyIssueAssigned({
        projectId: ctx.project.id,
        assigneeId: parsed.data.assigneeId,
        actorId: user.id,
        actorName: user.name,
        issue: issueContext(ctx, created.number, parsed.data.title),
      });
    }

    revalidatePath(projectPath(ctx.org, ctx.project));
    revalidatePath(issuesPath(ctx.org, ctx.project));
    return ok(`Created ${ctx.project.key}-${created.number}.`);
  });
}

/* -------------------------------------------------------------------------- */
/* updateIssue                                                                 */
/* -------------------------------------------------------------------------- */

const updateIssueSchema = z.object({
  ticketId: cuid,
  title: ticketTitleSchema,
  description: ticketDescriptionSchema,
});

export async function updateIssue(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  return runAction(async () => {
    await requireUser();

    const parsed = updateIssueSchema.safeParse({
      ticketId: field(formData, 'ticketId'),
      title: field(formData, 'title'),
      description: field(formData, 'description'),
    });
    if (!parsed.success) return fail(INVALID_INPUT, fieldErrorsOf(parsed.error));

    // Any role may edit an issue (SPEC role matrix).
    const ctx = await requireTicket(parsed.data.ticketId);

    await prisma.ticket.update({
      where: { id: ctx.ticket.id },
      data: {
        title: parsed.data.title,
        description: parsed.data.description.length > 0 ? parsed.data.description : null,
      },
    });

    revalidateIssue(ctx);
    return ok('Issue updated.');
  });
}

/* -------------------------------------------------------------------------- */
/* deleteIssue                                                                 */
/* -------------------------------------------------------------------------- */

const deleteIssueSchema = z.object({ ticketId: cuid });

/**
 * Delete an issue's bucket objects. BEST EFFORT, and called BEFORE the row goes,
 * because the rows are what name the objects and `Attachment.ticketId` cascades
 * them away with the issue.
 *
 * `ticketId` must come from an authorized context; the only caller resolves it
 * through `requireTicket` first and this performs no tenant check of its own.
 *
 * NOTHING HERE CAN FAIL THE DELETE IT IS CLEANING UP AFTER. A bucket outage, a
 * rotated credential or no bucket at all leaves objects behind and logs a count:
 * an orphan costs $0.015/GB-month, where a delete that refuses to proceed costs
 * someone their afternoon.
 *
 * DELIBERATELY NOT WIRED TO PROJECT, BOARD OR ORGANIZATION DELETE. Those cascade
 * hundreds of issues away in one statement, and walking every object in a
 * best-effort loop would turn one query into thousands of HTTP calls for pennies
 * of storage. Objects orphaned that way stay orphaned, and the README says so.
 */
async function purgeTicketAttachments(ticketId: string): Promise<void> {
  const rows = await prisma.attachment.findMany({ where: { ticketId }, select: { key: true } });
  if (rows.length === 0) return;

  const results = await Promise.all(rows.map((row) => deleteObject(row.key)));
  const failed = results.filter((deleted) => !deleted).length;
  // Counts only -- never a key, which names the issue it belonged to (SPEC 4.7).
  if (failed > 0) console.error(`[attachments] orphaned=${failed} of=${rows.length}`);
}

export async function deleteIssue(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  // A plain object holder, so the redirect target survives the closure without
  // relying on control-flow narrowing across an `await`.
  const navigation: { to?: string } = {};

  const result = await runAction(async () => {
    await requireUser();

    const parsed = deleteIssueSchema.safeParse({ ticketId: field(formData, 'ticketId') });
    if (!parsed.success) return fail(INVALID_INPUT, fieldErrorsOf(parsed.error));

    const ctx = await requireTicket(parsed.data.ticketId);
    // SPEC 7.18: the author, or ADMIN/OWNER. A MEMBER may not destroy another
    // member's work, while issue EDITING stays open to every member.
    requireAuthorOrRole(ctx, ctx.ticket.createdById, 'ADMIN');

    // Bucket objects BEFORE the row, because the rows are what name them and
    // `ticketId` cascades them away. Best effort by design: a bucket outage leaves
    // orphaned objects and a log line, never a delete that refuses to happen.
    await purgeTicketAttachments(ctx.ticket.id);

    // Comments and attachment rows cascade; sub-issues are orphaned rather than
    // deleted (parentId is SetNull), so deleting an epic never takes its children
    // with it.
    await prisma.ticket.delete({ where: { id: ctx.ticket.id } });

    revalidateIssue(ctx);
    navigation.to = issuesPath(ctx.org, ctx.project);
    return ok();
  });

  if (result.ok && navigation.to) redirect(navigation.to);
  return result;
}

/* -------------------------------------------------------------------------- */
/* Field setters                                                               */
/*                                                                             */
/* Each takes plain arguments rather than FormData because they are invoked     */
/* from a menu or a drag handler, not a form submit. That changes nothing about */
/* trust: each still re-derives the session, zod-validates its input, and       */
/* resolves the issue through `requireTicket`.                                  */
/* -------------------------------------------------------------------------- */

const setStateSchema = z.object({ ticketId: cuid, stateId: cuid });

export async function setIssueState(input: {
  ticketId: string;
  stateId: string;
}): Promise<ActionResult> {
  return runAction(async () => {
    await requireUser();

    const parsed = setStateSchema.safeParse(input);
    if (!parsed.success) return fail(INVALID_INPUT, fieldErrorsOf(parsed.error));

    const ctx = await requireTicket(parsed.data.ticketId);
    // `ctx.ticket.projectId` is from the authorized row, never the client, so an
    // issue can only ever land on a state of its OWN project.
    const state = await requireStateInProject(ctx.ticket.projectId, parsed.data.stateId);

    if (ctx.ticket.stateId !== state.id) {
      await moveToState(ctx, state);
    }

    revalidateIssue(ctx);
    return ok();
  });
}

/** Shared by `setIssueState` and the board's drag handler. */
async function moveToState(ctx: TicketCtx, state: StateRef): Promise<void> {
  const stamps = stampsFor(state.type, ctx.ticket);
  await prisma.$transaction(async (tx) => {
    const position = await nextPosition(tx, ctx.ticket.projectId, state.id);
    await tx.ticket.update({
      where: { id: ctx.ticket.id },
      data: { stateId: state.id, position, ...stamps },
    });
  });
}

/* -------------------------------------------------------------------------- */
/* FormData wrappers                                                           */
/*                                                                             */
/* The issue page drives its sidebar with plain `<form action>` + useActionState, */
/* which hands the action FormData. The menu-driven setters above take plain    */
/* arguments. Rather than two implementations of the same write, these adapt.   */
/* -------------------------------------------------------------------------- */

export async function moveIssue(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  return setIssueState({
    ticketId: field(formData, 'ticketId'),
    stateId: field(formData, 'toStateId'),
  });
}

export async function assignIssue(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  return setIssueAssignee({
    ticketId: field(formData, 'ticketId'),
    assigneeId: field(formData, 'assigneeId'),
  });
}

export async function boardIssue(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  return setIssueBoard({
    ticketId: field(formData, 'ticketId'),
    boardId: field(formData, 'boardId'),
  });
}

/* -------------------------------------------------------------------------- */
/* placeIssue -- the drag-and-drop primitive                                   */
/* -------------------------------------------------------------------------- */

const placeIssueSchema = z.object({
  ticketId: cuid,
  toStateId: cuid,
  /** Destination index within the target column, clamped server-side. */
  toIndex: z.coerce.number().int().min(0).max(10_000),
});

/**
 * Move an issue to an arbitrary (state, index). This is what a drop expresses,
 * and `setIssueState` (which appends) cannot say it.
 *
 * Positions are dense within a (projectId, stateId) pair. A board shows a
 * FILTERED slice of that pair -- only the issues on one board -- so the index
 * the client sends is an index into what it can see, not into the whole state.
 * The reconciliation below therefore renumbers the whole state, inserting the
 * dragged issue after the sibling it was dropped behind on screen.
 */
export async function placeIssue(input: {
  ticketId: string;
  toStateId: string;
  toIndex: number;
  /** Ids the client had in view, in order. Bounds the index into the real set. */
  visibleIds?: string[];
}): Promise<ActionResult> {
  return runAction(async () => {
    await requireUser();

    const parsed = placeIssueSchema.safeParse(input);
    if (!parsed.success) return fail(INVALID_INPUT, fieldErrorsOf(parsed.error));

    const ctx = await requireTicket(parsed.data.ticketId);
    const state = await requireStateInProject(ctx.ticket.projectId, parsed.data.toStateId);
    const fromStateId = ctx.ticket.stateId;
    const stamps = stampsFor(state.type, ctx.ticket);

    // Ids the client claims it could see. Untrusted, and used only to decide
    // WHERE among real siblings to land -- never to authorize anything.
    const visible = Array.isArray(input.visibleIds)
      ? input.visibleIds.filter((id) => typeof id === 'string').slice(0, 1000)
      : null;

    await prisma.$transaction(async (tx) => {
      const destination = await tx.ticket.findMany({
        where: {
          projectId: ctx.ticket.projectId,
          stateId: state.id,
          id: { not: ctx.ticket.id },
        },
        orderBy: TICKET_ORDER,
        select: { id: true, position: true },
      });

      const index = resolveIndex(destination, visible, parsed.data.toIndex);
      const ordered = [
        ...destination.slice(0, index),
        { id: ctx.ticket.id, position: -1 },
        ...destination.slice(index),
      ];

      const pending = new Map<string, Prisma.TicketUpdateInput>();
      ordered.forEach((row, i) => {
        if (row.id === ctx.ticket.id) {
          pending.set(row.id, {
            position: i,
            state: { connect: { id: state.id } },
            ...stamps,
          });
        } else if (row.position !== i) {
          pending.set(row.id, { position: i });
        }
      });

      // Leaving a state leaves a hole; close it so positions stay dense.
      if (fromStateId !== state.id) {
        const source = await tx.ticket.findMany({
          where: {
            projectId: ctx.ticket.projectId,
            stateId: fromStateId,
            id: { not: ctx.ticket.id },
          },
          orderBy: TICKET_ORDER,
          select: { id: true, position: true },
        });
        source.forEach((row, i) => {
          if (row.position !== i) pending.set(row.id, { position: i });
        });
      }

      // One globally id-sorted write pass across BOTH states. Sorting each
      // state separately would still let two opposite-direction drags take
      // locks in opposite orders and deadlock; a single ascending-id order is
      // the same for every concurrent transaction, so a cycle is impossible.
      const updates = [...pending.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1));
      for (const [id, data] of updates) {
        await tx.ticket.update({ where: { id }, data });
      }
    });

    revalidateIssue(ctx);
    return ok();
  });
}

/**
 * Translate an index within what the client could SEE into an index within the
 * state's real contents.
 *
 * Without this, dropping a card at the top of a board column whose state also
 * holds issues from three other boards would silently reorder all of them.
 * The dragged card lands immediately after the last visible sibling that
 * precedes it, which is what the drop looked like on screen.
 */
function resolveIndex(
  destination: Array<{ id: string }>,
  visible: string[] | null,
  toIndex: number,
): number {
  if (!visible) return Math.min(toIndex, destination.length);

  const precedingVisible = visible.slice(0, toIndex);
  let index = 0;
  for (let i = destination.length - 1; i >= 0; i -= 1) {
    if (precedingVisible.includes(destination[i].id)) {
      index = i + 1;
      break;
    }
  }
  return Math.min(index, destination.length);
}

/* -------------------------------------------------------------------------- */
/* Simple field setters                                                        */
/* -------------------------------------------------------------------------- */

const setPrioritySchema = z.object({ ticketId: cuid, priority: z.nativeEnum(Priority) });

export async function setIssuePriority(input: {
  ticketId: string;
  priority: Priority;
}): Promise<ActionResult> {
  return runAction(async () => {
    await requireUser();
    const parsed = setPrioritySchema.safeParse(input);
    if (!parsed.success) return fail(INVALID_INPUT, fieldErrorsOf(parsed.error));

    const ctx = await requireTicket(parsed.data.ticketId);
    await prisma.ticket.update({
      where: { id: ctx.ticket.id },
      data: { priority: parsed.data.priority },
    });

    revalidateIssue(ctx);
    return ok();
  });
}

const setDueDateSchema = z.object({
  ticketId: cuid,
  dueDate: z.union([isoDateSchema, z.null()]),
});

export async function setIssueDueDate(input: {
  ticketId: string;
  dueDate: string | null;
}): Promise<ActionResult> {
  return runAction(async () => {
    await requireUser();
    const parsed = setDueDateSchema.safeParse(input);
    if (!parsed.success) return fail(INVALID_INPUT, fieldErrorsOf(parsed.error));

    const ctx = await requireTicket(parsed.data.ticketId);
    // Parsed as UTC midnight so the stored instant does not drift a day
    // depending on where the server happens to be running.
    const value =
      parsed.data.dueDate === null ? null : new Date(`${parsed.data.dueDate}T00:00:00.000Z`);

    await prisma.ticket.update({ where: { id: ctx.ticket.id }, data: { dueDate: value } });

    revalidateIssue(ctx);
    return ok();
  });
}

const setAssigneeSchema = z.object({
  ticketId: cuid,
  assigneeId: z.union([cuid, z.literal('')]),
});

export async function setIssueAssignee(input: {
  ticketId: string;
  assigneeId: string;
}): Promise<ActionResult> {
  return runAction(async () => {
    await requireUser();
    const parsed = setAssigneeSchema.safeParse(input);
    if (!parsed.success) return fail(INVALID_INPUT, fieldErrorsOf(parsed.error));

    const ctx = await requireTicket(parsed.data.ticketId);
    // MANDATORY before any write of `assigneeId`: a candidate outside this
    // organization is refused, so assignment cannot be used to probe for user
    // ids across the tenant boundary.
    if (parsed.data.assigneeId !== '' && !(await isOrgMember(ctx.project.id, parsed.data.assigneeId))) {
      return fail(NOT_A_MEMBER);
    }

    const assigneeId = parsed.data.assigneeId === '' ? null : parsed.data.assigneeId;

    await prisma.ticket.update({
      where: { id: ctx.ticket.id },
      data: { assigneeId },
    });

    // Only on an actual change. Re-submitting the same assignee -- which the
    // board menu does readily -- must not re-send the mail.
    if (assigneeId !== ctx.ticket.assigneeId) {
      await notifyIssueAssigned({
        projectId: ctx.project.id,
        assigneeId,
        actorId: ctx.user.id,
        actorName: ctx.user.name,
        issue: issueContext(ctx, ctx.ticket.number, ctx.ticket.title),
      });
    }

    revalidateIssue(ctx);
    return ok();
  });
}

const setBoardSchema = z.object({ ticketId: cuid, boardId: z.union([cuid, z.literal('')]) });

/** The empty string files the issue under no board, which is a legal state. */
export async function setIssueBoard(input: {
  ticketId: string;
  boardId: string;
}): Promise<ActionResult> {
  return runAction(async () => {
    await requireUser();
    const parsed = setBoardSchema.safeParse(input);
    if (!parsed.success) return fail(INVALID_INPUT, fieldErrorsOf(parsed.error));

    const ctx = await requireTicket(parsed.data.ticketId);
    const board =
      parsed.data.boardId === ''
        ? null
        : await requireBoardInProject(ctx.ticket.projectId, parsed.data.boardId);

    await prisma.ticket.update({
      where: { id: ctx.ticket.id },
      data: { boardId: board?.id ?? null },
    });

    // `ticketSurfaces` covers the OLD board -- `ctx` predates the write -- or the
    // card lingers there. The DESTINATION is not in it, and without this the
    // issue is missing from the board it was just moved to.
    revalidateIssue(ctx, board ? [boardPath(ctx.org, ctx.project, board)] : []);
    return ok('Board updated.');
  });
}

const setCycleSchema = z.object({ ticketId: cuid, cycleId: z.union([cuid, z.literal('')]) });

export async function setIssueCycle(input: {
  ticketId: string;
  cycleId: string;
}): Promise<ActionResult> {
  return runAction(async () => {
    await requireUser();
    const parsed = setCycleSchema.safeParse(input);
    if (!parsed.success) return fail(INVALID_INPUT, fieldErrorsOf(parsed.error));

    const ctx = await requireTicket(parsed.data.ticketId);
    if (parsed.data.cycleId !== '') {
      await requireCycleInProject(ctx.ticket.projectId, parsed.data.cycleId);
    }

    await prisma.ticket.update({
      where: { id: ctx.ticket.id },
      data: { cycleId: parsed.data.cycleId === '' ? null : parsed.data.cycleId },
    });

    revalidateIssue(ctx);
    return ok();
  });
}

const setParentSchema = z.object({ ticketId: cuid, parentId: z.union([cuid, z.literal('')]) });

export async function setIssueParent(input: {
  ticketId: string;
  parentId: string;
}): Promise<ActionResult> {
  return runAction(async () => {
    await requireUser();
    const parsed = setParentSchema.safeParse(input);
    if (!parsed.success) return fail(INVALID_INPUT, fieldErrorsOf(parsed.error));

    const ctx = await requireTicket(parsed.data.ticketId);

    if (parsed.data.parentId !== '') {
      // Refuses self-parenting and refuses a parent that is itself a sub-issue,
      // so the hierarchy stays one level deep and cannot form a cycle.
      await requireParentInProject(ctx.ticket.projectId, ctx.ticket.id, parsed.data.parentId);
      // An issue that already has children cannot also become a child.
      const children = await prisma.ticket.count({
        where: { projectId: ctx.ticket.projectId, parentId: ctx.ticket.id },
      });
      if (children > 0) return fail('An issue with sub-issues cannot become a sub-issue.');
    }

    await prisma.ticket.update({
      where: { id: ctx.ticket.id },
      data: { parentId: parsed.data.parentId === '' ? null : parsed.data.parentId },
    });

    revalidateIssue(ctx);
    return ok();
  });
}

const setLabelsSchema = z.object({ ticketId: cuid, labelIds: z.array(cuid).max(20) });

export async function setIssueLabels(input: {
  ticketId: string;
  labelIds: string[];
}): Promise<ActionResult> {
  return runAction(async () => {
    await requireUser();
    const parsed = setLabelsSchema.safeParse(input);
    if (!parsed.success) return fail(INVALID_INPUT, fieldErrorsOf(parsed.error));

    const ctx = await requireTicket(parsed.data.ticketId);
    // `set` replaces the whole relation, so anything the filter dropped is
    // removed rather than silently left attached.
    const labelIds = await filterLabelsInProject(ctx.ticket.projectId, parsed.data.labelIds);

    await prisma.ticket.update({
      where: { id: ctx.ticket.id },
      data: { labels: { set: labelIds.map((id) => ({ id })) } },
    });

    revalidateIssue(ctx);
    return ok();
  });
}
