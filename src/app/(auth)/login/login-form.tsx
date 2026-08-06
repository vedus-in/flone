'use client';

import Link from 'next/link';
import { useActionState, useState } from 'react';

import { Card, Field, FormError, Input, SubmitButton } from '@/components/ui';
import type { ActionResult } from '@/lib/result';
import { signIn } from './actions';

/**
 * SPEC 5 -- the `/login` form.
 *
 * The ONLY client module in this route: it needs `useActionState` for the error
 * string and `useState` for the controlled email. `page.tsx` stays a Server
 * Component and renders this.
 *
 * A native `<form>` bound through `useActionState`, so the page still posts and
 * still works with JavaScript disabled; the only thing lost without JS is the
 * rendered error string (SPEC 8.10).
 *
 * The form never surfaces per-field validation. Every failure -- malformed
 * email, unknown account, wrong password -- renders the one identical banner,
 * because anything finer grained is an account-enumeration oracle. That is also
 * why `aria-invalid` is set on BOTH fields or neither: which one was wrong is
 * exactly the thing the server refuses to say.
 *
 * The email is held in React state so that React 19's post-action form reset
 * does not wipe it on a failed attempt. The password deliberately has no
 * `defaultValue`, is left uncontrolled -- so the same reset clears it -- and is
 * never echoed back (SPEC 4.7).
 *
 * These are plain `Input`s inside `Field` -- `@/components/ui` exports Untitled
 * UI's `InputBase`, NOT its `TextField`-backed `Input`. `TextField` installs
 * react-aria's form plumbing, which restores its own initial value on the
 * `reset` event; with a controlled value that fires `onChange('')` and would
 * defeat the workaround above.
 */
const LINK =
  'rounded-sm font-medium text-brand-secondary underline-offset-4 outline-none hover:underline focus-visible:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring';

export function LoginForm() {
  const [state, formAction] = useActionState<ActionResult | null, FormData>(signIn, null);
  const [email, setEmail] = useState('');

  const error = state && !state.ok ? state.error : undefined;

  return (
    <Card className="gap-6 p-6 sm:p-7">
      <Card.Header className="gap-1.5">
        <h1 className="text-lg leading-6 font-semibold text-primary">Sign in</h1>
        <Card.Description>Welcome back. Sign in to get to your boards.</Card.Description>
      </Card.Header>

      <Card.Content>
        <form action={formAction} className="flex flex-col gap-5">
          <FormError>{error}</FormError>

          <Field htmlFor="login-email" label="Email">
            <Input
              id="login-email"
              name="email"
              type="email"
              inputMode="email"
              autoComplete="email"
              autoFocus
              required
              maxLength={254}
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              aria-invalid={error ? true : undefined}
            />
          </Field>

          <Field htmlFor="login-password" label="Password">
            <Input
              id="login-password"
              name="password"
              type="password"
              autoComplete="current-password"
              required
              maxLength={200}
              aria-invalid={error ? true : undefined}
            />
          </Field>

          <SubmitButton className="w-full" pendingLabel="Signing in...">
            Sign in
          </SubmitButton>

          {/*
           * Under the button rather than beside the password label: this is the
           * escape hatch you reach for after a failed attempt, so it belongs
           * where your eyes already are when the banner appears.
           */}
          <div className="text-center text-sm text-tertiary">
            <Link href="/reset" className={LINK}>
              Forgot your password?
            </Link>
          </div>
        </form>
      </Card.Content>

      <Card.Footer className="justify-center gap-1.5 border-t border-secondary pt-6 text-sm text-tertiary">
        <span>New here?</span>
        <Link href="/register" className={LINK}>
          Create an account
        </Link>
      </Card.Footer>
    </Card>
  );
}
