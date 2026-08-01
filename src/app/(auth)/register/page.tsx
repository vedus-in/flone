'use client';

import Link from 'next/link';
import { useActionState, useState } from 'react';

import { Card, Field, FormError, Input, SubmitButton } from '@/components/ui';
import type { ActionResult } from '@/lib/result';
import { register } from './actions';

/**
 * SPEC 5 -- `/register`.
 *
 * Three fields: name, email, password. No organization is created here; the
 * dispatcher at `/` sends a brand-new zero-org user to `/orgs/new`, which is the
 * one and only org-creation path (SPEC 7.3).
 *
 * Name and email are held in React state so React 19's post-action form reset
 * cannot wipe a filled-in form on a failed attempt. The password field has no
 * `defaultValue` and is never echoed back (SPEC 4.7).
 *
 * `minLength={12}` mirrors the server rule for early, local feedback -- it is a
 * convenience, never the check. `register/actions.ts` re-validates with zod.
 */
export default function RegisterPage() {
  const [state, formAction] = useActionState<ActionResult | null, FormData>(register, null);
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');

  const failure = state && !state.ok ? state : null;
  const fieldErrors = failure?.fieldErrors;

  return (
    <Card>
      <div className="stack">
        <div className="stack-sm">
          <h1>Create your account</h1>
          <p className="muted">Three fields and you are in.</p>
        </div>

        <form action={formAction} className="stack">
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
              aria-describedby="register-password-hint"
              aria-invalid={fieldErrors?.password ? true : undefined}
            />
          </Field>

          <SubmitButton pendingLabel="Creating account...">Create account</SubmitButton>
        </form>

        <p className="faint">
          Already have an account? <Link href="/login">Sign in</Link>
        </p>
      </div>
    </Card>
  );
}
