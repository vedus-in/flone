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
  const submitted = useRef<Array<[string, string]> | null>(null);

  /**
   * React 19 resets a `<form action={fn}>` as soon as the action settles, and it
   * does not look at what the action resolved to -- so a rejected submit throws
   * away everything the user typed. The children here are server-rendered and
   * passed through untouched, so they cannot be made controlled from inside this
   * component. Instead: snapshot what was actually submitted, and put it back if
   * the action came back not-ok. The restore runs in an effect, after the commit
   * that performed React's reset, so it lands last.
   */
  const submitAction = (formData: FormData) => {
    const snapshot: Array<[string, string]> = [];
    formData.forEach((value, key) => {
      if (typeof value === 'string') snapshot.push([key, value]);
    });
    submitted.current = snapshot;
    return formAction(formData);
  };

  useEffect(() => {
    if (!state || state.ok) return;
    const form = formRef.current;
    const snapshot = submitted.current;
    if (!form || !snapshot) return;
    for (const [name, value] of snapshot) {
      const field = form.elements.namedItem(name);
      if (
        (field instanceof HTMLInputElement && field.type !== 'hidden') ||
        field instanceof HTMLTextAreaElement ||
        field instanceof HTMLSelectElement
      ) {
        field.value = value;
      }
    }
  }, [state]);

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
    <form ref={formRef} action={submitAction} className={className} aria-label={ariaLabel}>
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
