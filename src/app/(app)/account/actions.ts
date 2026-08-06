'use server';

/**
 * `/account` -- per-type email notification preferences.
 *
 * Design: docs/superpowers/specs/2026-08-06-email-design.md
 *
 * These gate NOTIFICATIONS only. Security mail -- "your password was changed",
 * "a new MCP access token was created" -- ignores every switch here, because a
 * user who muted notifications has not consented to silent account takeover.
 *
 * The write is scoped by the session's own user id, so this action can only ever
 * change the caller's own row; there is no id in the form to forge.
 */

import { revalidatePath } from 'next/cache';
import { z } from 'zod';

import { requireUser, runAction } from '@/lib/authz';
import { prisma } from '@/lib/db';
import { ok, type ActionResult } from '@/lib/result';

/**
 * An unchecked checkbox submits NOTHING, so absence is the meaningful value and
 * every field defaults to `false`. Reading `=== 'on'` rather than "is present"
 * keeps a crafted `notifyAssigned=maybe` from being truthy.
 */
const preferencesSchema = z.object({
  notifyAssigned: z.literal('on').optional(),
  notifyComments: z.literal('on').optional(),
  notifyOrgMembership: z.literal('on').optional(),
});

export async function updateNotificationPreferences(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  return runAction(async () => {
    const user = await requireUser();

    const parsed = preferencesSchema.safeParse({
      notifyAssigned: formData.get('notifyAssigned') ?? undefined,
      notifyComments: formData.get('notifyComments') ?? undefined,
      notifyOrgMembership: formData.get('notifyOrgMembership') ?? undefined,
    });

    // Nothing here can fail in a way worth reporting: an unparseable value is
    // an unchecked box.
    const values = parsed.success ? parsed.data : {};

    await prisma.user.updateMany({
      where: { id: user.id },
      data: {
        notifyAssigned: values.notifyAssigned === 'on',
        notifyComments: values.notifyComments === 'on',
        notifyOrgMembership: values.notifyOrgMembership === 'on',
      },
    });

    revalidatePath('/account');
    return ok('Preferences saved.');
  });
}
