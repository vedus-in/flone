'use server';

/**
 * Project-scoped Server Actions: the settings a Linear team owns.
 *
 * Workflow states, labels, boards, cycle cadence and saved views all live on the
 * Project now, so they are all governed from one file with one rule: ADMIN+ for
 * anything that changes the shape of the workspace, any role for the work
 * inside it (which lives in `issue-actions.ts`).
 *
 * The project actions authorize on the (orgSlug, projectKey) URL tuple, so a
 * mismatched ancestor yields NOT_FOUND from the same query rather than needing a
 * follow-up assertion. The leaf-id actions authorize on the id alone and walk up
 * to the organization, which also hands back the chain needed to build the
 * revalidate and redirect paths.
 */

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { Role } from '@prisma/client';
import { z } from 'zod';

import { prisma } from '@/lib/db';
import {
  boardPath,
  boardsPath,
  issuesPath,
  orgPath,
  projectPath,
  projectSettingsPath,
  requireBoard,
  requireProject,
  requireProjectByKeyInOrg,
  requireRole,
  requireStateInProject,
  requireUser,
  runAction,
  viewsPath,
  workspacePath,
} from '@/lib/authz';
import { ERRORS, fail, ok, type ActionResult } from '@/lib/result';
import { INVALID_INPUT, field, fieldErrorsOf, optionalField } from '@/lib/action-input';
import {
  DEFAULT_STATES,
  STATE_ORDER,
  boardDescriptionSchema,
  boardNameSchema,
  boardStatusSchema,
  colorTokenSchema,
  cuid,
  cycleStartDaySchema,
  cycleWeeksSchema,
  isoDateSchema,
  labelNameSchema,
  projectDescriptionSchema,
  projectKeySchema,
  projectNameSchema,
  slugSchema,
  stateNameSchema,
  stateTypeSchema,
  upcomingCyclesSchema,
  viewNameSchema,
  viewQuerySchema,
} from '@/lib/validation';

const CONFIRM_MISMATCH = 'The key you typed does not match.';
const NAME_TAKEN = 'Something in this project already has that name.';

/** Prisma's unique-violation code, for the (projectId, name) constraints. */
function isUniqueViolation(e: unknown): boolean {
  return (
    typeof e === 'object' &&
    e !== null &&
    'code' in e &&
    (e as { code?: unknown }).code === 'P2002'
  );
}

/* -------------------------------------------------------------------------- */
/* Project                                                                     */
/* -------------------------------------------------------------------------- */

const updateProjectSchema = z.object({
  orgSlug: slugSchema,
  projectKey: projectKeySchema,
  name: projectNameSchema,
  description: projectDescriptionSchema.optional(),
});

export async function updateProject(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  return runAction(async () => {
    await requireUser();

    const parsed = updateProjectSchema.safeParse({
      orgSlug: formData.get('orgSlug'),
      projectKey: formData.get('projectKey'),
      name: formData.get('name'),
      description: optionalField(formData, 'description'),
    });
    if (!parsed.success) return fail(INVALID_INPUT, fieldErrorsOf(parsed.error));

    const ctx = await requireProjectByKeyInOrg(parsed.data.orgSlug, parsed.data.projectKey);
    requireRole(ctx, Role.ADMIN);

    // The key is immutable: it is the URL segment and the issue prefix, and
    // rewriting it would break every link and every `VED-153` anyone has typed.
    await prisma.project.updateMany({
      where: {
        id: ctx.project.id,
        organization: { memberships: { some: { userId: ctx.user.id } } },
      },
      data: { name: parsed.data.name, description: parsed.data.description ?? null },
    });

    revalidatePath(projectPath(ctx.org, ctx.project));
    revalidatePath(orgPath(ctx.org));
    return ok('Project updated.');
  });
}

const moveProjectSchema = z.object({
  projectId: cuid,
  workspaceId: cuid,
  follow: z.boolean().optional(),
});

