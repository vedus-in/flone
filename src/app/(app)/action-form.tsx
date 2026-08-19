'use client';

import { useActionState, useEffect, useRef, type ChangeEvent, type ReactNode } from 'react';
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
 * itself reaches the client bundle. For the same reason the result banners below
 * are hand-rolled rather than imported from `@/components/ui` -- pulling that
 * module in would drag every primitive it re-exports into this bundle for the
 * sake of two `<p>` elements.
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
  /**
   * Full control of the form's layout. Defaults to the vertical rhythm nearly
   * every form on these pages wants; inline forms pass their own row layout.
   */
  className?: string;
  /** Clear the fields and refocus the first one when the action returns `ok`. */
  resetOnSuccess?: boolean;
  /**
   * Submit on change instead of on a button: typing is debounced, picking from
   * a select or flipping a switch is immediate. The form's own constraints are
   * checked first, so half-typed input is simply not sent rather than raising a
   * validation bubble under the cursor.
   */
  autosave?: boolean;
  /**
   * The line the autosaving forms end with -- "Saves automatically" and its
   * dot. Present tense while idle, and it says so while a save is in flight.
   */
  saveHint?: string;
  'aria-label'?: string;
};

/** Types that a person types into, and so wants debounced. */
const TYPED = new Set(['text', 'email', 'search', 'url', 'tel', 'password', 'number']);

export function ActionForm({
  action,
  children,
  className,
  resetOnSuccess = false,
  autosave = false,
  saveHint,
  'aria-label': ariaLabel,
}: Props) {
  const [state, formAction, isPending] = useActionState<ActionResult | null, FormData>(
    action,
    null,
  );
  const formRef = useRef<HTMLFormElement>(null);
  const submitted = useRef<Array<[string, string]> | null>(null);
  const debounce = useRef<ReturnType<typeof setTimeout> | null>(null);

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

  /**
   * One `change` listener on the form rather than a handler per control: the
   * children are server-rendered and passed through untouched, so there is
   * nowhere to hang a per-field callback even if it were worth the repetition.
   * React's `onChange` is the native `input` event, so this fires per keystroke
   * -- hence the debounce, and hence the immediate path for the controls that
   * only ever change once per interaction.
   */
  const handleChange = (event: ChangeEvent<HTMLFormElement>) => {
    if (!autosave) return;
    const target = event.target;
    const typed =
      target instanceof HTMLTextAreaElement ||
      (target instanceof HTMLInputElement && TYPED.has(target.type));

    if (debounce.current) clearTimeout(debounce.current);
    debounce.current = setTimeout(
      () => {
        const form = formRef.current;
        if (!form || !form.checkValidity()) return;
        form.requestSubmit();
      },
      typed ? 700 : 0,
    );
  };

  useEffect(() => () => {
    if (debounce.current) clearTimeout(debounce.current);
  }, []);

  const fieldErrors =
    state && !state.ok && state.fieldErrors ? Object.entries(state.fieldErrors) : [];

  return (
    <form
      ref={formRef}
      action={submitAction}
      onChange={handleChange}
      className={className ?? 'flex flex-col gap-4'}
      aria-label={ariaLabel}
    >
      {children}

      {saveHint ? (
        <p className="flex items-center gap-2 text-xs text-tertiary" aria-live="polite">
          <span
            aria-hidden="true"
            className={
              isPending
                ? 'size-1.5 rounded-full bg-warning-solid'
                : 'size-1.5 rounded-full bg-success-solid'
            }
          />
          {isPending ? 'Saving...' : saveHint}
        </p>
      ) : null}

      {state && !state.ok ? (
        <div className="flex flex-col gap-1.5">
          <p
            role="alert"
            className="rounded-lg bg-error-primary px-3 py-2 text-sm text-error-primary"
          >
            {state.error}
          </p>
          {fieldErrors.length > 0 ? (
            <ul className="flex flex-col gap-1 ps-1">
              {fieldErrors.map(([field, message]) => (
                <li key={field} className="text-xs text-error-primary">
                  {message}
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}

      {state && state.ok && state.message && !autosave ? (
        <p
          role="status"
          className="rounded-lg bg-success-primary px-3 py-2 text-sm text-success-primary"
        >
          {state.message}
        </p>
      ) : null}
    </form>
  );
}

export default ActionForm;
