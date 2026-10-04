import type { Metadata } from 'next';
import Link from 'next/link';
import { EmailTokenPurpose } from '@prisma/client';

import { ActionForm } from '@/app/(app)/action-form';
import { Card, Field, Input, SubmitButton } from '@/components/ui';
import { peekToken } from '@/lib/email-token';
import { emailTokenSchema } from '@/lib/validation';
import { completeReset, requestReset } from './actions';

export const metadata: Metadata = {
  title: 'Reset your password',
};

export const dynamic = 'force-dynamic';

const LINK =
  'rounded-sm font-medium text-brand-secondary underline-offset-4 hover:underline focus-visible:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring';

/**
 * `/reset` -- both halves of the flow on one route.
 *
 * No token renders the request form; a token renders the new-password form.
 * Two URLs for two halves of one flow would be a second page, a second set of
 * copy and a second place for the two to disagree.
 *
 * `peekToken` reads without spending, so a mail scanner fetching this URL
 * cannot burn the link. `completeReset` does the consuming, on submit.
 */
export default async function ResetPage({
  searchParams,
}: {
  searchParams: Promise<{ token?: string }>;
}) {
  const { token } = await searchParams;
  const parsed = emailTokenSchema.safeParse(token);
  const payload = parsed.success
    ? await peekToken(parsed.data, EmailTokenPurpose.PASSWORD_RESET)
    : null;

  if (payload && parsed.success) {
    return (
      <Card className="gap-6 p-6 sm:p-7">
        <Card.Header className="gap-1.5">
          <h1 className="text-lg leading-6 font-semibold text-primary">Choose a new password</h1>
          <Card.Description>
            Setting a new password for {payload.email} signs out every other session, including
            any MCP tokens.
          </Card.Description>
        </Card.Header>

        <Card.Content>
          <ActionForm action={completeReset} aria-label="Choose a new password">
            <input type="hidden" name="token" value={parsed.data} />

            <Field
              htmlFor="reset-password"
              label="New password"
              hint="At least 12 characters. Length beats punctuation."
            >
              <Input
                id="reset-password"
                name="password"
                type="password"
                autoComplete="new-password"
                required
                minLength={12}
                maxLength={200}
                autoFocus
              />
            </Field>

            <SubmitButton className="w-full" pendingLabel="Saving...">
              Set new password
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
          {token ? 'That link no longer works' : 'Reset your password'}
        </h1>
        <Card.Description>
          {token
            ? 'Reset links work once and expire after an hour. Enter your address and we will send another.'
            : 'Enter your address and we will send you a link to set a new password.'}
        </Card.Description>
      </Card.Header>

      <Card.Content>
        <ActionForm action={requestReset} aria-label="Request a password reset link">
          <Field htmlFor="reset-email" label="Email">
            <Input
              id="reset-email"
              name="email"
              type="email"
              inputMode="email"
              autoComplete="email"
              required
              maxLength={254}
              autoFocus
            />
          </Field>

          <SubmitButton className="w-full" pendingLabel="Sending...">
            Send reset link
          </SubmitButton>
        </ActionForm>
      </Card.Content>

      <Card.Footer className="justify-center gap-1.5 border-t border-secondary pt-6 text-sm text-tertiary">
        <span>Remembered it?</span>
        <Link href="/login" className={LINK}>
          Sign in
        </Link>
      </Card.Footer>
    </Card>
  );
}
