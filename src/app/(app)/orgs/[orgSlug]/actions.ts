'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { Prisma, Role } from '@prisma/client';
import { z } from 'zod';
import { prisma } from '@/lib/db';
import {
  orgPath,
  requireOrgBySlug,
  requireRole,
  requireUser,
  runAction,
  workspacePath,
  type WorkspaceRef,
} from '@/lib/authz';
import { fail, ok, type ActionResult } from '@/lib/result';
import {
  cuid,
  randomSlugSuffix,
  slugSchema,
  slugify,
  WORKSPACE_ORDER,
  workspaceNameSchema,
} from '@/lib/validation';

/**
 * `createWorkspace` and `moveWorkspace`.
 *
 * `orgSlug` arriving in FormData is not a trust violation: it is a routing key,
 * and `requireOrgBySlug` re-proves membership (and yields the caller's role)
 * before it is used for anything. It is never identity.
 *
 * A workspace groups projects and owns nothing else, so creating one is gated at
 * ADMIN -- the same bar as creating the projects that will live in it.
 */

const INVALID_INPUT = 'Check the highlighted fields.';
const SLUG_TAKEN = 'That URL is taken in this organization.';
const NO_SLUG_AVAILABLE = 'Could not pick a URL for that name. Choose one yourself.';

const RANDOM_SUFFIX_ATTEMPTS = 5;
/** 40-char slug budget minus a dash and four random base36 characters. */
const STEM_BUDGET = 34;

const schema = z.object({
  orgSlug: slugSchema,
  name: workspaceNameSchema,
  slug: slugSchema.optional(),
});

function fieldMessages(error: z.ZodError): Record<string, string> {
  const out: Record<string, string> = {};
  for (const issue of error.issues) {
    const key = issue.path[0];
    if (typeof key === 'string' && !(key in out)) out[key] = issue.message;
  }
  return out;
}

function isUniqueViolation(e: unknown): boolean {
  return e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002';
}

/**
 * Returns `null` -- never throws -- when the slug is taken, so the caller can
 * decide between "retry with a random suffix" and "tell the user".
 *
 * Unlike an organization slug, a workspace slug is unique per organization, so a
 * collision here leaks only a name the caller can already see in their own
 * sidebar. The random suffix is kept anyway for the derived path, because a
 * silent `-2` is a worse experience than a random one either way.
 */
async function createWorkspaceRow(
  organizationId: string,
  name: string,
  slug: string,
  position: number,
): Promise<WorkspaceRef | null> {
  try {
    return await prisma.workspace.create({
      data: { organizationId, name, slug, position },
      select: { id: true, name: true, slug: true },
    });
  } catch (e) {
    if (isUniqueViolation(e)) return null;
    throw e;
  }
}

export async function createWorkspace(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  const nav: { to?: string } = {};

  const result = await runAction(async () => {
    await requireUser();

    // A blank "advanced" slug field means "derive one", not "an empty slug".
    const rawSlug = formData.get('slug');
    const slugInput =
      typeof rawSlug === 'string' && rawSlug.trim().length > 0 ? rawSlug : undefined;

    const parsed = schema.safeParse({
      orgSlug: formData.get('orgSlug'),
      name: formData.get('name'),
      slug: slugInput,
    });
    if (!parsed.success) return fail(INVALID_INPUT, fieldMessages(parsed.error));

    const ctx = await requireOrgBySlug(parsed.data.orgSlug);
    requireRole(ctx, Role.ADMIN);

    const { name } = parsed.data;

    // A new workspace lands at the END of the arranged order, never in the
    // middle of someone's priorities.
    const highest = await prisma.workspace.aggregate({
      where: { organizationId: ctx.org.id },
      _max: { position: true },
    });
    const position = (highest._max.position ?? -1) + 1;

    // Slug typed explicitly -> a collision is a field error, never a silent rename.
    if (parsed.data.slug) {
      const created = await createWorkspaceRow(ctx.org.id, name, parsed.data.slug, position);
      if (!created) return fail(SLUG_TAKEN, { slug: SLUG_TAKEN });
      revalidatePath('/', 'layout');
      nav.to = workspacePath(ctx.org, created);
      return ok();
    }

    const stem = slugify(name);
    const base =
      stem.length > STEM_BUDGET ? stem.slice(0, STEM_BUDGET).replace(/-+$/g, '') : stem;

    let created = await createWorkspaceRow(ctx.org.id, name, stem, position);
    for (let attempt = 0; attempt < RANDOM_SUFFIX_ATTEMPTS && !created; attempt += 1) {
      created = await createWorkspaceRow(
        ctx.org.id,
        name,
        `${base}-${randomSlugSuffix()}`,
        position,
      );
    }
    if (!created) return fail(NO_SLUG_AVAILABLE, { slug: NO_SLUG_AVAILABLE });

    revalidatePath('/', 'layout');
    revalidatePath(orgPath(ctx.org));
    nav.to = workspacePath(ctx.org, created);
    return ok();
  });

  if (!result.ok) return result;
  if (nav.to) redirect(nav.to);
  return result;
}

