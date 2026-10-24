import type { ReactNode } from 'react';

/**
 * The calm, centred, single-column shell the signed-out pages use: the mark
 * and one form, card-less, as Linear's sign-in screen is -- nothing else is
 * actionable before you are signed in.
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
    <div className="flex min-h-dvh flex-col items-center justify-center gap-8 bg-primary px-4 py-12 sm:py-16">
      {/*
       * The app's own mark -- the three bars from `icon.svg` -- drawn in the
       * text colour, as Linear shows its logo on the login screen. Inline SVG:
       * no request, and it follows the theme. `aria-label` because it is the
       * only place the product is named before the form's heading.
       */}
      <svg viewBox="0 0 32 32" role="img" aria-label="Flone" className="size-10 text-primary">
        <rect x="3" y="5" width="6" height="22" rx="2" fill="currentColor" />
        <rect x="13" y="5" width="6" height="16" rx="2" fill="currentColor" />
        <rect x="23" y="5" width="6" height="11" rx="2" fill="currentColor" />
      </svg>

      {/* Linear's sign-in column is taller than the app's 32px controls. */}
      <main className="w-full max-w-[22rem] [&_button[type=submit]]:h-10 [&_input:not([type=checkbox]):not([type=radio]):not([type=hidden])]:h-10">
        {children}
      </main>
    </div>
  );
}