/**
 * Regroup a project into another workspace. Called by dragging its sidebar row
 * onto a workspace, so it takes ids rather than the URL tuple -- the sidebar
 * has both to hand and no path to parse.
 *
 * This changes the project's URL and the URL of every issue, board, cycle and
 * view under it. Only the viewer knows whether they are STANDING on one of
 * those, so `follow` is theirs to set: without it a drag from elsewhere in the
 * app quietly regroups the tree, and with it the page you are reading follows
 * the project instead of 404ing, which would read as it having been deleted.
 * Old links keep working through the `/go` trampoline, which resolves the key
 * rather than the path.
 *
 * The destination is looked up inside the organization the project's own
 * upward walk yielded, so a workspace id from another tenant is simply absent.
 */
export async function moveProjectToWorkspace(input: {
  projectId: string;
  workspaceId: string;
  follow?: boolean;
}): Promise<ActionResult> {
  const nav: { to?: string } = {};

  const result = await runAction(async () => {
    await requireUser();

    const parsed = moveProjectSchema.safeParse(input);
    if (!parsed.success) return fail(INVALID_INPUT, fieldErrorsOf(parsed.error));

    const ctx = await requireProject(parsed.data.projectId);
    requireRole(ctx, Role.ADMIN);

    if (parsed.data.workspaceId === ctx.workspace.id) return ok();

    const destination = await prisma.workspace.findFirst({
      where: { id: parsed.data.workspaceId, organizationId: ctx.org.id },
      select: { id: true, name: true, slug: true },
    });
    if (!destination) return fail(ERRORS.NOT_FOUND);

    await prisma.project.updateMany({
      where: {
        id: ctx.project.id,
        organization: { memberships: { some: { userId: ctx.user.id } } },
      },
      data: { workspaceId: destination.id },
    });

    revalidatePath('/', 'layout');
    revalidatePath(orgPath(ctx.org));
    revalidatePath(workspacePath(ctx.org, ctx.workspace));
    revalidatePath(workspacePath(ctx.org, destination));
    if (parsed.data.follow) {
      nav.to = projectPath(ctx.org, { ...ctx.project, workspaceSlug: destination.slug });
    }
    return ok(`Moved to ${destination.name}.`);
  });

  if (!result.ok) return result;
  if (nav.to) redirect(nav.to);
  return result;
}

const deleteProjectSchema = z.object({
  orgSlug: slugSchema,
  projectKey: projectKeySchema,
  confirmKey: z.string().max(50),
});

export async function deleteProject(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  const nav: { to?: string } = {};

  const result = await runAction(async () => {
    await requireUser();

    const parsed = deleteProjectSchema.safeParse({
      orgSlug: formData.get('orgSlug'),
      projectKey: formData.get('projectKey'),
      confirmKey: formData.get('confirmKey'),
    });
    if (!parsed.success) return fail(INVALID_INPUT, fieldErrorsOf(parsed.error));

    const ctx = await requireProjectByKeyInOrg(parsed.data.orgSlug, parsed.data.projectKey);
    requireRole(ctx, Role.ADMIN);

    if (parsed.data.confirmKey.trim().toUpperCase() !== ctx.project.key) {
      return fail(CONFIRM_MISMATCH, { confirmKey: CONFIRM_MISMATCH });
    }

    // Cascades through boards, states, cycles, labels, issues and comments.
    await prisma.project.deleteMany({
      where: {
        id: ctx.project.id,
        organization: { memberships: { some: { userId: ctx.user.id } } },
      },
    });

    revalidatePath(orgPath(ctx.org));
    nav.to = orgPath(ctx.org);
    return ok();
  });

  if (!result.ok) return result;
  if (nav.to) redirect(nav.to);
  return result;
}

const cycleConfigSchema = z.object({
  projectId: cuid,
  cyclesEnabled: z.coerce.boolean(),
  cycleWeeks: cycleWeeksSchema,
  cycleStartDay: cycleStartDaySchema,
  upcomingCycles: upcomingCyclesSchema,
});

/**
 * Change the cycle cadence.
 *
 * Existing cycle ROWS are left alone. Cycle 12's dates are a historical fact
 * once work has been filed against it, and silently re-dating finished sprints
 * because someone switched from two weeks to three would rewrite every past
 * burndown. New cycles are generated from the new cadence on the next read.
 */
