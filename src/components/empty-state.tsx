'use client';

import type { ReactNode } from 'react';
import { EmptyState as UntitledEmptyState } from '@/components/application/empty-state/empty-state';
import { cx } from '@/lib/utils/cx';

/**
 * A real empty state, not a shrug: says what is missing, why, and offers the one
 * action that fixes it.
 *
 * Built from Untitled UI's `EmptyState` -- but only the parts that are safe to
 * nest inside a page. `Root` is a `<div>`, `Header` a `<header>` and `Footer` a
 * `<footer>`, all fine. Its `Content` and `Title` are NOT used: they render
 * `<main>` and `<h1>`, and every page that shows an empty state already has one
 * of each from the app layout and `PageHeader`. Two `main` landmarks and two
 * `h1`s is a worse document than a slightly less "library" empty state, so the
 * middle section is a plain `<div>` / `<h2>` / `<p>` wearing the same tokens.
 *
 * It has to be its own `'use client'` module: `EmptyState.Header` and friends
 * are properties assigned to the function at runtime rather than module
 * exports, so a Server Component -- which only sees a client reference per
 * export -- reads them as `undefined` and React fails with error #130. See
 * `components/table.tsx` for the same hazard.
 */
type EmptyStateProps = {
  title: ReactNode;
  description?: ReactNode;
  /** The call to action. Omit it when the viewer's role cannot perform it. */
  children?: ReactNode;
  className?: string;
};

export function EmptyState({ title, description, children, className }: EmptyStateProps) {
  return (
    <UntitledEmptyState
      size="sm"
      className={cx('rounded-xl border border-dashed border-secondary px-6 py-12', className)}
    >
      <UntitledEmptyState.Header>
        <UntitledEmptyState.FeaturedIcon color="gray" theme="modern" />
      </UntitledEmptyState.Header>

      <div className="z-10 mb-6 flex w-full max-w-88 flex-col items-center justify-center gap-1">
        <h2 className="text-md font-semibold text-primary">{title}</h2>
        {description ? (
          <p className="text-center text-sm text-tertiary">{description}</p>
        ) : null}
      </div>

      {children ? <UntitledEmptyState.Footer>{children}</UntitledEmptyState.Footer> : null}
    </UntitledEmptyState>
  );
}
