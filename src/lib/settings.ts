import 'server-only';
import { prisma } from '@/lib/db';

/**
 * Instance-wide settings -- the singleton `AppSetting` row.
 *
 * This is SITE administration, not tenant data: nothing in this file reads or
 * writes anything scoped to an Organization, and being a site admin grants no
 * access to any organization's projects, boards, tickets or comments. Callers
 * still authorize themselves through `requireAdmin()` in `@/lib/authz`.
 */

/** The `AppSetting.id` is pinned so the table can only ever hold one row. */
export const APP_SETTINGS_ID = 'singleton';

export type AppSettings = {
  registrationEnabled: boolean;
};

/**
 * Reads the singleton row, creating it if it is absent.
 *
 * Written as read-then-create rather than `upsert` on purpose: `AppSetting` has
 * an `@updatedAt` column, so an upsert with an empty update would rewrite the
 * row -- and bump the audit timestamp -- on every page view. The create is
 * racy by nature, so a lost race falls back to a re-read instead of throwing;
 * the row's contents are identical either way.
 */
export async function getAppSettings(): Promise<AppSettings> {
  const existing = await prisma.appSetting.findUnique({
    where: { id: APP_SETTINGS_ID },
    select: { registrationEnabled: true },
  });
  if (existing) return { registrationEnabled: existing.registrationEnabled };

  const created = await prisma.appSetting
    .create({
      data: { id: APP_SETTINGS_ID },
      select: { registrationEnabled: true },
    })
    .catch(() => null);
  if (created) return { registrationEnabled: created.registrationEnabled };

  const row = await prisma.appSetting.findUnique({
    where: { id: APP_SETTINGS_ID },
    select: { registrationEnabled: true },
  });
  // The schema default is `true`; falling back to it keeps a transient database
  // hiccup from silently locking the instance down.
  return { registrationEnabled: row?.registrationEnabled ?? true };
}

/**
 * True when the instance has at least one account.
 *
 * `findFirst` rather than `count`: this only ever needs existence, and the query
 * can stop at the first row.
 */
export async function hasAnyUser(): Promise<boolean> {
  const first = await prisma.user.findFirst({ select: { id: true } });
  return first !== null;
}

/**
 * THE single source of truth for "may someone register right now?".
 *
 * The register page and the register Server Action both call this, so the
 * cosmetic state of the page and the actual enforcement can never disagree.
 * The page is only cosmetic -- the action's own call is what enforces it.
 *
 * BOOTSTRAP EXCEPTION: with zero users, registration is open no matter what the
 * flag says. Without it, a disabled flag plus an empty user table would brick a
 * fresh instance permanently, with no way in and no one able to turn it back on.
 * The first account created this way is the one the register action marks
 * `isAdmin`.
 */
export async function isRegistrationOpen(): Promise<boolean> {
  const [settings, anyUser] = await Promise.all([getAppSettings(), hasAnyUser()]);
  return settings.registrationEnabled || !anyUser;
}

/**
 * Flips the flag and stamps who did it. `actingUserId` must come from the
 * session via `requireAdmin()`, never from the form.
 */
export async function setRegistrationEnabled(
  enabled: boolean,
  actingUserId: string,
): Promise<void> {
  await prisma.appSetting.upsert({
    where: { id: APP_SETTINGS_ID },
    update: { registrationEnabled: enabled, updatedById: actingUserId },
    create: { id: APP_SETTINGS_ID, registrationEnabled: enabled, updatedById: actingUserId },
  });
}
