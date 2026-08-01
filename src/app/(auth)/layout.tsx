import type { ReactNode } from 'react';
import { redirect } from 'next/navigation';
import { readSession } from '@/lib/session';

/**
 * SPEC 5 -- the auth shell.
 *
 * Calm, centered, single column. The only thing on screen is the form.
 *
 * A signed-in visitor is bounced to `/` so the sign-in and sign-up forms are
 * never reachable with a live session. This is UX, not authorization: the
 * Server Actions in `login/actions.ts` and `register/actions.ts` are directly
 * addressable POST endpoints and re-derive everything themselves.
 *
 * `readSession()` is used rather than `requireUser()` because the interesting
 * case here is the *absence* of a session, which must not throw.
 */
export const dynamic = 'force-dynamic';

export default async function AuthLayout({ children }: { children: ReactNode }) {
  const session = await readSession();
  if (session) redirect('/');

  return (
    <div className="auth-shell">
      <main className="container container-narrow stack">
        <div className="stack-sm">
          <span className="brand">Kanban</span>
          <p className="faint">A simple, secure board for small teams.</p>
        </div>
        {children}
      </main>
    </div>
  );
}
