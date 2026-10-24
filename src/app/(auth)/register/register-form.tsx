'use client';

import Link from 'next/link';
import { useActionState, useState } from 'react';

import { Card, Field, FormError, Input, SubmitButton } from '@/components/ui';
import type { ActionResult } from '@/lib/result';
import { register } from './actions';

/**
 * SPEC 5 -- the `/register` form.
 *
 * The ONLY client module in this route: it needs `useActionState` for the
 * banner and per-field errors, and `useState` for the controlled fields.
 * `page.tsx` stays a Server Component, reads the registration gate, and renders
 * either this or the closed state.
 *
 * Three fields: name, email, password. No organization is created here; the
 * dispatcher at `/orgs` sends a brand-new zero-org user to `/orgs/new`, which is the
 * one and only org-creation path (SPEC 7.3).
 *
 * Name and email are held in React state so React 19's post-action form reset
 * cannot wipe a filled-in form on a failed attempt. The password field has no
 * `defaultValue`, stays uncontrolled -- so that same reset clears it -- and is
 * never echoed back (SPEC 4.7).
 *
 * These are plain `Input`s inside `Field` -- `@/components/ui` exports Untitled
 * UI's `InputBase`, NOT its `TextField`-backed `Input`. `TextField` installs
 * react-aria's form plumbing, which restores its own initial value on the
 * `reset` event; with a controlled value that fires `onChange('')` and would
 * defeat the workaround above.
 *
 * `minLength={12}` mirrors the server rule for early, local feedback -- it is a
 * convenience, never the check. `register/actions.ts` re-validates with zod, and
 * the messages rendered under each field are the server's own closed literals.
 */
const LINK =
  'rounded-sm font-medium text-brand-secondary underline-offset-4 hover:underline focus-visible:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring';

/** Joins the ids that actually rendered; `undefined` when none did. */
function describedBy(...ids: Array<string | false | undefined>): string | undefined {
  const present = ids.filter((id): id is string => typeof id === 'string');
  return present.length > 0 ? present.join(' ') : undefined;
}

export function RegisterForm() {
  const [state, formAction] = useActionState<ActionResult | null, FormData>(register, null);
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');

  const failure = state && !state.ok ? state : null;
  const fieldErrors = failure?.fieldErrors;

  /*
   * Success no longer redirects: `register` mints no session, so there is
   * nowhere signed-in to go. It renders this panel instead.
   *
   * The panel is IDENTICAL whether the address was free or already had an
   * account -- that is the whole point of the change, and the reason the email
   * is not echoed back here either. Naming the address would not leak anything
   * on its own, but it invites a future edit that says "we sent a link to" on
   * one branch and something else on the other.
   */
  if (state?.ok) {
    return (
      <Card className="gap-7 border-0 bg-transparent p-0">
        <Card.Header className="items-center gap-2 text-center">
          <h1 className="text-xl font-semibold text-primary">Check your inbox</h1>
          <Card.Description>{state.message}</Card.Description>
        </Card.Header>

        <Card.Content>
          <p className="text-sm text-tertiary">
            The link works once and expires in 24 hours. If it does not arrive, check your spam
            folder, then request another one.
          </p>
        </Card.Content>

        <Card.Footer className="flex-col gap-3">
          <Link href="/verify" className={LINK}>
            Send another link
          </Link>
          <Link href="/login" className={LINK}>
            Back to sign in
          </Link>
        </Card.Footer>
      </Card>
    );
  }

  return (
    <Card className="gap-7 border-0 bg-transparent p-0">
      <Card.Header className="items-center gap-2 text-center">
        <h1 className="text-xl font-semibold text-primary">Create your account</h1>
        <Card.Description>Three fields and you are in.</Card.Description>
      </Card.Header>

      <Card.Content>
        <form action={formAction} className="flex flex-col gap-5">
          <FormError>{failure?.error}</FormError>

          <Field htmlFor="register-name" label="Name" error={fieldErrors?.name}>
            <Input
              id="register-name"
              name="name"
              type="text"
              autoComplete="name"
              autoFocus
              required
              maxLength={80}
              value={name}
              onChange={(event) => setName(event.target.value)}
              aria-describedby={describedBy(fieldErrors?.name && 'register-name-error')}
              aria-invalid={fieldErrors?.name ? true : undefined}
            />
          </Field>

          <Field htmlFor="register-email" label="Email" error={fieldErrors?.email}>
            <Input
              id="register-email"
              name="email"
              type="email"
              inputMode="email"
              autoComplete="email"
              required
              maxLength={254}
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              aria-describedby={describedBy(fieldErrors?.email && 'register-email-error')}
              aria-invalid={fieldErrors?.email ? true : undefined}
            />
          </Field>

          <Field
            htmlFor="register-password"
            label="Password"
            hint="At least 12 characters. Length beats punctuation."
            error={fieldErrors?.password}
          >
            <Input
              id="register-password"
              name="password"
              type="password"
              autoComplete="new-password"
              required
              minLength={12}
              maxLength={200}
              aria-describedby={describedBy(
                'register-password-hint',
                fieldErrors?.password && 'register-password-error',
              )}
              aria-invalid={fieldErrors?.password ? true : undefined}
            />
          </Field>

          <SubmitButton className="w-full" pendingLabel="Creating account...">
            Create account
          </SubmitButton>
        </form>
      </Card.Content>

      <Card.Footer className="justify-center gap-1.5 text-sm text-tertiary">
        <span>Already have an account?</span>
        <Link href="/login" className={LINK}>
          Sign in
        </Link>
      </Card.Footer>
    </Card>
  );
}
