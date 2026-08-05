'use server';

/**
 * Access tokens for the MCP endpoint (`/api/mcp`).
 *
 * A token IS a session: same `Session` row, same sha256 storage, same 30-day
 * rolling expiry, same revocation. Nothing new is stored and nothing new can be
 * stolen — which also means a token carries the FULL rights of the person who
 * minted it, and the page says so out loud.
 */

import { revalidatePath } from 'next/cache';
import { z } from 'zod';

import { requireUser, runAction } from '@/lib/authz';
import { prisma } from '@/lib/db';
import { fail, ok, type ActionResult } from '@/lib/result';
import { createSession } from '@/lib/session';
import { cuid } from '@/lib/validation';

const INVALID_INPUT = 'Please check the form and try again.';

function field(formData: FormData, key: string): string {
  const value = formData.get(key);
  return typeof value === 'string' ? value : '';
}

export async function createMcpToken(
  _prev: ActionResult | null,
  _formData: FormData,
): Promise<ActionResult> {
  return runAction(async () => {
    const user = await requireUser();
    const { token } = await createSession(user.id);
    revalidatePath('/tokens');
    // The ONLY time the raw token exists outside the client's keeping: the
    // database holds sha256(token) and nothing else, so it cannot be shown twice.
    return ok(token);
  });
}

const revokeSchema = z.object({ sessionId: cuid });

export async function revokeSession(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  return runAction(async () => {
    const user = await requireUser();

    const parsed = revokeSchema.safeParse({ sessionId: field(formData, 'sessionId') });
    if (!parsed.success) return fail(INVALID_INPUT);

    // `userId` comes from the session, so this can only ever delete your own row;
    // a foreign id simply matches nothing.
    await prisma.session.deleteMany({ where: { id: parsed.data.sessionId, userId: user.id } });

    revalidatePath('/tokens');
    return ok('Revoked.');
  });
}
