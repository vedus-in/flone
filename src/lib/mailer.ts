import 'server-only';
import { EmailTokenPurpose, type Role } from '@prisma/client';

import { prisma } from '@/lib/db';
import { appUrl, queueMail, tokenUrl } from '@/lib/email';
import { issueToken } from '@/lib/email-token';
import {
  AccountExistsEmail,
  AddedToOrgEmail,
  InviteEmail,
  IssueAssignedEmail,
  McpTokenCreatedEmail,
  NewCommentEmail,
  PasswordChangedEmail,
  PasswordResetEmail,
  VerifyEmail,
  accountExistsSubject,
  addedToOrgSubject,
  inviteSubject,
  issueAssignedSubject,
  mcpTokenCreatedSubject,
  newCommentSubject,
  passwordChangedSubject,
  passwordResetSubject,
  verifyEmailSubject,
} from '@/emails/templates';

/**
 * Every message the app composes.
 *
 * Design: docs/superpowers/specs/2026-08-06-email-design.md
 *
 * THIS FILE IS DELIBERATELY NOT A `'use server'` MODULE, and nothing in it may
 * ever be re-exported from one. Next turns every export of a `'use server'`
 * file into a directly addressable POST endpoint, so exporting
 * `sendVerification(userId, name, email)` from an actions file would publish an
 * open mail relay: any caller, unauthenticated, could send this instance's mail
 * to any address. Actions import from here; nothing here is an action.
 *
 * Two rules hold for every notification below, and they are applied HERE rather
 * than at the call sites so a new call site cannot forget them:
 *
 *   1. never mail the actor -- assigning an issue to yourself, or commenting on
 *      your own, sends nothing;
 *   2. never mail an unverified address -- `emailVerified === null` is dropped
 *      from every recipient set, because the app does not send to addresses
 *      nobody has confirmed.
 *
 * Security mail (password changed, MCP token created) ignores the per-type
 * preference toggles. A user who muted notifications has not consented to
 * silent account takeover.
 */

/* -------------------------------------------------------------------------- */
/* Authentication                                                              */
/* -------------------------------------------------------------------------- */

/** Verification link. Used by register, by `/verify`'s resend, and by `signIn`. */
export async function sendVerificationMail(user: {
  id: string;
  name: string;
  email: string;
}): Promise<void> {
  const token = await issueToken({
    purpose: EmailTokenPurpose.EMAIL_VERIFY,
    email: user.email,
    userId: user.id,
  });
  queueMail(
    user.email,
    verifyEmailSubject,
    VerifyEmail({ name: user.name, url: tokenUrl('/verify', token) }),
  );
}

/**
 * The other half of the register branch. Costs one message so that registering
 * an existing address is externally indistinguishable from registering a new
 * one; the only party who learns anything owns the mailbox.
 */
export function sendAccountExistsMail(email: string): void {
  queueMail(
    email,
    accountExistsSubject,
    AccountExistsEmail({ signInUrl: appUrl('/login'), resetUrl: appUrl('/reset') }),
  );
}

export async function sendPasswordResetMail(user: {
  id: string;
  name: string;
  email: string;
}): Promise<void> {
  const token = await issueToken({
    purpose: EmailTokenPurpose.PASSWORD_RESET,
    email: user.email,
    userId: user.id,
  });
  queueMail(
    user.email,
    passwordResetSubject,
    PasswordResetEmail({ name: user.name, url: tokenUrl('/reset', token) }),
  );
}

/** Security notice. Never gated by a preference. */
export function sendPasswordChangedMail(user: { name: string; email: string }): void {
  queueMail(
    user.email,
    passwordChangedSubject,
    PasswordChangedEmail({ name: user.name, resetUrl: appUrl('/reset') }),
  );
}

/** Security notice. Never gated by a preference. */
export function sendMcpTokenCreatedMail(user: { name: string; email: string }): void {
  queueMail(
    user.email,
    mcpTokenCreatedSubject,
    McpTokenCreatedEmail({ name: user.name, tokensUrl: appUrl('/tokens') }),
  );
}

/* -------------------------------------------------------------------------- */
/* Membership                                                                  */
/* -------------------------------------------------------------------------- */

const ROLE_PHRASE: Record<Role, string> = {
  OWNER: 'an owner',
  ADMIN: 'an admin',
  MEMBER: 'a member',
};

