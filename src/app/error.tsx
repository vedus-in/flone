'use client';

import { Button, ButtonLink } from '@/components/ui';

/**
 * The app-wide error boundary.
 *
 * It renders FIXED, GENERIC copy. `error.message` and `error.stack` are never
 * read -- a thrown Prisma error, a validation internal or a `where`-clause bug
 * must not become a user-visible (or attacker-visible) string. The only value
 * surfaced is `error.digest`: an opaque hash Next generates so a report can be
 * correlated with the server log line, carrying no information about what
 * failed. It is shown in small muted text and nothing else about the error is.
 *
 * Note this boundary does NOT catch errors thrown by the root layout itself;
 * that is by design and requires a `global-error.tsx`, which is out of scope.
 *
 * `reset()` re-renders the segment that threw, so "Try again" is a real retry
 * and not a page reload. Untitled UI's `Button` is a react-aria button: it exposes
 * `onPress`, not `onClick`.
 */
export default function AppError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <main className="flex min-h-dvh items-center justify-center px-6 py-16">
      <div className="flex w-full max-w-md flex-col items-center gap-7 text-center">
        <span
          aria-hidden="true"
          className="flex size-11 shrink-0 items-center justify-center rounded-xl bg-error-primary text-error-primary"
        >
          <svg
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.75"
            strokeLinecap="round"
            className="size-5"
          >
            <circle cx="12" cy="12" r="9" />
            <path d="M12 7.5v5.25" />
            <path d="M12 16.5h.01" />
          </svg>
        </span>

        <div className="flex flex-col items-center gap-2">
          <p className="text-xs font-medium uppercase tracking-[0.14em] text-tertiary">
            Unexpected error
          </p>
          <h1 className="text-balance text-2xl font-semibold tracking-tight text-primary">
            Something went wrong
          </h1>
          <p className="max-w-[44ch] text-pretty text-sm leading-relaxed text-tertiary">
            This page couldn’t be loaded. The problem has been logged — trying again usually works.
          </p>
        </div>

        <div className="flex flex-wrap items-center justify-center gap-2">
          <Button color="primary" onPress={reset}>
            Try again
          </Button>
          <ButtonLink href="/">Back to your boards</ButtonLink>
        </div>

        {error.digest ? (
          <p className="text-xs text-tertiary">
            Reference{' '}
            <code className="rounded-md border border-secondary bg-secondary px-1.5 py-0.5 font-mono break-all text-primary">
              {error.digest}
            </code>
          </p>
        ) : null}
      </div>
    </main>
  );
}
