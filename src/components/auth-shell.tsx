import type { ReactNode } from 'react';

/**
 * The calm, centered, single-column shell the signed-out pages use: a small
 * wordmark and one card, because nothing else is actionable before you are
 * signed in.
 *
 * Extracted from `(auth)/layout.tsx` when `/invite` arrived. That route CANNOT
 * live in the `(auth)` group -- its layout bounces anyone with a session
 * straight to `/`, which would silently swallow an invitation clicked by
 * somebody who already has an account, the single most likely way an invite
 * link gets opened. So `/invite` sits at the top level with its own layout, and
 * both layouts render this.
 */
export function AuthShell({ children }: { children: ReactNode }) {
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
          className="grid size-10 place-items-center rounded-xl bg-brand-solid text-base font-semibold text-white"
        >
          K
        </span>
        <div className="flex flex-col gap-1">
          <span className="text-base font-semibold tracking-tight text-primary">Flone</span>
          <p className="text-sm text-tertiary">A simple, secure board for small teams.</p>
        </div>
      </header>

      <main className="w-full max-w-[26rem]">{children}</main>
    </div>
  );
}