export async function updateCycleConfig(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  return runAction(async () => {
    await requireUser();

    const parsed = cycleConfigSchema.safeParse({
      projectId: field(formData, 'projectId'),
      cyclesEnabled: formData.get('cyclesEnabled') === 'on',
      cycleWeeks: field(formData, 'cycleWeeks'),
      cycleStartDay: field(formData, 'cycleStartDay'),
      upcomingCycles: field(formData, 'upcomingCycles'),
    });
    if (!parsed.success) return fail(INVALID_INPUT, fieldErrorsOf(parsed.error));

    const ctx = await requireProject(parsed.data.projectId);
    requireRole(ctx, Role.ADMIN);

    await prisma.project.update({
      where: { id: ctx.project.id },
      data: {
        cyclesEnabled: parsed.data.cyclesEnabled,
        cycleWeeks: parsed.data.cycleWeeks,
        cycleStartDay: parsed.data.cycleStartDay,
        upcomingCycles: parsed.data.upcomingCycles,
      },
    });

    revalidatePath(projectSettingsPath(ctx.org, ctx.project));
    revalidatePath(projectPath(ctx.org, ctx.project));
    return ok('Cycles updated.');
  });
}

/* -------------------------------------------------------------------------- */
/* Workflow states                                                             */
/* -------------------------------------------------------------------------- */

const createStateSchema = z.object({
  projectId: cuid,
  name: stateNameSchema,
  type: stateTypeSchema,
  color: colorTokenSchema.default('gray'),
});

export async function createState(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  return runAction(async () => {
    await requireUser();

    const parsed = createStateSchema.safeParse({
      projectId: field(formData, 'projectId'),
      name: field(formData, 'name'),
      type: field(formData, 'type'),
      color: field(formData, 'color') || undefined,
    });
    if (!parsed.success) return fail(INVALID_INPUT, fieldErrorsOf(parsed.error));

    const ctx = await requireProject(parsed.data.projectId);
    requireRole(ctx, Role.ADMIN);

    const highest = await prisma.workflowState.aggregate({
      where: { projectId: ctx.project.id },
      _max: { position: true },
    });

    try {
      await prisma.workflowState.create({
        data: {
          projectId: ctx.project.id,
          name: parsed.data.name,
          type: parsed.data.type,
          color: parsed.data.color,
          position: (highest._max.position ?? -1) + 1,
        },
      });
    } catch (e) {
      if (isUniqueViolation(e)) return fail(NAME_TAKEN, { name: NAME_TAKEN });
      throw e;
    }

    revalidatePath(projectSettingsPath(ctx.org, ctx.project));
    revalidatePath(issuesPath(ctx.org, ctx.project));
    return ok('State added.');
  });
}

const updateStateSchema = z.object({
  projectId: cuid,
  stateId: cuid,
  name: stateNameSchema,
  type: stateTypeSchema,
  color: colorTokenSchema,
});

export async function updateState(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  return runAction(async () => {
    await requireUser();

    const parsed = updateStateSchema.safeParse({
      projectId: field(formData, 'projectId'),
      stateId: field(formData, 'stateId'),
      name: field(formData, 'name'),
      type: field(formData, 'type'),
      color: field(formData, 'color'),
    });
    if (!parsed.success) return fail(INVALID_INPUT, fieldErrorsOf(parsed.error));

    const ctx = await requireProject(parsed.data.projectId);
    requireRole(ctx, Role.ADMIN);
    // Proves the state belongs to THIS project before it is written.
    const state = await requireStateInProject(ctx.project.id, parsed.data.stateId);

    try {
      await prisma.workflowState.update({
        where: { id: state.id },
        data: { name: parsed.data.name, type: parsed.data.type, color: parsed.data.color },
      });
    } catch (e) {
      if (isUniqueViolation(e)) return fail(NAME_TAKEN, { name: NAME_TAKEN });
      throw e;
    }

    revalidatePath(projectSettingsPath(ctx.org, ctx.project));
    revalidatePath(issuesPath(ctx.org, ctx.project));
    return ok('State updated.');
  });
}

const deleteStateSchema = z.object({
  projectId: cuid,
  stateId: cuid,
  /** Where this state's issues go. Required when it holds any. */
  reassignToId: z.union([cuid, z.literal('')]).default(''),
});

