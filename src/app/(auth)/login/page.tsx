'use client';

import Link from 'next/link';
import { useActionState, useState } from 'react';

import { Card, Field, FormError, Input, SubmitButton } from '@/components/ui';
import type { ActionResult } from '@/lib/result';
import { signIn } from './actions';

/**
 * SPEC 5 -- `/login`.
 *
 * A native `<form>` bound through `useActionState`, so the page still posts and
 * still works with JavaScript disabled; the only thing lost without JS is the
 * rendered error string (SPEC 8.10).
 *
 * The form never surfaces per-field validation. Every failure -- malformed
 * email, unknown account, wrong password -- renders the one identical banner,
 * because anything finer grained is an account-enumeration oracle.
 *
 * The email is held in React state so that React 19's post-action form reset
 * does not wipe it on a failed attempt. The password deliberately has no
 * `defaultValue` and is never echoed back (SPEC 4.7).
 */
export default function LoginPage() {
  const [state, formAction] = useActionState<ActionResult | null, FormData>(signIn, null);
  const [email, setEmail] = useState('');

  const error = state && !state.ok ? state.error : undefined;

  return (
    <Card>
      <div className="stack">
        <div className="stack-sm">
          <h1>Sign in</h1>
          <p className="muted">Welcome back.</p>
        </div>

        <form action={formAction} className="stack">
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

          <SubmitButton pendingLabel="Signing in...">Sign in</SubmitButton>
        </form>

        <p className="faint">
          New here? <Link href="/register">Create an account</Link>
        </p>
      </div>
    </Card>
  );
}
