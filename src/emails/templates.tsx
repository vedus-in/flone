import { Action, Card, EmailLayout, Eyebrow, FallbackLink, Meta, Note, Paragraph, Quote, Title } from './layout';
import { PRODUCT_NAME } from './theme';

/**
 * The twelve messages.
 *
 * All in one file on purpose: they are short, they share a vocabulary, and the
 * thing most worth reviewing about them is that the copy is CONSISTENT --
 * which is far easier to see in one file than across ten.
 *
 * Rules that hold for every message here:
 *  - the subject lives next to the template, exported as `*Subject`, so a call
 *    site cannot pair the wrong subject with the wrong body;
 *  - a one-time link always appears twice, as a button and as text;
 *  - anything security-relevant says what to do if it was not you;
 *  - no message quotes a password, a token, or a session.
 */

/* -------------------------------------------------------------------------- */
/* 1. Verify a new address                                                     */
/* -------------------------------------------------------------------------- */

export const verifyEmailSubject = `Confirm your ${PRODUCT_NAME} email address`;

export function VerifyEmail({ name, url }: { name: string; url: string }) {
  return (
    <EmailLayout preview={`Confirm your email to finish setting up ${PRODUCT_NAME}`}>
      <Card>
        <Eyebrow>One step left</Eyebrow>
        <Title>Confirm your email</Title>
        <Paragraph>
          Hi {name} — confirm this address and your {PRODUCT_NAME} account is ready to use.
        </Paragraph>
        <Action href={url}>Confirm email address</Action>
        <FallbackLink href={url} note="Or paste this link into your browser:" />
        <Note>
          This link works once and expires in 24 hours. If you did not create a {PRODUCT_NAME}{' '}
          account, ignore this email and nothing further will happen.
        </Note>
      </Card>
    </EmailLayout>
  );
}

VerifyEmail.PreviewProps = {
  name: 'Dana',
  url: 'https://flone.example.com/verify?token=preview',
};

/* -------------------------------------------------------------------------- */
/* 2. Registration attempted against an existing account                       */
/* -------------------------------------------------------------------------- */

/**
 * Sent on the "email already registered" branch of `register`.
 *
 * This message is why registration no longer leaks whether an address has an
 * account: both branches send exactly one email and return an identical result,
 * so the only party who learns anything is the person who owns the mailbox.
 */
export const accountExistsSubject = `Someone tried to sign up with your ${PRODUCT_NAME} address`;

export function AccountExistsEmail({ signInUrl, resetUrl }: { signInUrl: string; resetUrl: string }) {
  return (
    <EmailLayout preview={`You already have a ${PRODUCT_NAME} account`}>
      <Card>
        <Eyebrow>Account already exists</Eyebrow>
        <Title>You already have an account</Title>
        <Paragraph>
          Someone just tried to register a {PRODUCT_NAME} account with this address. If that was
          you, sign in instead — there is nothing to set up.
        </Paragraph>
        <Action href={signInUrl}>Sign in</Action>
        <Note>
          Forgotten your password? <a href={resetUrl}>Reset it here</a>. If this was not you, no
          account was created and no change was made; you can safely ignore this email.
        </Note>
      </Card>
    </EmailLayout>
  );
}

AccountExistsEmail.PreviewProps = {
  signInUrl: 'https://flone.example.com/login',
  resetUrl: 'https://flone.example.com/reset',
};

/* -------------------------------------------------------------------------- */
/* 3. Password reset link                                                      */
/* -------------------------------------------------------------------------- */

export const passwordResetSubject = `Reset your ${PRODUCT_NAME} password`;

export function PasswordResetEmail({ name, url }: { name: string; url: string }) {
  return (
    <EmailLayout preview="Reset your password">
      <Card>
        <Eyebrow>Password reset</Eyebrow>
        <Title>Choose a new password</Title>
        <Paragraph>
          Hi {name} — use the button below to set a new password. Signing in again everywhere else
          will be required afterwards.
        </Paragraph>
        <Action href={url}>Set a new password</Action>
        <FallbackLink href={url} note="Or paste this link into your browser:" />
        <Note>
          This link works once and expires in one hour. If you did not ask to reset your password,
          ignore this email — your current password still works and nothing has changed.
        </Note>
      </Card>
    </EmailLayout>
  );
}

