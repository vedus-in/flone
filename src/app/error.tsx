'use client';

import { Button, ButtonLink, EmptyState } from '@/components/ui';

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
 */
export default function AppError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <main className="auth-shell">
      <div className="container container-narrow">
        <EmptyState
          title="Something went wrong"
          description="This page couldn't be loaded. The problem has been logged — trying again usually works."
        >
          <span className="row">
            <Button variant="primary" onClick={reset}>
              Try again
            </Button>
            <ButtonLink href="/">Back to your boards</ButtonLink>
          </span>
          {error.digest ? <span className="faint mono">Reference {error.digest}</span> : null}
        </EmptyState>
      </div>
    </main>
  );
}
