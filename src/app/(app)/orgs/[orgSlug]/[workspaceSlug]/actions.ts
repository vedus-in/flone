'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { Prisma, Role } from '@prisma/client';
import { z } from 'zod';
import { prisma } from '@/lib/db';
import {
  orgPath,
  projectPath,
  requireRole,
  requireUser,
  requireWorkspaceBySlug,
  runAction,
  workspacePath,
} from '@/lib/authz';
import { fail, ok, type ActionResult } from '@/lib/result';
import {
  DEFAULT_STATES,
  deriveProjectKey,
  projectDescriptionSchema,
  projectKeySchema,
  projectNameSchema,
  slugSchema,
  workspaceNameSchema,
} from '@/lib/validation';

/**
 * Workspace-scoped actions: creating projects inside a workspace, and the
 * workspace's own rename / delete.
 *
 * `orgSlug` and `workspaceSlug` arrive in FormData as routing keys, never as
 * identity: `requireWorkspaceBySlug` re-proves membership through the
 * organization before either is used for anything.
 */

const INVALID_INPUT = 'Check the highlighted fields.';
const KEY_TAKEN = 'That key is already in use.';
const WORKSPACE_NOT_EMPTY =
  'Move or delete this workspace’s projects before deleting it.';

const projectSchema = z.object({
  orgSlug: slugSchema,
  workspaceSlug: slugSchema,
  name: projectNameSchema,
  key: projectKeySchema.optional(),
  description: projectDescriptionSchema.optional(),
});

const renameSchema = z.object({
  orgSlug: slugSchema,
  workspaceSlug: slugSchema,
  name: workspaceNameSchema,
});

const deleteSchema = z.object({
  orgSlug: slugSchema,
  workspaceSlug: slugSchema,
  confirmName: z.string(),
});

function fieldMessages(error: z.ZodError): Record<string, string> {
  const out: Record<string, string> = {};
  for (const issue of error.issues) {
    const key = issue.path[0];
    if (typeof key === 'string' && !(key in out)) out[key] = issue.message;
  }
  return out;
}

/** Blank optional text inputs arrive as `''`; treat them as absent. */
function optionalField(formData: FormData, name: string): string | undefined {
  const raw = formData.get(name);
  return typeof raw === 'string' && raw.trim().length > 0 ? raw : undefined;
}

export async function createProject(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  const nav: { to?: string } = {};

  const result = await runAction(async () => {
    await requireUser();

    const parsed = projectSchema.safeParse({
      orgSlug: formData.get('orgSlug'),
      workspaceSlug: formData.get('workspaceSlug'),
      name: formData.get('name'),
      key: optionalField(formData, 'key'),
      description: optionalField(formData, 'description'),
    });
    if (!parsed.success) return fail(INVALID_INPUT, fieldMessages(parsed.error));

    const ctx = await requireWorkspaceBySlug(parsed.data.orgSlug, parsed.data.workspaceSlug);
    requireRole(ctx, Role.ADMIN);

    const { name } = parsed.data;
    const key = parsed.data.key ?? deriveProjectKey(name);
    const description = parsed.data.description ?? null;

    try {
      // One nested write, so a project can never exist without its workflow
      // states. Prisma wraps nested creates in a transaction.
      //
      // The states hang off the PROJECT now, not off a board -- and no board is
      // created here at all. A board is Linear's "project": an optional grouping
      // you make when you have something to group, not a container every issue
      // has to be filed into on day one.
      //
      // `organizationId` is written from the workspace's own org, never from the
      // form: the key's uniqueness is scoped to the organization, so letting the
      // two disagree would put a project in one tenant's key namespace and
      // another's workspace.
      const project = await prisma.project.create({
        data: {
          organizationId: ctx.org.id,
          workspaceId: ctx.workspace.id,
          name,
          key,
          description,
          states: { create: DEFAULT_STATES.map((state) => ({ ...state })) },
        },
        select: { id: true, name: true, key: true, description: true },
      });

      revalidatePath('/', 'layout');
      revalidatePath(orgPath(ctx.org));
      revalidatePath(workspacePath(ctx.org, ctx.workspace));
      nav.to = projectPath(ctx.org, { ...project, workspaceSlug: ctx.workspace.slug });
      return ok();
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
        return fail(KEY_TAKEN, { key: KEY_TAKEN });
      }
      throw e;
    }
  });

  if (!result.ok) return result;
  if (nav.to) redirect(nav.to);
  return result;
}

export async function renameWorkspace(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  return runAction(async () => {
    await requireUser();

    const parsed = renameSchema.safeParse({
      orgSlug: formData.get('orgSlug'),
      workspaceSlug: formData.get('workspaceSlug'),
      name: formData.get('name'),
    });
    if (!parsed.success) return fail(INVALID_INPUT, fieldMessages(parsed.error));

    const ctx = await requireWorkspaceBySlug(parsed.data.orgSlug, parsed.data.workspaceSlug);
    requireRole(ctx, Role.ADMIN);

    // The slug is immutable, exactly as `Project.key` is: it is the URL segment
    // for the workspace and for every project inside it, so rewriting it would
    // break every link anyone has saved. The display name is free to change.
    await prisma.workspace.updateMany({
      where: {
        id: ctx.workspace.id,
        organization: { memberships: { some: { userId: ctx.user.id } } },
      },
      data: { name: parsed.data.name },
    });

    revalidatePath('/', 'layout');
    revalidatePath(orgPath(ctx.org));
    revalidatePath(workspacePath(ctx.org, ctx.workspace));
    return ok('Workspace updated.');
  });
}

export async function deleteWorkspace(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  const nav: { to?: string } = {};

  const result = await runAction(async () => {
    await requireUser();

    const parsed = deleteSchema.safeParse({
      orgSlug: formData.get('orgSlug'),
      workspaceSlug: formData.get('workspaceSlug'),
      confirmName: formData.get('confirmName'),
    });
    if (!parsed.success) return fail(INVALID_INPUT, fieldMessages(parsed.error));

    const ctx = await requireWorkspaceBySlug(parsed.data.orgSlug, parsed.data.workspaceSlug);
    requireRole(ctx, Role.OWNER);

    if (parsed.data.confirmName.trim() !== ctx.workspace.name) {
      return fail(INVALID_INPUT, { confirmName: 'That does not match the workspace name.' });
    }

    // Checked here for the message, enforced by the schema's RESTRICT foreign
    // key regardless. The check is UX; the constraint is the guarantee, and it
    // is what stops a race between this count and the delete from taking a
    // project -- and every issue in it -- with the workspace.
    const projects = await prisma.project.count({ where: { workspaceId: ctx.workspace.id } });
    if (projects > 0) return fail(WORKSPACE_NOT_EMPTY);

    try {
      await prisma.workspace.deleteMany({
        where: {
          id: ctx.workspace.id,
          organization: { memberships: { some: { userId: ctx.user.id } } },
        },
      });
    } catch (e) {
      // P2003: a project was created between the count and the delete.
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2003') {
        return fail(WORKSPACE_NOT_EMPTY);
      }
      throw e;
    }

    revalidatePath('/', 'layout');
    revalidatePath(orgPath(ctx.org));
    nav.to = orgPath(ctx.org);
    return ok();
  });

  if (!result.ok) return result;
  if (nav.to) redirect(nav.to);
  return result;
}
