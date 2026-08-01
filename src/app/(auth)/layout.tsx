import type { ReactNode } from 'react';
import { redirect } from 'next/navigation';
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
 * This stays a Server Component. HeroUI ships `'use client'` inside each of its
 * own component modules, so the pages below can render HeroUI directly without
 * a provider and without becoming client modules themselves.
 */
export const dynamic = 'force-dynamic';

export default async function AuthLayout({ children }: { children: ReactNode }) {
  const session = await readSession();
  if (session) redirect('/');

  return (
    <div className="flex min-h-dvh flex-col items-center justify-center gap-8 px-4 py-12 sm:py-16">
      <header className="flex flex-col items-center gap-3 text-center">
        {/*
         * A letter mark, not an icon font and not an emoji: one element, no
         * network request, and it inherits the theme's accent tokens in both
         * light and dark. `aria-hidden` because the wordmark beneath it already
         * says the name.
         */}
        <span
          aria-hidden="true"
          className="grid size-10 place-items-center rounded-xl bg-accent text-base font-semibold text-accent-foreground"
        >
          K
        </span>
        <div className="flex flex-col gap-1">
          <span className="text-base font-semibold tracking-tight text-foreground">Kanban</span>
          <p className="text-sm text-muted">A simple, secure board for small teams.</p>
        </div>
      </header>

      <main className="w-full max-w-[26rem]">{children}</main>
    </div>
  );
}
