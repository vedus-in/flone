import 'server-only';
import { EmailTokenPurpose, type Role } from '@prisma/client';

import { prisma } from '@/lib/db';
import { appUrl, queueMail, renderAndSend, tokenUrl } from '@/lib/email';
import { issueToken } from '@/lib/email-token';
import { findMentions } from '@/lib/mentions';
import {
  AccountExistsEmail,
  AddedToOrgEmail,
  InviteEmail,
  IssueAssignedEmail,
  McpTokenCreatedEmail,
  MentionEmail,
  NewCommentEmail,
  PasswordChangedEmail,
  PasswordResetEmail,
  RecurringTicketEmail,
  ReminderEmail,
  VerifyEmail,
  accountExistsSubject,
  addedToOrgSubject,
  inviteSubject,
  issueAssignedSubject,
  mcpTokenCreatedSubject,
  mentionSubject,
  newCommentSubject,
  passwordChangedSubject,
  passwordResetSubject,
  recurringTicketSubject,
  reminderSubject,
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

function preview(body: string): string {
  return body.length > COMMENT_PREVIEW_CHARS
    ? `${body.slice(0, COMMENT_PREVIEW_CHARS)}...`
    : body;
}

/**
 * Everyone a `@mention` in this organization could name.
 *
 * `organizationId` always arrives from an authorized upward walk, which is what
 * confines a mention to the tenant: a body naming someone from another
 * organization matches nobody, because they are not in this list.
 */
async function orgMembers(organizationId: string): Promise<Array<{ id: string; name: string }>> {
  const rows = await prisma.membership.findMany({
    where: { organizationId },
    select: { user: { select: { id: true, name: true } } },
  });
  return rows.map((row) => row.user);
}

function mentionedIds(body: string, members: Array<{ id: string; name: string }>): string[] {
  return findMentions(body, members).map((member) => member.id);
}

function queueMention(
  target: { email: string },
  input: { actorName: string; body: string; issue: IssueContext },
): void {
  queueMail(
    target.email,
    mentionSubject(input.actorName, input.issue.issueKey),
    MentionEmail({
      actorName: input.actorName,
      issueKey: input.issue.issueKey,
      issueTitle: input.issue.issueTitle,
      projectName: input.issue.projectName,
      body: preview(input.body),
      url: input.issue.url,
    }),
  );
}

export async function notifyNewComment(input: {
  ticketId: string;
  organizationId: string;
  actorId: string;
  actorName: string;
  body: string;
  issue: IssueContext;
}): Promise<void> {
  // The thread: whoever filed it, whoever owns it, and everyone who has already
  // said something. Deduplication and the two standing rules happen in
  // `recipients`.
  const [ticket, members] = await Promise.all([
    prisma.ticket.findUnique({
      where: { id: input.ticketId },
      select: {
        createdById: true,
        assigneeId: true,
        comments: { select: { authorId: true }, distinct: ['authorId'] },
      },
    }),
    orgMembers(input.organizationId),
  ]);
  if (!ticket) return;

  const [mentions, thread] = await Promise.all([
    recipients(mentionedIds(input.body, members), input.actorId, 'notifyComments'),
    recipients(
      [ticket.createdById, ticket.assigneeId, ...ticket.comments.map((c) => c.authorId)],
      input.actorId,
      'notifyComments',
    ),
  ]);

  // A tagged participant gets the mention message and NOT the thread one: the
  // two sets overlap on almost every real comment.
  const tagged = new Set(mentions.map((target) => target.id));

  for (const target of mentions) queueMention(target, input);

  for (const target of thread) {
    if (tagged.has(target.id)) continue;
    queueMail(
      target.email,
      newCommentSubject(input.issue.issueKey, input.issue.issueTitle),
      NewCommentEmail({
        actorName: input.actorName,
        issueKey: input.issue.issueKey,
        issueTitle: input.issue.issueTitle,
        projectName: input.issue.projectName,
        body: preview(input.body),
        url: input.issue.url,
      }),
    );
  }
}

/**
 * An edit that ADDS a mention notifies the person it added -- tagging someone
 * you forgot is the ordinary way this happens, and an edit is the only way to
 * do it once a comment is posted.
 *
 * Only the difference is mailed. Fixing a typo in a comment that already tagged
 * three people must not tag them again, which is the failure mode that makes
 * people mute a product's mail.
 */
export async function notifyCommentEdited(input: {
  organizationId: string;
  actorId: string;
  actorName: string;
  previousBody: string;
  body: string;
  issue: IssueContext;
}): Promise<void> {
  const members = await orgMembers(input.organizationId);
  const known = new Set(mentionedIds(input.previousBody, members));
  const added = mentionedIds(input.body, members).filter((id) => !known.has(id));
  if (added.length === 0) return;

  const targets = await recipients(added, input.actorId, 'notifyComments');
  for (const target of targets) queueMention(target, input);
}

/* -------------------------------------------------------------------------- */
/* Reminders                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * The one message that breaks the never-mail-the-actor rule at the top of this
 * file, and deliberately: a reminder you set for yourself is the entire point of
 * the feature. There is no actor at send time anyway -- a cron tick is.
 *
 * `await`ed rather than queued, because the caller is a scheduler with no
 * response to run `after()` behind. It still cannot throw: `renderAndSend`
 * swallows a template failure and `sendMail` swallows a provider failure, so one
 * bad reminder cannot stop the rest of the batch.
 *
 * The unverified-address rule DOES still hold, and the scheduler applies it: it
 * advances the schedule for an unconfirmed recipient without sending, so the row
 * does not stay permanently due.
 */
export async function sendReminderMail(input: {
  email: string;
  title: string;
  when: string;
  scope: string;
  repeat: string;
  setBy: string | null;
  url: string;
}): Promise<void> {
  await renderAndSend(
    input.email,
    reminderSubject(input.title),
    ReminderEmail({
      title: input.title,
      when: input.when,
      scope: input.scope,
      repeat: input.repeat,
      setBy: input.setBy,
      url: input.url,
    }),
  );
}

/* -------------------------------------------------------------------------- */
/* Recurring tickets                                                          */
/* -------------------------------------------------------------------------- */

/**
 * The recurring-ticket counterpart of `sendReminderMail`, bent past the
 * never-mail-the-actor rule the same way and for the same reason: a template
 * you set up and assigned to yourself arriving silently would defeat the
 * point, and at spawn time the actor is a cron tick, not a person to protect
 * from their own mail.
 *
 * `IssueAssignedEmail` is deliberately NOT reused -- its copy says a person
 * did something ("Dana assigned you...") and here nobody did; do not
 * "simplify" this back to it.
 *
 * `await`ed via `renderAndSend`, not `queueMail`: the caller is
 * `runDueRecurringTickets`, a cron tick with no response for `after()` to run
 * behind -- exactly why `sendReminderMail` awaits instead of queueing.
 *
 * The unverified-address rule still holds but is enforced by the CALLER (the
 * scheduler), not here -- the same split `sendReminderMail` uses, so the tick
 * can advance the schedule for an unconfirmed recipient without sending,
 * rather than leaving the row permanently due.
 */
export async function sendRecurringTicketMail(input: {
  email: string;
  issueKey: string;
  issueTitle: string;
  projectName: string;
  repeat: string;
  url: string;
}): Promise<void> {
  await renderAndSend(
    input.email,
    recurringTicketSubject(input.issueKey, input.issueTitle),
    RecurringTicketEmail({
      issueKey: input.issueKey,
      issueTitle: input.issueTitle,
      projectName: input.projectName,
      repeat: input.repeat,
      url: input.url,
    }),
  );
}
