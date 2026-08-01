'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { Prisma, Role } from '@prisma/client';
import { z } from 'zod';
import { prisma } from '@/lib/db';
import {
  orgPath,
  projectPath,
  requireOrgBySlug,
  requireRole,
  requireUser,
  runAction,
} from '@/lib/authz';
import { fail, ok, type ActionResult } from '@/lib/result';
import {
  DEFAULT_COLUMNS,
  deriveProjectKey,
  projectDescriptionSchema,
  projectKeySchema,
  projectNameSchema,
  slugSchema,
} from '@/lib/validation';

/**
 * SPEC 6.5 -- `createProject`.
 *
 * `orgSlug` arriving in FormData is not a trust violation: it is a routing key,
 * and `requireOrgBySlug` re-proves membership (and yields the caller's role)
 * before it is used for anything. It is never identity.
 */

const INVALID_INPUT = 'Check the highlighted fields.';
const KEY_TAKEN = 'That key is already in use.';

const schema = z.object({
  orgSlug: slugSchema,
  name: projectNameSchema,
  key: projectKeySchema.optional(),
  description: projectDescriptionSchema.optional(),
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

    const parsed = schema.safeParse({
      orgSlug: formData.get('orgSlug'),
      name: formData.get('name'),
      key: optionalField(formData, 'key'),
      description: optionalField(formData, 'description'),
    });
    if (!parsed.success) return fail(INVALID_INPUT, fieldMessages(parsed.error));

    const ctx = await requireOrgBySlug(parsed.data.orgSlug);
    requireRole(ctx, Role.ADMIN);

    const { name } = parsed.data;
    const key = parsed.data.key ?? deriveProjectKey(name);
    const description = parsed.data.description ?? null;

    try {
      // One nested write, so a project can never exist without a board and its
      // three seeded columns. Prisma wraps nested creates in a transaction.
      const project = await prisma.project.create({
        data: {
          organizationId: ctx.org.id,
          name,
          key,
          description,
          boards: {
            create: {
              name: 'Main',
              columns: {
                create: DEFAULT_COLUMNS.map((column) => ({
                  name: column.name,
                  position: column.position,
                })),
              },
            },
          },
        },
        select: { id: true, name: true, key: true, description: true },
      });

      revalidatePath(orgPath(ctx.org));
      nav.to = projectPath(ctx.org, project);
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
