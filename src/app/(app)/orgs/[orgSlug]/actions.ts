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
  randomSlugSuffix,
  slugSchema,
  slugify,
  workspaceNameSchema,
} from '@/lib/validation';

/**
 * `createWorkspace`.
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
): Promise<WorkspaceRef | null> {
  try {
    return await prisma.workspace.create({
      data: { organizationId, name, slug },
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

    // Slug typed explicitly -> a collision is a field error, never a silent rename.
    if (parsed.data.slug) {
      const created = await createWorkspaceRow(ctx.org.id, name, parsed.data.slug);
      if (!created) return fail(SLUG_TAKEN, { slug: SLUG_TAKEN });
      revalidatePath('/', 'layout');
      nav.to = workspacePath(ctx.org, created);
      return ok();
    }

    const stem = slugify(name);
    const base =
      stem.length > STEM_BUDGET ? stem.slice(0, STEM_BUDGET).replace(/-+$/g, '') : stem;

    let created = await createWorkspaceRow(ctx.org.id, name, stem);
    for (let attempt = 0; attempt < RANDOM_SUFFIX_ATTEMPTS && !created; attempt += 1) {
      created = await createWorkspaceRow(ctx.org.id, name, `${base}-${randomSlugSuffix()}`);
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
