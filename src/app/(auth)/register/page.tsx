import type { Metadata } from 'next';

import { ButtonLink, Card } from '@/components/ui';
import { isRegistrationOpen } from '@/lib/settings';
import { RegisterForm } from './register-form';

export const metadata: Metadata = {
  title: 'Create your account',
};

/**
 * The gate is read from the database on every request, so this page must never
 * be prerendered: a build-time snapshot would keep showing the form for as long
 * as it stayed cached after an admin closed registration.
 */
export const dynamic = 'force-dynamic';

/**
 * SPEC 5 -- `/register`.
 *
 * A Server Component. It reads the instance-wide registration gate and renders
 * EITHER the closed state OR the form; `./register-form` is the single client
 * module in this route.
 *
 * This check is COSMETIC. It exists so a closed instance does not hand out a
 * form that cannot work. The enforcement lives in `register/actions.ts`, which
 * calls the same `isRegistrationOpen()` before it does anything else -- the
 * Server Action is a directly addressable POST endpoint and is reachable
 * whatever this page decided to draw.
 *
 * `isRegistrationOpen()` also carries the bootstrap exception: with zero users
 * in the database registration is open no matter what the flag says, so a
 * disabled flag on an empty instance cannot brick it permanently.
 */
export default async function RegisterPage() {
  if (await isRegistrationOpen()) return <RegisterForm />;

  return (
    <Card className="gap-7 border-0 bg-transparent p-0">
      <Card.Header className="items-center gap-2 text-center">
        <h1 className="text-xl font-semibold text-primary">Registration is closed</h1>
        <Card.Description>
          This Flone instance is not accepting new accounts right now.
        </Card.Description>
      </Card.Header>

      <Card.Content>
        <p className="text-sm text-tertiary">
          A site administrator can reopen registration at any time. If you already have an
          account, you can still sign in.
        </p>
      </Card.Content>

      <Card.Footer>
        <ButtonLink href="/login" color="primary" className="w-full">
          Go to sign in
        </ButtonLink>
      </Card.Footer>
    </Card>
  );
}