PasswordResetEmail.PreviewProps = {
  name: 'Dana',
  url: 'https://flone.example.com/reset?token=preview',
};

/* -------------------------------------------------------------------------- */
/* 4. Password changed (security notice, never gated by a preference)          */
/* -------------------------------------------------------------------------- */

export const passwordChangedSubject = `Your ${PRODUCT_NAME} password was changed`;

export function PasswordChangedEmail({ name, resetUrl }: { name: string; resetUrl: string }) {
  return (
    <EmailLayout preview="Your password was changed">
      <Card>
        <Eyebrow>Security</Eyebrow>
        <Title>Your password was changed</Title>
        <Paragraph>
          Hi {name} — the password on your {PRODUCT_NAME} account was just changed, and every
          existing session was signed out, including any MCP access tokens.
        </Paragraph>
        <Note>
          If this was you, there is nothing to do. If it was not, reset your password immediately —{' '}
          <a href={resetUrl}>{resetUrl}</a> — and revoke your tokens once you are back in.
        </Note>
      </Card>
    </EmailLayout>
  );
}

PasswordChangedEmail.PreviewProps = {
  name: 'Dana',
  resetUrl: 'https://flone.example.com/reset',
};

/* -------------------------------------------------------------------------- */
/* 5. Invitation to an organization                                            */
/* -------------------------------------------------------------------------- */

export function inviteSubject(orgName: string): string {
  return `You have been invited to ${orgName} on ${PRODUCT_NAME}`;
}

export function InviteEmail({
  orgName,
  inviterName,
  role,
  url,
}: {
  orgName: string;
  inviterName: string;
  role: string;
  url: string;
}) {
  return (
    <EmailLayout preview={`${inviterName} invited you to ${orgName}`} context={orgName}>
      <Card>
        <Eyebrow>Invitation</Eyebrow>
        <Title>Join {orgName}</Title>
        <Paragraph>
          {inviterName} has invited you to join {orgName} on {PRODUCT_NAME} as {role}. Accept the
          invitation to pick a password and get started.
        </Paragraph>
        <Action href={url}>Accept invitation</Action>
        <FallbackLink href={url} note="Or paste this link into your browser:" />
        <Note>
          This invitation expires in 7 days. If you were not expecting it, you can ignore this
          email — no account is created until you accept.
        </Note>
      </Card>
    </EmailLayout>
  );
}

InviteEmail.PreviewProps = {
  orgName: 'Acme',
  inviterName: 'Dana Reed',
  role: 'a member',
  url: 'https://flone.example.com/invite?token=preview',
};

/* -------------------------------------------------------------------------- */
/* 6. Added to an organization (the invitee already had an account)            */
/* -------------------------------------------------------------------------- */

export function addedToOrgSubject(orgName: string): string {
  return `You were added to ${orgName}`;
}

export function AddedToOrgEmail({
  orgName,
  inviterName,
  role,
  url,
}: {
  orgName: string;
  inviterName: string;
  role: string;
  url: string;
}) {
  return (
    <EmailLayout preview={`You now have access to ${orgName}`} context={orgName}>
      <Card>
        <Eyebrow>New workspace</Eyebrow>
        <Title>You were added to {orgName}</Title>
        <Paragraph>
          {inviterName} added you to {orgName} as {role}. It is already available when you sign in.
        </Paragraph>
        <Action href={url}>Open {orgName}</Action>
      </Card>
    </EmailLayout>
  );
}

AddedToOrgEmail.PreviewProps = {
  orgName: 'Acme',
  inviterName: 'Dana Reed',
  role: 'a member',
  url: 'https://flone.example.com/orgs/acme',
};

/* -------------------------------------------------------------------------- */
/* 7. Assigned an issue                                                        */
/* -------------------------------------------------------------------------- */

export function issueAssignedSubject(key: string, title: string): string {
  return `${key} assigned to you: ${title}`;
}

export function IssueAssignedEmail({
  actorName,
  issueKey,
  issueTitle,
  projectName,
  url,
}: {
  actorName: string;
  issueKey: string;
  issueTitle: string;
  projectName: string;
  url: string;
}) {
  return (
    <EmailLayout preview={`${actorName} assigned ${issueKey} to you`} context={projectName}>
      <Card>
        <Eyebrow>Assigned to you</Eyebrow>
        <Title>{issueTitle}</Title>
        <Paragraph>
          {actorName} assigned {issueKey} to you in {projectName}.
        </Paragraph>
        <Action href={url}>Open {issueKey}</Action>
        <Note>
          Do not want these? Turn off assignment emails in your account settings.
        </Note>
      </Card>
    </EmailLayout>
  );
}

