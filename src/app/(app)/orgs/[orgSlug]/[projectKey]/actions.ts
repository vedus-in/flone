'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { Role } from '@prisma/client';
import { z } from 'zod';
import { prisma } from '@/lib/db';
import {
  boardPath,
  orgPath,
  projectPath,
  requireBoard,
  requireProjectByKey,
  requireRole,
  requireUser,
  runAction,
} from '@/lib/authz';
import { fail, ok, type ActionResult } from '@/lib/result';
import {
  boardNameSchema,
  cuid,
  DEFAULT_COLUMNS,
  projectDescriptionSchema,
  projectKeySchema,
  projectNameSchema,
  slugSchema,
} from '@/lib/validation';

/**
 * SPEC 6.7 -- project and board management. Every action here is ADMIN+.
 *
 * The project actions authorize on the (orgSlug, projectKey) URL tuple, so a
 * mismatched ancestor yields NOT_FOUND from the same query rather than needing a
 * follow-up assertion. The board actions authorize on the board id alone and
 * walk board -> project -> organization, which also hands back the whole chain
 * needed to build the revalidate/redirect paths.
 */

const INVALID_INPUT = 'Check the highlighted fields.';
const CONFIRM_MISMATCH = 'The key you typed does not match.';

function fieldMessages(error: z.ZodError): Record<string, string> {
  const out: Record<string, string> = {};
  for (const issue of error.issues) {
    const key = issue.path[0];
    if (typeof key === 'string' && !(key in out)) out[key] = issue.message;
  }
  return out;
}

function optionalField(formData: FormData, name: string): string | undefined {
  const raw = formData.get(name);
  return typeof raw === 'string' && raw.trim().length > 0 ? raw : undefined;
}

/* -------------------------------------------------------------------------- */
/* updateProject                                                               */
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
    if (!parsed.success) return fail(INVALID_INPUT, fieldMessages(parsed.error));

    const ctx = await requireProjectByKey(parsed.data.orgSlug, parsed.data.projectKey);
    requireRole(ctx, Role.ADMIN);

    // The key is immutable: it is the URL segment, and rewriting it would break
    // every link to the project's boards and tickets.
    await prisma.project.updateMany({
      where: {
        id: ctx.project.id,
        organization: { memberships: { some: { userId: ctx.user.id } } },
      },
      data: {
        name: parsed.data.name,
        description: parsed.data.description ?? null,
      },
    });

    revalidatePath(projectPath(ctx.org, ctx.project));
    revalidatePath(orgPath(ctx.org));
    return ok('Project updated.');
  });
}

/* -------------------------------------------------------------------------- */
/* deleteProject                                                               */
/* -------------------------------------------------------------------------- */

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
    if (!parsed.success) return fail(INVALID_INPUT, fieldMessages(parsed.error));

    const ctx = await requireProjectByKey(parsed.data.orgSlug, parsed.data.projectKey);
    requireRole(ctx, Role.ADMIN);

    if (parsed.data.confirmKey.trim().toUpperCase() !== ctx.project.key) {
      return fail(CONFIRM_MISMATCH, { confirmKey: CONFIRM_MISMATCH });
    }

    // Cascades through boards, columns, tickets and comments.
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

/* -------------------------------------------------------------------------- */
/* createBoard                                                                 */
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
    if (!parsed.success) return fail(INVALID_INPUT, fieldMessages(parsed.error));

    const ctx = await requireProjectByKey(parsed.data.orgSlug, parsed.data.projectKey);
    requireRole(ctx, Role.ADMIN);

    // One nested write: a board never exists without its three seeded columns.
    // Column CRUD is cut (SPEC 7.6), so this is the whole column model.
    const board = await prisma.board.create({
      data: {
        projectId: ctx.project.id,
        name: parsed.data.name,
        columns: {
          create: DEFAULT_COLUMNS.map((column) => ({
            name: column.name,
            position: column.position,
          })),
        },
      },
      select: { id: true, name: true },
    });

    revalidatePath(projectPath(ctx.org, ctx.project));
    nav.to = boardPath(ctx.org, ctx.project, board);
    return ok();
  });

  if (!result.ok) return result;
  if (nav.to) redirect(nav.to);
  return result;
}

/* -------------------------------------------------------------------------- */
/* renameBoard                                                                 */
/* -------------------------------------------------------------------------- */

const renameBoardSchema = z.object({
  boardId: cuid,
  name: boardNameSchema,
});

export async function renameBoard(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  return runAction(async () => {
    await requireUser();

    const parsed = renameBoardSchema.safeParse({
      boardId: formData.get('boardId'),
      name: formData.get('name'),
    });
    if (!parsed.success) return fail(INVALID_INPUT, fieldMessages(parsed.error));

    const ctx = await requireBoard(parsed.data.boardId);
    requireRole(ctx, Role.ADMIN);

    await prisma.board.updateMany({
      where: {
        id: ctx.board.id,
        project: { organization: { memberships: { some: { userId: ctx.user.id } } } },
      },
      data: { name: parsed.data.name },
    });

    revalidatePath(projectPath(ctx.org, ctx.project));
    revalidatePath(boardPath(ctx.org, ctx.project, ctx.board));
    return ok('Board renamed.');
  });
}

/* -------------------------------------------------------------------------- */
/* deleteBoard                                                                 */
/* -------------------------------------------------------------------------- */

const deleteBoardSchema = z.object({ boardId: cuid });

export async function deleteBoard(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  const nav: { to?: string } = {};

  const result = await runAction(async () => {
    await requireUser();

    const parsed = deleteBoardSchema.safeParse({ boardId: formData.get('boardId') });
    if (!parsed.success) return fail(INVALID_INPUT, fieldMessages(parsed.error));

    const ctx = await requireBoard(parsed.data.boardId);
    requireRole(ctx, Role.ADMIN);

    // Cascades through the board's columns, tickets and their comments.
    await prisma.board.deleteMany({
      where: {
        id: ctx.board.id,
        project: { organization: { memberships: { some: { userId: ctx.user.id } } } },
      },
    });

    revalidatePath(projectPath(ctx.org, ctx.project));
    nav.to = projectPath(ctx.org, ctx.project);
    return ok();
  });

  if (!result.ok) return result;
  if (nav.to) redirect(nav.to);
  return result;
}