/**
 * Delete a workflow state.
 *
 * `Ticket.stateId` is `Restrict` in the schema, so the database would refuse
 * this anyway -- but a raw foreign-key error is not an answer. Issues are moved
 * to an explicitly chosen state first, inside the same transaction as the
 * delete, so there is no window where they point at a state that is going away.
 */
export async function deleteState(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  return runAction(async () => {
    await requireUser();

    const parsed = deleteStateSchema.safeParse({
      projectId: field(formData, 'projectId'),
      stateId: field(formData, 'stateId'),
      reassignToId: field(formData, 'reassignToId'),
    });
    if (!parsed.success) return fail(INVALID_INPUT, fieldErrorsOf(parsed.error));

    const ctx = await requireProject(parsed.data.projectId);
    requireRole(ctx, Role.ADMIN);
    const state = await requireStateInProject(ctx.project.id, parsed.data.stateId);

    const remaining = await prisma.workflowState.count({ where: { projectId: ctx.project.id } });
    if (remaining <= 1) {
      return fail('A project needs at least one workflow state.');
    }

    const held = await prisma.ticket.count({
      where: { projectId: ctx.project.id, stateId: state.id },
    });

    if (held > 0 && parsed.data.reassignToId === '') {
      return fail(
        `${held} ${held === 1 ? 'issue is' : 'issues are'} in ${state.name}. Choose where to move ${held === 1 ? 'it' : 'them'} first.`,
      );
    }

    const target =
      parsed.data.reassignToId === ''
        ? null
        : await requireStateInProject(ctx.project.id, parsed.data.reassignToId);
    if (target && target.id === state.id) {
      return fail('Choose a different state to move the issues to.');
    }

    await prisma.$transaction(async (tx) => {
      if (held > 0 && target) {
        await tx.ticket.updateMany({
          where: { projectId: ctx.project.id, stateId: state.id },
          data: { stateId: target.id },
        });
      }
      await tx.workflowState.delete({ where: { id: state.id } });
    });

    revalidatePath(projectSettingsPath(ctx.org, ctx.project));
    revalidatePath(issuesPath(ctx.org, ctx.project));
    return ok('State deleted.');
  });
}

const moveStateSchema = z.object({
  projectId: cuid,
  stateId: cuid,
  direction: z.enum(['up', 'down']),
});

/**
 * Nudge a workflow state one place along the BOARD order.
 *
 * Two buttons rather than drag-and-drop: this is a settings list of half a
 * dozen rows that is reordered once and then never again, and buttons work on a
 * phone, from the keyboard, and before hydration.
 *
 * The whole list is renumbered densely inside the transaction rather than
 * swapping two positions, for the reason SPEC 7.4 gives about tickets: swapping
 * is wrong the moment two rows are tied, which a never-compacted scheme allows.
 */
export async function moveState(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  return runAction(async () => {
    await requireUser();

    const parsed = moveStateSchema.safeParse({
      projectId: field(formData, 'projectId'),
      stateId: field(formData, 'stateId'),
      direction: field(formData, 'direction'),
    });
    if (!parsed.success) return fail(INVALID_INPUT, fieldErrorsOf(parsed.error));

    const ctx = await requireProject(parsed.data.projectId);
    requireRole(ctx, Role.ADMIN);
    // Proves the state belongs to THIS project before anything is written.
    await requireStateInProject(ctx.project.id, parsed.data.stateId);

    const states = await prisma.workflowState.findMany({
      where: { projectId: ctx.project.id },
      orderBy: STATE_ORDER,
      select: { id: true, position: true },
    });

    const index = states.findIndex((state) => state.id === parsed.data.stateId);
    const swapWith = parsed.data.direction === 'up' ? index - 1 : index + 1;
    // Already at the edge: a no-op, not an error.
    if (index === -1 || swapWith < 0 || swapWith >= states.length) return ok();

    const reordered = states.slice();
    const moved = reordered[index];
    reordered[index] = reordered[swapWith];
    reordered[swapWith] = moved;

    await prisma.$transaction(
      reordered
        .map((state, position) => ({ id: state.id, position, was: state.position }))
        .filter((row) => row.was !== row.position)
        // Ascending id, like every other multi-row write here, so two concurrent
        // reorders cannot take locks in opposite orders and deadlock.
        .sort((a, b) => (a.id < b.id ? -1 : 1))
        .map((row) =>
          prisma.workflowState.update({ where: { id: row.id }, data: { position: row.position } }),
        ),
    );

    revalidatePath(projectSettingsPath(ctx.org, ctx.project));
    revalidatePath(issuesPath(ctx.org, ctx.project));
    return ok();
  });
}

