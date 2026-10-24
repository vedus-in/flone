import type { Metadata } from 'next';
import Link from 'next/link';
import { EmailTokenPurpose } from '@prisma/client';

import { ActionForm } from '@/app/(app)/action-form';
import { ButtonLink, Card, Field, Input, SubmitButton } from '@/components/ui';
import { prisma } from '@/lib/db';
import { peekToken } from '@/lib/email-token';
import { readSession } from '@/lib/session';
import { emailTokenSchema } from '@/lib/validation';
import { acceptInvitation } from './actions';

export const metadata: Metadata = {
  title: 'Accept your invitation',
};

export const dynamic = 'force-dynamic';

const LINK =
  'rounded-sm font-medium text-brand-secondary underline-offset-4 hover:underline focus-visible:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring';

const ROLE_PHRASE = {
  OWNER: 'an owner',
  ADMIN: 'an admin',
  MEMBER: 'a member',
} as const;

/**
 * `/invite` -- accept an invitation.
 *
 * Four states, because an invitation link is opened in four genuinely different
 * situations:
 *
 *   bad or spent token          an explanation and a way out
 *   signed in as the invitee    one button
 *   signed in as somebody else  "this was sent to <address>, sign out first"
 *   signed out, new address     name + password, then straight in
 *
 * The fifth -- signed out with an existing account -- is left to the action,
 * which refuses without spending the token so the link still works after they
 * sign in.
 *
 * `peekToken` reads without spending. `acceptInvitation` does the consuming.
 */
export default async function InvitePage({
  searchParams,
}: {
  searchParams: Promise<{ token?: string }>;
}) {
  const { token } = await searchParams;
  const parsed = emailTokenSchema.safeParse(token);
  const payload = parsed.success ? await peekToken(parsed.data, EmailTokenPurpose.INVITE) : null;

  if (!payload || !parsed.success || !payload.organizationId || !payload.role) {
    return (
      <Card className="gap-7 border-0 bg-transparent p-0">
        <Card.Header className="items-center gap-2 text-center">
          <h1 className="text-xl font-semibold text-primary">
            That invitation no longer works
          </h1>
          <Card.Description>
            Invitations are single use and expire after 7 days. Ask whoever invited you to send
            another.
          </Card.Description>
        </Card.Header>

        <Card.Footer>
          <ButtonLink href="/login" color="primary" className="w-full">
            Go to sign in
          </ButtonLink>
        </Card.Footer>
      </Card>
    );
  }

  const [org, inviter, session] = await Promise.all([
    prisma.organization.findUnique({
      where: { id: payload.organizationId },
      select: { name: true },
    }),
    payload.invitedById
      ? prisma.user.findUnique({ where: { id: payload.invitedById }, select: { name: true } })
      : Promise.resolve(null),
    readSession(),
  ]);

  const orgName = org?.name ?? 'the organization';
  const invitedBy = inviter?.name ?? 'Someone';
  const role = ROLE_PHRASE[payload.role];

  /* ---------------------------------------------------------------------- */
  /* Signed in as somebody other than the invitee                            */
  /* ---------------------------------------------------------------------- */

  if (session && session.user.email !== payload.email) {
    return (
      <Card className="gap-7 border-0 bg-transparent p-0">
        <Card.Header className="items-center gap-2 text-center">
          <h1 className="text-xl font-semibold text-primary">
            This invitation is for someone else
          </h1>
          <Card.Description>
            It was sent to {payload.email}, but you are signed in as {session.user.email}.
          </Card.Description>
        </Card.Header>

        <Card.Content>
          <p className="text-sm text-tertiary">
            An invitation only ever grants access to the account that owns the invited address.
            Sign out, then open the link again.
          </p>
        </Card.Content>

        <Card.Footer>
          <ButtonLink href="/" color="secondary" className="w-full">
            Back to Flone
          </ButtonLink>
        </Card.Footer>
      </Card>
    );
  }

  /* ---------------------------------------------------------------------- */
  /* Signed in as the invitee                                                */
  /* ---------------------------------------------------------------------- */

  if (session) {
    return (
      <Card className="gap-7 border-0 bg-transparent p-0">
        <Card.Header className="items-center gap-2 text-center">
          <h1 className="text-xl font-semibold text-primary">Join {orgName}</h1>
          <Card.Description>
            {invitedBy} invited you to join {orgName} as {role}.
          </Card.Description>
        </Card.Header>

        <Card.Content>
          <ActionForm action={acceptInvitation} aria-label="Accept your invitation">
            <input type="hidden" name="token" value={parsed.data} />
            <SubmitButton className="w-full" pendingLabel="Joining...">
              Accept invitation
            </SubmitButton>
          </ActionForm>
        </Card.Content>
      </Card>
    );
  }

  /* ---------------------------------------------------------------------- */
  /* Signed out                                                              */
  /* ---------------------------------------------------------------------- */

  return (
    <Card className="gap-7 border-0 bg-transparent p-0">
      <Card.Header className="items-center gap-2 text-center">
        <h1 className="text-xl font-semibold text-primary">Join {orgName}</h1>
        <Card.Description>
          {invitedBy} invited {payload.email} to join {orgName} as {role}. Choose a password and
          you are in.
        </Card.Description>
      </Card.Header>

      <Card.Content>
        <ActionForm action={acceptInvitation} aria-label="Accept your invitation">
          <input type="hidden" name="token" value={parsed.data} />

          <Field htmlFor="invite-name" label="Name">
            <Input
              id="invite-name"
              name="name"
              type="text"
              autoComplete="name"
              required
              maxLength={80}
              autoFocus
            />
          </Field>

          <Field
            htmlFor="invite-password"
            label="Password"
            hint="At least 12 characters. Length beats punctuation."
          >
            <Input
              id="invite-password"
              name="password"
              type="password"
              autoComplete="new-password"
              required
              minLength={12}
              maxLength={200}
            />
          </Field>

          <SubmitButton className="w-full" pendingLabel="Creating account...">
            Accept and create account
          </SubmitButton>
        </ActionForm>
      </Card.Content>

      <Card.Footer className="justify-center gap-1.5 text-sm text-tertiary">
        <span>Already have an account?</span>
        <Link href="/login" className={LINK}>
          Sign in first
        </Link>
      </Card.Footer>
    </Card>
  );
}