IssueAssignedEmail.PreviewProps = {
  actorName: 'Dana Reed',
  issueKey: 'ENG-42',
  issueTitle: 'Flaky import on first boot',
  projectName: 'Engineering',
  url: 'https://flone.example.com/orgs/acme/ENG/issue/42',
};

/* -------------------------------------------------------------------------- */
/* 8. New comment                                                              */
/* -------------------------------------------------------------------------- */

export function newCommentSubject(key: string, title: string): string {
  return `New comment on ${key}: ${title}`;
}

export function NewCommentEmail({
  actorName,
  issueKey,
  issueTitle,
  projectName,
  body,
  url,
}: {
  actorName: string;
  issueKey: string;
  issueTitle: string;
  projectName: string;
  body: string;
  url: string;
}) {
  return (
    <EmailLayout preview={`${actorName} commented on ${issueKey}`} context={projectName}>
      <Card>
        <Eyebrow>New comment</Eyebrow>
        <Title>{issueTitle}</Title>
        <Meta>
          {actorName} on {issueKey}
        </Meta>
        <Quote>{body}</Quote>
        <Action href={url}>Reply on {issueKey}</Action>
        <Note>Do not want these? Turn off comment emails in your account settings.</Note>
      </Card>
    </EmailLayout>
  );
}

NewCommentEmail.PreviewProps = {
  actorName: 'Dana Reed',
  issueKey: 'ENG-42',
  issueTitle: 'Flaky import on first boot',
  projectName: 'Engineering',
  body: 'Reproduced on a clean container — it only happens when the migration runs in the same boot as the seed.',
  url: 'https://flone.example.com/orgs/acme/ENG/issue/42',
};

/* -------------------------------------------------------------------------- */
/* 8b. Mentioned in a comment                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Sent INSTEAD of the new-comment message to anyone the body tagged, never as
 * well as it: being named is the stronger signal, and two emails about one
 * comment is how a notification system teaches people to filter it.
 */
export function mentionSubject(actorName: string, key: string): string {
  return `${actorName} mentioned you on ${key}`;
}

export function MentionEmail({
  actorName,
  issueKey,
  issueTitle,
  projectName,
  body,
  url,
}: {
  actorName: string;
  issueKey: string;
  issueTitle: string;
  projectName: string;
  body: string;
  url: string;
}) {
  return (
    <EmailLayout preview={`${actorName} mentioned you on ${issueKey}`} context={projectName}>
      <Card>
        <Eyebrow>You were mentioned</Eyebrow>
        <Title>{issueTitle}</Title>
        <Meta>
          {actorName} on {issueKey}
        </Meta>
        <Quote>{body}</Quote>
        <Action href={url}>Reply on {issueKey}</Action>
        <Note>Do not want these? Turn off comment emails in your account settings.</Note>
      </Card>
    </EmailLayout>
  );
}

MentionEmail.PreviewProps = {
  actorName: 'Dana Reed',
  issueKey: 'ENG-42',
  issueTitle: 'Flaky import on first boot',
  projectName: 'Engineering',
  body: '@Sam Okoro any idea why the migration only fails on a cold container?',
  url: 'https://flone.example.com/orgs/acme/ENG/issue/42',
};

/* -------------------------------------------------------------------------- */
/* 9. MCP token created (security notice, never gated by a preference)         */
/* -------------------------------------------------------------------------- */

export const mcpTokenCreatedSubject = `A new MCP access token was created`;

export function McpTokenCreatedEmail({ name, tokensUrl }: { name: string; tokensUrl: string }) {
  return (
    <EmailLayout preview="A new MCP access token was created on your account">
      <Card>
        <Eyebrow>Security</Eyebrow>
        <Title>New MCP access token</Title>
        <Paragraph>
          Hi {name} — a new MCP access token was just created on your {PRODUCT_NAME} account. A
          token carries your full access to every organization you belong to.
        </Paragraph>
        <Action href={tokensUrl}>Review your tokens</Action>
        <Note>
          If you did not create it, revoke it on that page straight away and change your password.
        </Note>
      </Card>
    </EmailLayout>
  );
}

