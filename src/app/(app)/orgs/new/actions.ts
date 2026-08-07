'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { Prisma, Role } from '@prisma/client';
import { z } from 'zod';
import { prisma } from '@/lib/db';
import { orgPath, requireUser, runAction, type OrgRef } from '@/lib/authz';
import { fail, ok, type ActionResult } from '@/lib/result';
import {
  DEFAULT_WORKSPACE,
  orgNameSchema,
  randomSlugSuffix,
  slugSchema,
  slugify,
} from '@/lib/validation';

/**
 * SPEC 6.4 -- `createOrganization`.
 *
 * The caller becomes OWNER of the organization they create. That is the only
 * place an OWNER membership is minted without an existing OWNER's approval, and
 * it is safe because the organization did not exist a moment earlier.
 */

/* Closed, user-meaningful literals (SPEC 4.11). Never a Prisma message. */
const INVALID_INPUT = 'Check the highlighted fields.';
const SLUG_TAKEN = 'That URL is taken.';
const NO_SLUG_AVAILABLE = 'Could not pick a URL for that name. Choose one yourself.';

const RANDOM_SUFFIX_ATTEMPTS = 5;
/** 40-char slug budget minus a dash and four random base36 characters. */
const STEM_BUDGET = 34;

const schema = z.object({
  name: orgNameSchema,
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
 * One atomic nested write: Prisma wraps a nested `create` in a transaction, so an
 * organization can never exist without its owner's membership -- nor without its
 * default workspace. That workspace is not a nicety: `Project.workspaceId` is
 * required, so an organization created without one has nowhere to put a project
 * and its "New project" form would fail on every submit.
 *
 * Returns `null` -- never throws -- when the slug is taken, so the caller can
 * decide between "retry with a random suffix" and "tell the user".
 */
async function createOrg(userId: string, name: string, slug: string): Promise<OrgRef | null> {
  try {
    return await prisma.organization.create({
      data: {
        name,
        slug,
        memberships: { create: { userId, role: Role.OWNER } },
        workspaces: { create: { ...DEFAULT_WORKSPACE } },
      },
      select: { id: true, name: true, slug: true },
    });
  } catch (e) {
    if (isUniqueViolation(e)) return null;
    throw e;
  }
}

export async function createOrganization(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  const nav: { to?: string } = {};

  const result = await runAction(async () => {
    const user = await requireUser();

    // A blank "advanced" slug field means "derive one", not "an empty slug".
    const rawSlug = formData.get('slug');
    const slugInput =
      typeof rawSlug === 'string' && rawSlug.trim().length > 0 ? rawSlug : undefined;

    const parsed = schema.safeParse({ name: formData.get('name'), slug: slugInput });
    if (!parsed.success) return fail(INVALID_INPUT, fieldMessages(parsed.error));

    const { name } = parsed.data;

    // Slug typed explicitly -> a collision is a field error, never a silent rename.
    if (parsed.data.slug) {
      const created = await createOrg(user.id, name, parsed.data.slug);
      if (!created) return fail(SLUG_TAKEN, { slug: SLUG_TAKEN });
      revalidatePath('/', 'layout');
      nav.to = orgPath(created);
      return ok();
    }

    // Derived slug. An incrementing -2 / -3 suffix is forbidden (SPEC 7.14): it
    // turns the global slug index into an enumeration oracle for other tenants'
    // organization names. Random base36 removes the signal at zero cost.
    const stem = slugify(name);
    const base =
      stem.length > STEM_BUDGET ? stem.slice(0, STEM_BUDGET).replace(/-+$/g, '') : stem;

    let created = await createOrg(user.id, name, stem);
    for (let attempt = 0; attempt < RANDOM_SUFFIX_ATTEMPTS && !created; attempt += 1) {
      created = await createOrg(user.id, name, `${base}-${randomSlugSuffix()}`);
    }
    if (!created) return fail(NO_SLUG_AVAILABLE, { slug: NO_SLUG_AVAILABLE });

    revalidatePath('/', 'layout');
    nav.to = orgPath(created);
    return ok();
  });

  if (!result.ok) return result;
  if (nav.to) redirect(nav.to);
  return result;
}
