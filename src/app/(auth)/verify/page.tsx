import type { Metadata } from 'next';
import Link from 'next/link';
import { EmailTokenPurpose } from '@prisma/client';

import { ActionForm } from '@/app/(app)/action-form';
import { Card, Field, Input, SubmitButton } from '@/components/ui';
import { peekToken } from '@/lib/email-token';
import { emailTokenSchema } from '@/lib/validation';
import { confirmEmail, resendVerification } from './actions';

export const metadata: Metadata = {
  title: 'Confirm your email',
};

/** Reads a one-time token from the query string on every request. */
export const dynamic = 'force-dynamic';

const LINK =
  'rounded-sm font-medium text-brand-secondary underline-offset-4 outline-none hover:underline focus-visible:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring';

/**
 * `/verify` -- three states from one route.
 *
 * `?token=<valid>`  the confirm button
 * `?token=<bad>`    an explanation, plus the resend form
 * no token          the resend form
 *
 * `peekToken` READS the token; it does not spend it. Spending happens in
 * `confirmEmail`, behind the button, so a mail scanner that fetches this URL
 * cannot burn the link before the human opens it.
 */
export default async function VerifyPage({
  searchParams,
}: {
  searchParams: Promise<{ token?: string }>;
}) {
  const { token } = await searchParams;
  const parsed = emailTokenSchema.safeParse(token);
  const payload = parsed.success
    ? await peekToken(parsed.data, EmailTokenPurpose.EMAIL_VERIFY)
    : null;

  if (payload && parsed.success) {
    return (
      <Card className="gap-6 p-6 sm:p-7">
        <Card.Header className="gap-1.5">
          <h1 className="text-lg leading-6 font-semibold text-primary">Confirm your email</h1>
          <Card.Description>
            Confirm {payload.email} and you will be signed in.
          </Card.Description>
        </Card.Header>

        <Card.Content>
          <ActionForm action={confirmEmail} aria-label="Confirm your email address">
            <input type="hidden" name="token" value={parsed.data} />
            <SubmitButton className="w-full" pendingLabel="Confirming...">
              Confirm email address
            </SubmitButton>
          </ActionForm>
        </Card.Content>
      </Card>
    );
  }

  return (
    <Card className="gap-6 p-6 sm:p-7">
      <Card.Header className="gap-1.5">
        <h1 className="text-lg leading-6 font-semibold text-primary">
          {token ? 'That link no longer works' : 'Send a confirmation link'}
        </h1>
        <Card.Description>
          {token
            ? 'Confirmation links work once and expire after 24 hours. Enter your address and we will send another.'
            : 'Enter the address you signed up with and we will send you a new confirmation link.'}
        </Card.Description>
      </Card.Header>

      <Card.Content>
        <ActionForm action={resendVerification} aria-label="Resend confirmation link">
          <Field htmlFor="verify-email" label="Email">
            <Input
              id="verify-email"
              name="email"
              type="email"
              inputMode="email"
              autoComplete="email"
              required
              maxLength={254}
            />
          </Field>

          <SubmitButton className="w-full" pendingLabel="Sending...">
            Send confirmation link
          </SubmitButton>
        </ActionForm>
      </Card.Content>

      <Card.Footer className="justify-center gap-1.5 border-t border-secondary pt-6 text-sm text-tertiary">
        <span>Already confirmed?</span>
        <Link href="/login" className={LINK}>
          Sign in
        </Link>
      </Card.Footer>
    </Card>
  );
}
