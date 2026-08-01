'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { prisma } from '@/lib/db';
import { AuthzError, requireAdmin, runAction } from '@/lib/authz';
import { fail, ok, type ActionResult } from '@/lib/result';
import { APP_SETTINGS_ID, getAppSettings, setRegistrationEnabled } from '@/lib/settings';
import { cuid } from '@/lib/validation';

/**
 * Site administration -- instance-wide settings and the admin roster.
 *
 * SCOPE, deliberately: `User.isAdmin` governs THE INSTANCE (who may register,
 * who else is an admin). It is NOT tenant access and nothing in this file reads
 * or writes an Organization, Project, Board, Ticket or Comment. `requireAdmin()`
 * answers "is the CALLER an admin?" and never "may the caller see this
 * resource?" -- org scoping elsewhere is untouched.
 *
 * Both actions re-derive the session themselves via `requireAdmin()`. The (app)
 * layout's auth gate is UX only: Server Actions are directly addressable POST
 * endpoints that no layout runs for.
 *
 * Nothing here selects `passwordHash`, `Session.tokenHash`, or any other secret;
 * the page renders only the columns it lists.
 */

/** Revalidation targets. `/register` reads the same flag, so it must refresh too. */
const ADMIN_PATH = '/admin';
const REGISTER_PATH = '/register';

const INVALID_INPUT = 'Check the highlighted fields.';
const LAST_ADMIN = 'This instance must keep at least one site administrator.';
const SELF_REVOKE = 'You cannot revoke your own administrator access.';

/** Thrown inside the transaction so the guard and the write are one unit. */
class LastAdminError extends Error {}

/**
 * The wire format for a boolean is an explicit `'true'` / `'false'` string, not
 * checkbox presence: an unchecked checkbox is simply absent from the FormData,
 * which makes "the field was missing" and "the user asked for false"
 * indistinguishable. A dropped or malformed field must fail validation, not
 * silently close registration.
 */
const booleanField = z.enum(['true', 'false']).transform((value) => value === 'true');

/* -------------------------------------------------------------------------- */
/* setRegistration                                                             */
/* -------------------------------------------------------------------------- */

const setRegistrationSchema = z.object({ enabled: booleanField });

/**
 * Flips the instance-wide registration flag.
 *
 * This action -- together with the identical check inside the register action --
 * is what actually enforces a closed instance. The register PAGE only decides
 * what to draw.
 *
 * Note there is no "you have locked yourself out" hazard here: `isRegistrationOpen()`
 * re-opens registration whenever the user table is empty, so a disabled flag can
 * never brick a fresh deployment.
 */
export async function setRegistration(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  return runAction(async () => {
    const admin = await requireAdmin();

    const parsed = setRegistrationSchema.safeParse({ enabled: formData.get('enabled') });
    // The only input is machine-generated and hidden, so there is no field for a
    // field-level message to attach to.
    if (!parsed.success) return fail(INVALID_INPUT);

    // `admin.id` comes from the session, never from the form.
    await setRegistrationEnabled(parsed.data.enabled, admin.id);

    revalidatePath(ADMIN_PATH);
    revalidatePath(REGISTER_PATH);
    return ok(parsed.data.enabled ? 'Registration is open.' : 'Registration is closed.');
  });
}

/* -------------------------------------------------------------------------- */
/* setUserAdmin                                                                */
/* -------------------------------------------------------------------------- */

const setUserAdminSchema = z.object({ userId: cuid, isAdmin: booleanField });

/**
 * Grants or revokes site-admin on another account.
 *
 * Two invariants, both enforced here rather than in the UI:
 *
 *   1. Nobody revokes their own flag. That is the single easiest way to lock
 *      yourself out of the instance, and it is checked against the session id.
 *   2. The last remaining admin cannot be removed -- and it is enforced the same
 *      way the last-OWNER rule is, under a real row lock.
 *
 * The lock deserves a word. `count()` takes no row locks, so at Postgres'
 * default READ COMMITTED two concurrent revocations each read the other's
 * pre-state, both see admins === 2, and both proceed: zero admins, permanently
 * unrecoverable. Locking the TARGET user row would not help either, because two
 * concurrent revocations target two DIFFERENT rows and so never contend. The
 * lock therefore has to be one row shared by every admin-mutating transaction on
 * this instance -- the `AppSetting` singleton, which is exactly the
 * instance-level analogue of the Organization row used by the org settings
 * actions.
 */
export async function setUserAdmin(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  return runAction(async () => {
    const admin = await requireAdmin();

    const parsed = setUserAdminSchema.safeParse({
      userId: formData.get('userId'),
      isAdmin: formData.get('isAdmin'),
    });
    if (!parsed.success) return fail(INVALID_INPUT);

    const { userId, isAdmin: nextIsAdmin } = parsed.data;

    // Compared against the session id, so a forged `userId` cannot route around it.
    if (userId === admin.id && !nextIsAdmin) return fail(SELF_REVOKE);

    // `SELECT ... FOR UPDATE` over zero rows locks nothing, so make sure the row
    // the transaction below serializes on actually exists. `getAppSettings()` is
    // idempotent and creates it if it is missing.
    await getAppSettings();

    let changed = false;
    try {
      await prisma.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT id FROM "AppSetting" WHERE id = ${APP_SETTINGS_ID} FOR UPDATE`;

        // Re-read under the lock: anything read before it is a stale snapshot.
        const current = await tx.user.findUnique({
          where: { id: userId },
          select: { isAdmin: true },
        });
        if (!current) throw new AuthzError('NOT_FOUND');
        if (current.isAdmin === nextIsAdmin) return;

        if (!nextIsAdmin) {
          const admins = await tx.user.count({ where: { isAdmin: true } });
          if (admins <= 1) throw new LastAdminError();
        }

        await tx.user.update({
          where: { id: userId },
          data: { isAdmin: nextIsAdmin },
          select: { id: true },
        });
        changed = true;
      });
    } catch (e) {
      if (e instanceof LastAdminError) return fail(LAST_ADMIN);
      throw e;
    }

    if (!changed) return ok('No change.');

    revalidatePath(ADMIN_PATH);
    return ok(nextIsAdmin ? 'Administrator access granted.' : 'Administrator access revoked.');
  });
}
