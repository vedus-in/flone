import type { Metadata } from 'next';

import { LoginForm } from './login-form';

export const metadata: Metadata = {
  title: 'Sign in',
};

/**
 * SPEC 5 -- `/login`.
 *
 * A Server Component. Everything that needs a hook -- `useActionState` for the
 * failure banner, `useState` for the controlled email -- lives in
 * `./login-form`, which is the single client module in this route.
 */
export default function LoginPage() {
  return <LoginForm />;
}