/* -------------------------------------------------------------------------- */
/* Labels                                                                      */
/* -------------------------------------------------------------------------- */

const createLabelSchema = z.object({
  projectId: cuid,
  name: labelNameSchema,
  color: colorTokenSchema.default('gray'),
});

export async function createLabel(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  return runAction(async () => {
    await requireUser();

    const parsed = createLabelSchema.safeParse({
      projectId: field(formData, 'projectId'),
      name: field(formData, 'name'),
      color: field(formData, 'color') || undefined,
    });
    if (!parsed.success) return fail(INVALID_INPUT, fieldErrorsOf(parsed.error));

    const ctx = await requireProject(parsed.data.projectId);
    requireRole(ctx, Role.ADMIN);

    try {
      await prisma.label.create({
        data: { projectId: ctx.project.id, name: parsed.data.name, color: parsed.data.color },
      });
    } catch (e) {
      if (isUniqueViolation(e)) return fail(NAME_TAKEN, { name: NAME_TAKEN });
      throw e;
    }

    revalidatePath(projectSettingsPath(ctx.org, ctx.project));
    revalidatePath(issuesPath(ctx.org, ctx.project));
    return ok('Label added.');
  });
}

const updateLabelSchema = z.object({
  projectId: cuid,
  labelId: cuid,
  name: labelNameSchema,
  color: colorTokenSchema,
});

export async function updateLabel(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  return runAction(async () => {
    await requireUser();

    const parsed = updateLabelSchema.safeParse({
      projectId: field(formData, 'projectId'),
      labelId: field(formData, 'labelId'),
      name: field(formData, 'name'),
      color: field(formData, 'color'),
    });
    if (!parsed.success) return fail(INVALID_INPUT, fieldErrorsOf(parsed.error));

    const ctx = await requireProject(parsed.data.projectId);
    requireRole(ctx, Role.ADMIN);

    try {
      // `updateMany` with the project predicate in the WHERE, so a label id from
      // another project matches nothing instead of being written.
      const result = await prisma.label.updateMany({
        where: { id: parsed.data.labelId, projectId: ctx.project.id },
        data: { name: parsed.data.name, color: parsed.data.color },
      });
      if (result.count === 0) return fail('That label no longer exists.');
    } catch (e) {
      if (isUniqueViolation(e)) return fail(NAME_TAKEN, { name: NAME_TAKEN });
      throw e;
    }

    revalidatePath(projectSettingsPath(ctx.org, ctx.project));
    revalidatePath(issuesPath(ctx.org, ctx.project));
    return ok('Label updated.');
  });
}

const deleteLabelSchema = z.object({ projectId: cuid, labelId: cuid });

export async function deleteLabel(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  return runAction(async () => {
    await requireUser();

    const parsed = deleteLabelSchema.safeParse({
      projectId: field(formData, 'projectId'),
      labelId: field(formData, 'labelId'),
    });
    if (!parsed.success) return fail(INVALID_INPUT, fieldErrorsOf(parsed.error));

    const ctx = await requireProject(parsed.data.projectId);
    requireRole(ctx, Role.ADMIN);

    // The join rows cascade, so this detaches the label from every issue that
    // carried it. Nothing is lost but the tag itself.
    await prisma.label.deleteMany({
      where: { id: parsed.data.labelId, projectId: ctx.project.id },
    });

    revalidatePath(projectSettingsPath(ctx.org, ctx.project));
    revalidatePath(issuesPath(ctx.org, ctx.project));
    return ok('Label deleted.');
  });
}

/* -------------------------------------------------------------------------- */
/* Boards -- what Linear calls projects                                        */
/* -------------------------------------------------------------------------- */