const moveWorkspaceSchema = z.object({
  orgSlug: slugSchema,
  workspaceId: cuid,
  direction: z.enum(['up', 'down']),
});

/**
 * Nudge a workspace one place along the sidebar order.
 *
 * Two buttons rather than drag-and-drop, exactly like `moveState`: a handful of
 * rows arranged once, and this works on a phone, from the keyboard, and before
 * hydration.
 *
 * ADMIN, the same bar as creating one, because the order is the ORGANIZATION's
 * -- every member sees the arrangement, so it is not a personal preference.
 *
 * The whole list is renumbered densely inside the transaction rather than two
 * positions swapped: every row predating the column sits at 0, so ties are the
 * normal case here, and swapping two tied rows moves nothing.
 */
export async function moveWorkspace(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  return runAction(async () => {
    await requireUser();

    const parsed = moveWorkspaceSchema.safeParse({
      orgSlug: formData.get('orgSlug'),
      workspaceId: formData.get('workspaceId'),
      direction: formData.get('direction'),
    });
    if (!parsed.success) return fail(INVALID_INPUT, fieldMessages(parsed.error));

    const ctx = await requireOrgBySlug(parsed.data.orgSlug);
    requireRole(ctx, Role.ADMIN);

    // Scoped to the organization the membership walk yielded, so a workspace id
    // from another tenant simply is not in this list -- see the miss below.
    const workspaces = await prisma.workspace.findMany({
      where: { organizationId: ctx.org.id },
      orderBy: WORKSPACE_ORDER,
      select: { id: true, position: true },
    });

    const index = workspaces.findIndex((workspace) => workspace.id === parsed.data.workspaceId);
    const swapWith = parsed.data.direction === 'up' ? index - 1 : index + 1;
    // Not in this organization, or already at the edge: a no-op, not an error.
    if (index === -1 || swapWith < 0 || swapWith >= workspaces.length) return ok();

    const reordered = workspaces.slice();
    const moved = reordered[index];
    reordered[index] = reordered[swapWith];
    reordered[swapWith] = moved;

    await prisma.$transaction(
      reordered
        .map((workspace, position) => ({ id: workspace.id, position, was: workspace.position }))
        .filter((row) => row.was !== row.position)
        // Ascending id, like every other multi-row write here, so two concurrent
        // reorders cannot take locks in opposite orders and deadlock.
        .sort((a, b) => (a.id < b.id ? -1 : 1))
        .map((row) =>
          prisma.workspace.update({ where: { id: row.id }, data: { position: row.position } }),
        ),
    );

    // The sidebar is rendered by the layout, so it needs the layout revalidated
    // as well as this page -- same pair `createWorkspace` uses.
    revalidatePath('/', 'layout');
    revalidatePath(orgPath(ctx.org));
    return ok();
  });
}
