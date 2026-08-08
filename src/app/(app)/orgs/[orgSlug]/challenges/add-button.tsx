'use client';

/**
 * The "Add" control on a search result row.
 *
 * A client component rather than a `<form action>` because `addChallenge` takes
 * plain arguments and returns an `ActionResult`, the same shape the board's own
 * handlers use -- there is one way to call these actions, not two. The search
 * itself stays a plain GET form on the server page: the query string IS the
 * filter state, as everywhere else in this app.
 */

import { useState, useTransition } from 'react';

import { cx } from '@/lib/utils/cx';

import { addChallenge } from './actions';

export function AddChallengeButton({ ticketId, label }: { ticketId: string; label: string }) {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [added, setAdded] = useState(false);

  return (
    <span className="flex items-center gap-2">
      {error ? (
        <span role="alert" className="text-xs text-error-primary">
          {error}
        </span>
      ) : null}
      <button
        type="button"
        disabled={pending || added}
        aria-label={`Add ${label} to my challenges`}
        onClick={() =>
          startTransition(async () => {
            const result = await addChallenge({ ticketId });
            if (result.ok) {
              // The row stays on screen until the revalidated search re-renders
              // without it, so the button has to say it already fired or it
              // reads as a no-op.
              setAdded(true);
              setError(null);
            } else {
              setError(result.error);
            }
          })
        }
        className={cx(
          'rounded-md border border-secondary px-2.5 py-1 text-xs font-medium whitespace-nowrap transition-colors',
          'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring',
          added
            ? 'border-transparent text-success-primary'
            : 'text-primary hover:bg-secondary disabled:opacity-50',
        )}
      >
        {added ? 'Added' : pending ? 'Adding…' : 'Add'}
      </button>
    </span>
  );
}