const createBoardSchema = z.object({
  orgSlug: slugSchema,
  projectKey: projectKeySchema,
  name: boardNameSchema,
});

export async function createBoard(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  const nav: { to?: string } = {};

  const result = await runAction(async () => {
    await requireUser();

    const parsed = createBoardSchema.safeParse({
      orgSlug: formData.get('orgSlug'),
      projectKey: formData.get('projectKey'),
      name: formData.get('name'),
    });
    if (!parsed.success) return fail(INVALID_INPUT, fieldErrorsOf(parsed.error));

    const ctx = await requireProjectByKeyInOrg(parsed.data.orgSlug, parsed.data.projectKey);
    requireRole(ctx, Role.ADMIN);

    // No nested column create any more: a board draws its columns from the
    // PROJECT's workflow states, so there is nothing board-local to seed.
    const board = await prisma.board.create({
      data: { projectId: ctx.project.id, name: parsed.data.name },
      select: { id: true, name: true },
    });

    revalidatePath(boardsPath(ctx.org, ctx.project));
    revalidatePath(projectPath(ctx.org, ctx.project));
    nav.to = boardPath(ctx.org, ctx.project, board);
    return ok();
  });

  if (!result.ok) return result;
  if (nav.to) redirect(nav.to);
  return result;
}

const updateBoardSchema = z.object({
  boardId: cuid,
  name: boardNameSchema,
  description: boardDescriptionSchema.optional(),
  status: boardStatusSchema,
  color: colorTokenSchema,
  leadId: z.union([cuid, z.literal('')]).default(''),
  targetDate: z.union([isoDateSchema, z.literal('')]).default(''),
});

export async function updateBoard(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  return runAction(async () => {
    await requireUser();

    const parsed = updateBoardSchema.safeParse({
      boardId: field(formData, 'boardId'),
      name: field(formData, 'name'),
      description: optionalField(formData, 'description'),
      status: field(formData, 'status'),
      color: field(formData, 'color'),
      leadId: field(formData, 'leadId'),
      targetDate: field(formData, 'targetDate'),
    });
    if (!parsed.success) return fail(INVALID_INPUT, fieldErrorsOf(parsed.error));

    const ctx = await requireBoard(parsed.data.boardId);
    requireRole(ctx, Role.ADMIN);

    // A lead must be a member of this organization, for the same reason an
    // assignee must: otherwise the field is a probe for user ids.
    if (parsed.data.leadId !== '') {
      const member = await prisma.membership.findFirst({
        where: { organizationId: ctx.org.id, userId: parsed.data.leadId },
        select: { id: true },
      });
      if (!member) return fail('That person is not a member of this organization.');
    }

    await prisma.board.updateMany({
      where: {
        id: ctx.board.id,
        project: { organization: { memberships: { some: { userId: ctx.user.id } } } },
      },
      data: {
        name: parsed.data.name,
        description: parsed.data.description ?? null,
        status: parsed.data.status,
        color: parsed.data.color,
        leadId: parsed.data.leadId === '' ? null : parsed.data.leadId,
        targetDate:
          parsed.data.targetDate === ''
            ? null
            : new Date(`${parsed.data.targetDate}T00:00:00.000Z`),
      },
    });

    revalidatePath(boardsPath(ctx.org, ctx.project));
    revalidatePath(boardPath(ctx.org, ctx.project, ctx.board));
    revalidatePath(issuesPath(ctx.org, ctx.project));
    return ok('Board updated.');
  });
}

const deleteBoardSchema = z.object({ boardId: cuid });

/**
 * Delete a board.
 *
 * Its issues SURVIVE -- `Ticket.boardId` is SetNull, so they simply lose the
 * chip and stay in the project's issue list. This changed with the Linear
 * rework; a board delete used to take every ticket on it.
 */
