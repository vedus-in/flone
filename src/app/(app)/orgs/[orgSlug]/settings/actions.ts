'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { Prisma, Role } from '@prisma/client';
import { z } from 'zod';
import { prisma } from '@/lib/db';
import {
  AuthzError,
  orgPath,
  orgSettingsPath,
  requireMembershipInOrg,
  requireOrgBySlug,
  requireRole,
  requireUser,
  runAction,
} from '@/lib/authz';
import { fail, ok, type ActionResult } from '@/lib/result';
import {
  assignableRoleSchema,
  cuid,
  emailSchema,
  orgNameSchema,
  roleSchema,
  slugSchema,
} from '@/lib/validation';

/**
 * SPEC 6.6 -- organization settings: members, rename, delete.
 *
 * Every action opens with `requireUser()` and then re-proves membership with
 * `requireOrgBySlug`, which also yields the caller's role. The `membershipId`
 * that arrives from the form is a lookup key only: `requireMembershipInOrg`
 * scopes it to the already-authorized organization, so a membership id from
 * another tenant is indistinguishable from one that does not exist.
 */

const INVALID_INPUT = 'Check the highlighted fields.';
const NO_ACCOUNT = 'No account with that email. Ask them to sign up first.';
const ALREADY_MEMBER = 'Already a member.';
const LAST_OWNER = 'An organization must have at least one owner.';
const SELF_ROLE = 'You cannot change your own role.';
const SELF_REMOVE = 'You cannot remove yourself.';
const CONFIRM_MISMATCH = 'The name you typed does not match.';

/** Thrown inside a transaction so the guard and the write are one unit. */
class LastOwnerError extends Error {}

function fieldMessages(error: z.ZodError): Record<string, string> {
  const out: Record<string, string> = {};
  for (const issue of error.issues) {
    const key = issue.path[0];
    if (typeof key === 'string' && !(key in out)) out[key] = issue.message;
  }
  return out;
}

/* -------------------------------------------------------------------------- */
/* addMember                                                                   */
/* -------------------------------------------------------------------------- */

const addMemberSchema = z.object({
  orgSlug: slugSchema,
  email: emailSchema,
  role: assignableRoleSchema,
});

export async function addMember(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  return runAction(async () => {
    await requireUser();

    const parsed = addMemberSchema.safeParse({
      orgSlug: formData.get('orgSlug'),
      email: formData.get('email'),
      role: formData.get('role'),
    });
    if (!parsed.success) return fail(INVALID_INPUT, fieldMessages(parsed.error));

    const ctx = await requireOrgBySlug(parsed.data.orgSlug);
    requireRole(ctx, Role.ADMIN);

    // `User` is not a tenant-scoped model, so a lookup by unique email is legal
    // here. SPEC 7.20 keeps the specific message: with no invite email, a generic
    // one makes the feature unusable, and the oracle is gated behind ADMIN.
    const target = await prisma.user.findUnique({
      where: { email: parsed.data.email },
      select: { id: true },
    });
    if (!target) return fail(NO_ACCOUNT, { email: NO_ACCOUNT });

    try {
      await prisma.membership.create({
        data: {
          organizationId: ctx.org.id,
          userId: target.id,
          role: parsed.data.role,
        },
        select: { id: true },
      });
    } catch (e) {
      // The (userId, organizationId) unique index makes the race harmless.
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
        return fail(ALREADY_MEMBER, { email: ALREADY_MEMBER });
      }
      throw e;
    }

    revalidatePath(orgSettingsPath(ctx.org));
    revalidatePath('/', 'layout');
    return ok('Member added.');
  });
}

/* -------------------------------------------------------------------------- */
/* changeMemberRole                                                            */
/* -------------------------------------------------------------------------- */

const changeRoleSchema = z.object({
  orgSlug: slugSchema,
  membershipId: cuid,
  role: roleSchema,
});

export async function changeMemberRole(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  return runAction(async () => {
    await requireUser();

    const parsed = changeRoleSchema.safeParse({
      orgSlug: formData.get('orgSlug'),
      membershipId: formData.get('membershipId'),
      role: formData.get('role'),
    });
    if (!parsed.success) return fail(INVALID_INPUT, fieldMessages(parsed.error));

    const ctx = await requireOrgBySlug(parsed.data.orgSlug);
    requireRole(ctx, Role.ADMIN);

    const target = await requireMembershipInOrg(ctx.org.id, parsed.data.membershipId);
    const nextRole = parsed.data.role;

    // Nobody changes their own role -- that is how an OWNER accidentally locks
    // themselves out of their own organization.
    if (target.userId === ctx.user.id) return fail(SELF_ROLE);

    // Only an OWNER may act on an OWNER row, or grant/revoke OWNER.
    if (target.role === Role.OWNER && ctx.role !== Role.OWNER) {
      throw new AuthzError('FORBIDDEN');
    }
    if (nextRole === Role.OWNER && ctx.role !== Role.OWNER) {
      throw new AuthzError('FORBIDDEN');
    }

    if (target.role === nextRole) return ok('No change.');

    try {
      await prisma.$transaction(async (tx) => {
        // Serialize every owner-mutating transaction for this organization on
        // the Organization row. `count` takes no row locks, so at Postgres'
        // default READ COMMITTED two concurrent demotions/removals each read
        // the other's pre-state, both see owners === 2, and both proceed --
        // leaving the org with zero OWNERs and permanently unrecoverable.
        await tx.$executeRaw`SELECT id FROM "Organization" WHERE id = ${ctx.org.id} FOR UPDATE`;

        // Re-read under the lock: `target.role` above is a pre-lock snapshot.
        const current = await tx.membership.findFirst({
          where: { id: target.id, organizationId: ctx.org.id },
          select: { role: true },
        });
        if (!current) throw new AuthzError('NOT_FOUND');

        // Re-check too, or an ADMIN could demote someone promoted to OWNER
        // between the snapshot and the lock.
        if (current.role === Role.OWNER && ctx.role !== Role.OWNER) {
          throw new AuthzError('FORBIDDEN');
        }
        if (current.role === nextRole) return;

        if (current.role === Role.OWNER) {
          const owners = await tx.membership.count({
            where: { organizationId: ctx.org.id, role: Role.OWNER },
          });
          if (owners <= 1) throw new LastOwnerError();
        }
        await tx.membership.updateMany({
          where: { id: target.id, organizationId: ctx.org.id },
          data: { role: nextRole },
        });
      });
    } catch (e) {
      if (e instanceof LastOwnerError) return fail(LAST_OWNER);
      throw e;
    }

    revalidatePath(orgSettingsPath(ctx.org));
    return ok('Role updated.');
  });
}