McpTokenCreatedEmail.PreviewProps = {
  name: 'Dana',
  tokensUrl: 'https://flone.example.com/tokens',
};

/* -------------------------------------------------------------------------- */
/* 10. A scheduled reminder                                                    */
/* -------------------------------------------------------------------------- */

/**
 * The reminder itself is the subject line. Anything prefixed -- "Reminder:" --
 * pushes the part the person wrote out of the preview pane on a phone, which is
 * the one place a reminder has to be readable without opening it.
 */
export function reminderSubject(title: string): string {
  return title;
}

/**
 * The only scheduled message the app sends, and the only one composed outside a
 * request: the cron tick renders it.
 *
 * `setBy` is null when the recipient scheduled it themselves, and the copy
 * changes rather than saying "Dana asked you to" to Dana. `scope` is the
 * project name or the organization name -- a reminder always belongs to
 * something, and which one it is decides where the link goes.
 */
export function ReminderEmail({
  title,
  when,
  scope,
  repeat,
  setBy,
  url,
}: {
  title: string;
  when: string;
  scope: string;
  repeat: string;
  setBy: string | null;
  url: string;
}) {
  return (
    <EmailLayout preview={title} context={scope}>
      <Card>
        <Eyebrow>Reminder</Eyebrow>
        <Title>{title}</Title>
        <Meta>
          {when} &middot; {scope}
        </Meta>
        <Paragraph>
          {setBy
            ? `${setBy} scheduled this reminder for you.`
            : 'You scheduled this reminder.'}{' '}
          {repeat}.
        </Paragraph>
        <Action href={url}>Manage reminders</Action>
        <FallbackLink href={url} note="Or paste this link into your browser:" />
        <Note>
          Delete it on that page to stop it. Reminders are not affected by the
          notification switches in your account settings.
        </Note>
      </Card>
    </EmailLayout>
  );
}

ReminderEmail.PreviewProps = {
  title: 'Post the deploy notes before standup',
  when: 'Wed 12 Aug, 09:00 (UTC+02:00)',
  scope: 'Engineering',
  repeat: 'Every day',
  setBy: 'Dana Reed',
  url: 'https://flone.example.com/orgs/acme/reminders',
};

/* -------------------------------------------------------------------------- */
/* 11. A recurring ticket spawned                                              */
/* -------------------------------------------------------------------------- */

/**
 * Carries the issue key the same way `issueAssignedSubject` does -- searchable
 * by key in a mailbox exactly like an assigned issue is -- but the verb
 * differs: nobody assigned this. A cron tick spawned it from a template the
 * recipient (or a teammate) set up; "ready" says that without claiming a
 * person did something they did not.
 */
export function recurringTicketSubject(key: string, title: string): string {
  return `${key} ready: ${title}`;
}

/**
 * Sent by the recurring-ticket tick (`src/lib/recurring.ts`) when a template
 * spawns its next occurrence, to the assignee only, only once their address is
 * confirmed -- checked by the caller, not here, same split as reminders (§7 of
 * the recurring-tickets design).
 *
 * `IssueAssignedEmail` is deliberately NOT reused here. Its copy says a person
 * did something ("Dana assigned you...") and at spawn time nobody did -- do
 * not "simplify" this back to it.
 */
export function RecurringTicketEmail({
  issueKey,
  issueTitle,
  projectName,
  repeat,
  url,
}: {
  issueKey: string;
  issueTitle: string;
  projectName: string;
  repeat: string;
  url: string;
}) {
  return (
    <EmailLayout preview={issueTitle} context={projectName}>
      <Card>
        <Eyebrow>New ticket</Eyebrow>
        <Title>{issueTitle}</Title>
        <Meta>
          {issueKey} &middot; {projectName}
        </Meta>
        <Paragraph>Your recurring ticket is ready. {repeat}.</Paragraph>
        <Action href={url}>Open {issueKey}</Action>
        <FallbackLink href={url} note="Or paste this link into your browser:" />
      </Card>
    </EmailLayout>
  );
}

RecurringTicketEmail.PreviewProps = {
  issueKey: 'ENG-482',
  issueTitle: 'XAU breakout daily review — 16 Aug 2026',
  projectName: 'Trading Desk',
  repeat: 'Every weekday',
  url: 'https://flone.example.com/orgs/acme/ENG/issue/482',
};
