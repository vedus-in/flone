'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { requireUser, runAction } from '@/lib/authz';
import { destroySession } from '@/lib/session';
import { ERRORS, ok, type ActionResult } from '@/lib/result';

/**
 * SPEC 6.3 -- the only action in the authenticated shell.
 *
 * Signing out is idempotent: a request whose session has already expired still
 * lands on `/login` rather than showing "You are signed out." on a page the user
 * can no longer see.
 */
export async function signOut(
  _prev: ActionResult | null,
  _formData: FormData,
): Promise<ActionResult> {
  const result = await runAction(async () => {
    await requireUser();
    await destroySession();
    revalidatePath('/', 'layout');
    return ok();
  });

  // A genuine failure (unexpected error) is reported; a missing session is not.
  if (!result.ok && result.error !== ERRORS.UNAUTHENTICATED) return result;

  // SPEC 6.1 rule 7: redirect() is called after the try/catch closes.
  redirect('/login');
}