/* -------------------------------------------------------------------------- */
/* removeMember                                                                */
/* -------------------------------------------------------------------------- */

const removeMemberSchema = z.object({
  orgSlug: slugSchema,
  membershipId: cuid,
});

export async function removeMember(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  return runAction(async () => {
    await requireUser();

    const parsed = removeMemberSchema.safeParse({
      orgSlug: formData.get('orgSlug'),
      membershipId: formData.get('membershipId'),
    });
    if (!parsed.success) return fail(INVALID_INPUT, fieldMessages(parsed.error));

    const ctx = await requireOrgBySlug(parsed.data.orgSlug);
    requireRole(ctx, Role.ADMIN);

    const target = await requireMembershipInOrg(ctx.org.id, parsed.data.membershipId);

    // `leaveOrganization` is cut (SPEC 7.7), so this is the only way a membership
    // disappears -- and it refuses to act on the caller's own row.
    if (target.userId === ctx.user.id) return fail(SELF_REMOVE);

    if (target.role === Role.OWNER && ctx.role !== Role.OWNER) {
      throw new AuthzError('FORBIDDEN');
    }

    try {
      await prisma.$transaction(async (tx) => {
        // Same lock as changeMemberRole, and it must be the SAME row for both:
        // that is what makes a concurrent "demote the other owner" and
        // "remove the other owner" serialize instead of both succeeding.
        await tx.$executeRaw`SELECT id FROM "Organization" WHERE id = ${ctx.org.id} FOR UPDATE`;

        const current = await tx.membership.findFirst({
          where: { id: target.id, organizationId: ctx.org.id },
          select: { role: true },
        });
        // Already gone: a concurrent remove won the race. Nothing left to do.
        if (!current) return;

        if (current.role === Role.OWNER && ctx.role !== Role.OWNER) {
          throw new AuthzError('FORBIDDEN');
        }

        if (current.role === Role.OWNER) {
          const owners = await tx.membership.count({
            where: { organizationId: ctx.org.id, role: Role.OWNER },
          });
          if (owners <= 1) throw new LastOwnerError();
        }
        await tx.membership.deleteMany({
          where: { id: target.id, organizationId: ctx.org.id },
        });
      });
    } catch (e) {
      if (e instanceof LastOwnerError) return fail(LAST_OWNER);
      throw e;
    }

    revalidatePath(orgSettingsPath(ctx.org));
    revalidatePath('/', 'layout');
    return ok('Member removed.');
  });
}

/* -------------------------------------------------------------------------- */
/* renameOrganization                                                          */
/* -------------------------------------------------------------------------- */

const renameSchema = z.object({
  orgSlug: slugSchema,
  name: orgNameSchema,
});

export async function renameOrganization(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  return runAction(async () => {
    await requireUser();

    const parsed = renameSchema.safeParse({
      orgSlug: formData.get('orgSlug'),
      name: formData.get('name'),
    });
    if (!parsed.success) return fail(INVALID_INPUT, fieldMessages(parsed.error));

    const ctx = await requireOrgBySlug(parsed.data.orgSlug);
    requireRole(ctx, Role.ADMIN);

    // The slug is deliberately immutable: renaming must never break links.
    await prisma.organization.updateMany({
      where: {
        id: ctx.org.id,
        memberships: { some: { userId: ctx.user.id } },
      },
      data: { name: parsed.data.name },
    });

    revalidatePath('/', 'layout');
    return ok('Organization renamed.');
  });
}

/* -------------------------------------------------------------------------- */
/* deleteOrganization                                                          */
/* -------------------------------------------------------------------------- */

const deleteSchema = z.object({
  orgSlug: slugSchema,
  confirmName: z.string().max(200),
});

export async function deleteOrganization(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  const result = await runAction(async () => {
    await requireUser();

    const parsed = deleteSchema.safeParse({
      orgSlug: formData.get('orgSlug'),
      confirmName: formData.get('confirmName'),
    });
    if (!parsed.success) return fail(INVALID_INPUT, fieldMessages(parsed.error));

    const ctx = await requireOrgBySlug(parsed.data.orgSlug);
    requireRole(ctx, Role.OWNER);

    if (parsed.data.confirmName.trim() !== ctx.org.name) {
      return fail(CONFIRM_MISMATCH, { confirmName: CONFIRM_MISMATCH });
    }

    // The tenant tree cascades: memberships, projects, boards, columns, tickets
    // and comments all go with it.
    await prisma.organization.deleteMany({
      where: {
        id: ctx.org.id,
        memberships: { some: { userId: ctx.user.id, role: Role.OWNER } },
      },
    });

    revalidatePath('/', 'layout');
    revalidatePath(orgPath(ctx.org));
    return ok();
  });

  if (!result.ok) return result;
  redirect('/');
}
