-- Email: verification, password reset, invitations, notification preferences.
--
-- Design: docs/superpowers/specs/2026-08-06-email-design.md
--
-- No id is minted here. Every `EmailToken` row is created by the application
-- through Prisma's client-side `cuid()`, so this migration needs no
-- `gen_random_uuid()` -- which would produce ids that zod's `.cuid()` rejects on
-- every Server Action, exactly as the linear_project_workspace migration
-- documents at length.

-- CreateEnum
CREATE TYPE "EmailTokenPurpose" AS ENUM ('EMAIL_VERIFY', 'PASSWORD_RESET', 'INVITE');

-- AlterTable
ALTER TABLE "User"
    ADD COLUMN "emailVerified" TIMESTAMP(3),
    ADD COLUMN "notifyAssigned" BOOLEAN NOT NULL DEFAULT true,
    ADD COLUMN "notifyComments" BOOLEAN NOT NULL DEFAULT true,
    ADD COLUMN "notifyOrgMembership" BOOLEAN NOT NULL DEFAULT true;

-- THE LOAD-BEARING LINE OF THIS MIGRATION.
--
-- `signIn` refuses to mint a session when `emailVerified` is null. Every row
-- that exists at this point predates verification and its owner has no way to
-- confirm an address they were never asked about, so without this backfill the
-- deploy locks every existing user out of the instance permanently.
--
-- These accounts are grandfathered, not verified: the claim being recorded is
-- "this account predates the verification requirement", which is true.
UPDATE "User" SET "emailVerified" = CURRENT_TIMESTAMP WHERE "emailVerified" IS NULL;

-- CreateTable
CREATE TABLE "EmailToken" (
    "id" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "purpose" "EmailTokenPurpose" NOT NULL,
    "email" TEXT NOT NULL,
    "userId" TEXT,
    "organizationId" TEXT,
    "role" "Role",
    "invitedById" TEXT,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "usedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EmailToken_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "EmailToken_tokenHash_key" ON "EmailToken"("tokenHash");

-- CreateIndex
CREATE INDEX "EmailToken_email_purpose_idx" ON "EmailToken"("email", "purpose");

-- CreateIndex
CREATE INDEX "EmailToken_organizationId_purpose_idx" ON "EmailToken"("organizationId", "purpose");

-- CreateIndex
CREATE INDEX "EmailToken_expiresAt_idx" ON "EmailToken"("expiresAt");

-- AddForeignKey
ALTER TABLE "EmailToken" ADD CONSTRAINT "EmailToken_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EmailToken" ADD CONSTRAINT "EmailToken_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
