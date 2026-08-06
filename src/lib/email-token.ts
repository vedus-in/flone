import 'server-only';
import { createHash, randomBytes } from 'node:crypto';
import { EmailTokenPurpose, type Role } from '@prisma/client';
import { prisma } from '@/lib/db';

/**
 * One-time credentials delivered by email.
 *
 * Design: docs/superpowers/specs/2026-08-06-email-design.md
 *
 * Construction is `src/lib/session.ts` verbatim, for the same reasons: 256 bits
 * from `randomBytes`, only `sha256(token)` in the database under a unique index,
 * so verification is a lookup by key rather than a comparison and a database
 * leak yields nothing usable. SHA-256 rather than scrypt is right here exactly
 * as it is right for sessions -- a uniformly random 256-bit value has no
 * dictionary to attack.
 */

export const TOKEN_TTL_MS: Record<EmailTokenPurpose, number> = {
  EMAIL_VERIFY: 24 * 60 * 60 * 1000,
  PASSWORD_RESET: 60 * 60 * 1000,
  INVITE: 7 * 24 * 60 * 60 * 1000,
};

/** Never exported: `tokenHash` must not appear on any object outside this file. */
function hashToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

export type TokenPayload = {
  email: string;
  userId: string | null;
  organizationId: string | null;
  role: Role | null;
  invitedById: string | null;
  expiresAt: Date;
};

const PAYLOAD_SELECT = {
  email: true,
  userId: true,
  organizationId: true,
  role: true,
  invitedById: true,
  expiresAt: true,
} as const;

/* -------------------------------------------------------------------------- */
/* Issue                                                                       */
/* -------------------------------------------------------------------------- */

export type IssueTokenInput = {
  purpose: EmailTokenPurpose;
  email: string;
  userId?: string | null;
  /** INVITE only. */
  organizationId?: string | null;
  role?: Role | null;
  invitedById?: string | null;
};

/**
 * Mints a token and returns the RAW value, which exists only in the returned
 * string and in the email built from it. It is never stored and never logged.
 *
 * Issuing supersedes the address's outstanding tokens of the same purpose, so
 * requesting a second reset link retires the first. Invitations are scoped by
 * organization as well: being invited to a second organization must not cancel
 * the first invitation.
 */
export async function issueToken(input: IssueTokenInput): Promise<string> {
  const { purpose, email } = input;

  await prisma.emailToken
    .deleteMany({
      where: {
        email,
        purpose,
        ...(purpose === EmailTokenPurpose.INVITE
          ? { organizationId: input.organizationId ?? undefined }
          : {}),
      },
    })
    .catch(() => undefined);

  // Table hygiene, never a security control -- expiry is enforced in the
  // `where` clause of every consume regardless.
  await prisma.emailToken
    .deleteMany({ where: { expiresAt: { lt: new Date() } } })
    .catch(() => undefined);

  const token = randomBytes(32).toString('base64url');

  await prisma.emailToken.create({
    data: {
      tokenHash: hashToken(token),
      purpose,
      email,
      userId: input.userId ?? null,
      organizationId: input.organizationId ?? null,
      role: input.role ?? null,
      invitedById: input.invitedById ?? null,
      expiresAt: new Date(Date.now() + TOKEN_TTL_MS[purpose]),
    },
    select: { id: true },
  });

  return token;
}

/* -------------------------------------------------------------------------- */
/* Read and consume                                                            */
/* -------------------------------------------------------------------------- */

/**
 * Reads a token WITHOUT spending it, so a page can render "you were invited to
 * Acme by Dana" before the invitee has submitted anything. A GET must never
 * consume a one-time credential: a link preview fetcher or a mail client's
 * scanner would burn it before the human clicked.
 */
export async function peekToken(
  raw: string,
  purpose: EmailTokenPurpose,
): Promise<TokenPayload | null> {
  if (!raw) return null;

  const row = await prisma.emailToken.findUnique({
    where: { tokenHash: hashToken(raw) },
    select: { ...PAYLOAD_SELECT, purpose: true, usedAt: true },
  });

  if (!row) return null;
  if (row.purpose !== purpose) return null;
  if (row.usedAt !== null) return null;
  if (row.expiresAt.getTime() <= Date.now()) return null;

  return {
    email: row.email,
    userId: row.userId,
    organizationId: row.organizationId,
    role: row.role,
    invitedById: row.invitedById,
    expiresAt: row.expiresAt,
  };
}

/**
 * Spends a token, returning its payload exactly once.
 *
 * Single use is enforced by the database inside ONE atomic statement. A
 * read-then-write would let two concurrent clicks -- a double submit, a mail
 * client prefetch racing the human -- both observe `usedAt: null` and both
 * proceed. `purpose` sits in the `where` clause, so a verification token
 * presented to the reset endpoint matches nothing.
 */
export async function consumeToken(
  raw: string,
  purpose: EmailTokenPurpose,
): Promise<TokenPayload | null> {
  if (!raw) return null;

  const tokenHash = hashToken(raw);
  const now = new Date();

  const { count } = await prisma.emailToken.updateMany({
    where: { tokenHash, purpose, usedAt: null, expiresAt: { gt: now } },
    data: { usedAt: now },
  });

  // Zero means missing, wrong purpose, expired, or already spent -- all four are
  // the same answer to the caller, so no probe distinguishes them.
  if (count !== 1) return null;

  const row = await prisma.emailToken.findUnique({
    where: { tokenHash },
    select: PAYLOAD_SELECT,
  });

  return row ?? null;
}

/** Revoking a pending invitation is a delete; there is nothing to keep. */
export async function revokeInvite(organizationId: string, tokenId: string): Promise<void> {
  await prisma.emailToken.deleteMany({
    where: { id: tokenId, organizationId, purpose: EmailTokenPurpose.INVITE },
  });
}

/** Outstanding invitations for an organization's settings page. */
export async function pendingInvites(organizationId: string) {
  return prisma.emailToken.findMany({
    where: {
      organizationId,
      purpose: EmailTokenPurpose.INVITE,
      usedAt: null,
      expiresAt: { gt: new Date() },
    },
    select: { id: true, email: true, role: true, expiresAt: true, createdAt: true },
    orderBy: { createdAt: 'desc' },
  });
}
