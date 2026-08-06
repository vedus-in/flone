import type { ReactNode } from 'react';
import { redirect } from 'next/navigation';
import { AuthShell } from '@/components/auth-shell';
import { readSession } from '@/lib/session';

/**
 * SPEC 5 -- the auth shell.
 *
 * Calm, centered, single column: a small wordmark and one card. Nothing else is
 * on screen, because nothing else is actionable before you are signed in.
 *
 * A signed-in visitor is bounced to `/` so the sign-in and sign-up forms are
 * never reachable with a live session. This is UX, not authorization: the
 * Server Actions in `login/actions.ts` and `register/actions.ts` are directly
 * addressable POST endpoints and re-derive everything themselves.
 *
 * `readSession()` is used rather than `requireUser()` because the interesting
 * case here is the *absence* of a session, which must not throw.
 *
 * This stays a Server Component. Untitled UI ships `'use client'` inside each of
 * its own component modules, so the pages below can render them directly without
 * a provider and without becoming client modules themselves.
 */
export const dynamic = 'force-dynamic';

export default async function AuthLayout({ children }: { children: ReactNode }) {
  const session = await readSession();
  if (session) redirect('/');

  return <AuthShell>{children}</AuthShell>;
}