export async function sendInviteMail(input: {
  email: string;
  orgName: string;
  inviterName: string;
  role: Role;
  organizationId: string;
  invitedById: string;
}): Promise<void> {
  const token = await issueToken({
    purpose: EmailTokenPurpose.INVITE,
    email: input.email,
    organizationId: input.organizationId,
    role: input.role,
    invitedById: input.invitedById,
  });
  queueMail(
    input.email,
    inviteSubject(input.orgName),
    InviteEmail({
      orgName: input.orgName,
      inviterName: input.inviterName,
      role: ROLE_PHRASE[input.role],
      url: tokenUrl('/invite', token),
    }),
  );
}

/** The existing-account counterpart of an invitation. */
export async function notifyAddedToOrg(input: {
  userId: string;
  orgName: string;
  orgSlug: string;
  inviterName: string;
  role: Role;
}): Promise<void> {
  const user = await prisma.user.findFirst({
    where: { id: input.userId, emailVerified: { not: null }, notifyOrgMembership: true },
    select: { email: true },
  });
  if (!user) return;

  queueMail(
    user.email,
    addedToOrgSubject(input.orgName),
    AddedToOrgEmail({
      orgName: input.orgName,
      inviterName: input.inviterName,
      role: ROLE_PHRASE[input.role],
      url: appUrl(`/orgs/${input.orgSlug}`),
    }),
  );
}

/* -------------------------------------------------------------------------- */
/* Issue activity                                                              */
/* -------------------------------------------------------------------------- */

/**
 * The one query every notification recipient goes through.
 *
 * The `where` clause is the enforcement point for both standing rules: `id: {
 * notIn: [actorId] }` drops the actor, `emailVerified: { not: null }` drops
 * unconfirmed addresses. A caller cannot opt out of either by passing a
 * different list.
 */
async function recipients(
  userIds: ReadonlyArray<string | null | undefined>,
  actorId: string,
  preference: 'notifyAssigned' | 'notifyComments' | 'notifyOrgMembership',
): Promise<Array<{ id: string; name: string; email: string }>> {
  const ids = [...new Set(userIds.filter((id): id is string => typeof id === 'string'))].filter(
    (id) => id !== actorId,
  );
  if (ids.length === 0) return [];

  return prisma.user.findMany({
    where: {
      id: { in: ids },
      emailVerified: { not: null },
      [preference]: true,
    },
    select: { id: true, name: true, email: true },
  });
}

export type IssueContext = {
  issueKey: string;
  issueTitle: string;
  projectName: string;
  url: string;
};

export async function notifyIssueAssigned(input: {
  assigneeId: string | null;
  actorId: string;
  actorName: string;
  issue: IssueContext;
}): Promise<void> {
  if (!input.assigneeId) return;

  const targets = await recipients([input.assigneeId], input.actorId, 'notifyAssigned');

  for (const target of targets) {
    queueMail(
      target.email,
      issueAssignedSubject(input.issue.issueKey, input.issue.issueTitle),
      IssueAssignedEmail({
        actorName: input.actorName,
        issueKey: input.issue.issueKey,
        issueTitle: input.issue.issueTitle,
        projectName: input.issue.projectName,
        url: input.issue.url,
      }),
    );
  }
}

/** Longer comment bodies are cut here rather than in the template. */
const COMMENT_PREVIEW_CHARS = 600;

export async function notifyNewComment(input: {
  ticketId: string;
  actorId: string;
  actorName: string;
  body: string;
  issue: IssueContext;
}): Promise<void> {
  // The thread: whoever filed it, whoever owns it, and everyone who has already
  // said something. Deduplication and the two standing rules happen in
  // `recipients`.
  const ticket = await prisma.ticket.findUnique({
    where: { id: input.ticketId },
    select: {
      createdById: true,
      assigneeId: true,
      comments: { select: { authorId: true }, distinct: ['authorId'] },
    },
  });
  if (!ticket) return;

  const targets = await recipients(
    [ticket.createdById, ticket.assigneeId, ...ticket.comments.map((c) => c.authorId)],
    input.actorId,
    'notifyComments',
  );

  const body =
    input.body.length > COMMENT_PREVIEW_CHARS
      ? `${input.body.slice(0, COMMENT_PREVIEW_CHARS)}...`
      : input.body;

  for (const target of targets) {
    queueMail(
      target.email,
      newCommentSubject(input.issue.issueKey, input.issue.issueTitle),
      NewCommentEmail({
        actorName: input.actorName,
        issueKey: input.issue.issueKey,
        issueTitle: input.issue.issueTitle,
        projectName: input.issue.projectName,
        body,
        url: input.issue.url,
      }),
    );
  }
}
