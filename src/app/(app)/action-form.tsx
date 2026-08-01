'use client';

import { useActionState, useEffect, useRef, type ReactNode } from 'react';
import type { ActionResult } from '@/lib/result';

/**
 * The `useActionState` wrapper every form under `(app)/orgs` and
 * `(app)/orgs/[orgSlug]/[projectKey]` is bound with.
 *
 * SPEC 6.1 rule 2: a Server Action has the signature
 * `(prev, formData) => Promise<ActionResult>` and React's `<form action>` prop
 * rejects value-returning functions, so the binding must happen in a client
 * component. This is that component -- and the ONLY `'use client'` module in the
 * organizations/projects slice.
 *
 * It renders no state of its own beyond the returned `ActionResult`: the children
 * are server-rendered and passed through untouched, so nothing but the wrapper
 * itself reaches the client bundle.
 *
 * (SPEC 5 sketches a shared `src/components/inline-form.tsx` for this role. That
 * file does not exist in the foundation, and creating it would collide with the
 * board/ticket slice, so this equivalent is colocated with the routes that use it.)
 */

export type FormAction = (
  prev: ActionResult | null,
  formData: FormData,
) => Promise<ActionResult>;

type Props = {
  action: FormAction;
  children: ReactNode;
  className?: string;
  /** Clear the fields and refocus the first one when the action returns `ok`. */
  resetOnSuccess?: boolean;
  'aria-label'?: string;
};

export function ActionForm({
  action,
  children,
  className,
  resetOnSuccess = false,
  'aria-label': ariaLabel,
}: Props) {
  const [state, formAction] = useActionState<ActionResult | null, FormData>(action, null);
  const formRef = useRef<HTMLFormElement>(null);

  useEffect(() => {
    if (!resetOnSuccess || !state || !state.ok) return;
    const form = formRef.current;
    if (!form) return;
    form.reset();
    const first = form.querySelector<HTMLElement>(
      'input:not([type="hidden"]):not([disabled]), textarea:not([disabled])',
    );
    first?.focus();
  }, [state, resetOnSuccess]);

  const fieldErrors =
    state && !state.ok && state.fieldErrors ? Object.entries(state.fieldErrors) : [];

  return (
    <form ref={formRef} action={formAction} className={className} aria-label={ariaLabel}>
      {children}

      {state && !state.ok ? (
        <div className="stack-sm">
          <p className="error" role="alert">
            {state.error}
          </p>
          {fieldErrors.map(([field, message]) => (
            <p className="error" key={field}>
              {message}
            </p>
          ))}
        </div>
      ) : null}

      {state && state.ok && state.message ? (
        <p className="hint" role="status">
          {state.message}
        </p>
      ) : null}
    </form>
  );
}

export default ActionForm;