export async function deleteBoard(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  const nav: { to?: string } = {};

  const result = await runAction(async () => {
    await requireUser();

    const parsed = deleteBoardSchema.safeParse({ boardId: formData.get('boardId') });
    if (!parsed.success) return fail(INVALID_INPUT, fieldErrorsOf(parsed.error));

    const ctx = await requireBoard(parsed.data.boardId);
    requireRole(ctx, Role.ADMIN);

    await prisma.board.deleteMany({
      where: {
        id: ctx.board.id,
        project: { organization: { memberships: { some: { userId: ctx.user.id } } } },
      },
    });

    revalidatePath(boardsPath(ctx.org, ctx.project));
    revalidatePath(issuesPath(ctx.org, ctx.project));
    nav.to = boardsPath(ctx.org, ctx.project);
    return ok();
  });

  if (!result.ok) return result;
  if (nav.to) redirect(nav.to);
  return result;
}

/** Kept under its old name so existing MCP callers and forms do not break. */
export async function renameBoard(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  return runAction(async () => {
    await requireUser();

    const parsed = z
      .object({ boardId: cuid, name: boardNameSchema })
      .safeParse({ boardId: formData.get('boardId'), name: formData.get('name') });
    if (!parsed.success) return fail(INVALID_INPUT, fieldErrorsOf(parsed.error));

    const ctx = await requireBoard(parsed.data.boardId);
    requireRole(ctx, Role.ADMIN);

    await prisma.board.updateMany({
      where: {
        id: ctx.board.id,
        project: { organization: { memberships: { some: { userId: ctx.user.id } } } },
      },
      data: { name: parsed.data.name },
    });

    revalidatePath(boardsPath(ctx.org, ctx.project));
    revalidatePath(boardPath(ctx.org, ctx.project, ctx.board));
    return ok('Board renamed.');
  });
}

/* -------------------------------------------------------------------------- */
/* Saved views                                                                 */
/* -------------------------------------------------------------------------- */

const createViewSchema = z.object({
  projectId: cuid,
  name: viewNameSchema,
  query: viewQuerySchema,
  isShared: z.coerce.boolean().default(true),
});

/**
 * Save the filter you are looking at, under a name.
 *
 * A view is a stored query string and nothing more, so there is no second
 * filter language to keep in sync with the one the URL already speaks. Any role
 * may save one: it creates no data and changes nothing anyone else sees unless
 * it is shared.
 */
export async function createSavedView(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  return runAction(async () => {
    const user = await requireUser();

    const parsed = createViewSchema.safeParse({
      projectId: field(formData, 'projectId'),
      name: field(formData, 'name'),
      query: field(formData, 'query').replace(/^\?/, ''),
      isShared: formData.get('isShared') === 'on',
    });
    if (!parsed.success) return fail(INVALID_INPUT, fieldErrorsOf(parsed.error));

    const ctx = await requireProject(parsed.data.projectId);

    await prisma.savedView.create({
      data: {
        projectId: ctx.project.id,
        name: parsed.data.name,
        query: parsed.data.query,
        isShared: parsed.data.isShared,
        // Authorship comes from the session, never from the form.
        createdById: user.id,
      },
    });

    revalidatePath(viewsPath(ctx.org, ctx.project));
    return ok('View saved.');
  });
}

const deleteViewSchema = z.object({ projectId: cuid, viewId: cuid });

export async function deleteSavedView(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  return runAction(async () => {
    const user = await requireUser();

    const parsed = deleteViewSchema.safeParse({
      projectId: field(formData, 'projectId'),
      viewId: field(formData, 'viewId'),
    });
    if (!parsed.success) return fail(INVALID_INPUT, fieldErrorsOf(parsed.error));

    const ctx = await requireProject(parsed.data.projectId);

    // Author-or-privileged, the same rule comments and issues use: your own
    // views are yours to remove, anyone's are an ADMIN's.
    const view = await prisma.savedView.findFirst({
      where: { id: parsed.data.viewId, projectId: ctx.project.id },
      select: { createdById: true },
    });
    if (!view) return fail('That view no longer exists.');
    if (view.createdById !== user.id) requireRole(ctx, Role.ADMIN);

    await prisma.savedView.deleteMany({
      where: { id: parsed.data.viewId, projectId: ctx.project.id },
    });

    revalidatePath(viewsPath(ctx.org, ctx.project));
    return ok('View deleted.');
  });
}

/*
 * Seeding lives in `@/lib/states`, NOT here. Every export of a `'use server'`
 * module is a directly addressable POST endpoint, so a helper taking a bare
 * `projectId` would be a cross-tenant write anyone could call.
 */
