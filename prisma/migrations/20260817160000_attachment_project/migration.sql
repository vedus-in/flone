-- Attachments move from being owned by an ISSUE to being owned by a PROJECT, with
-- the issue link kept and made optional.
--
-- WHY: an image can be pasted into a body that has no row yet. The new-issue
-- dialog and the recurring-template form both compose a description before there
-- is anything to attach it to, so an upload from either has a project and no
-- ticket, and the previous NOT NULL made those two surfaces unable to upload at
-- all. Access is unchanged in effect: the walk ends at the Organization either
-- way, and every member of an organization can already read every issue in every
-- one of its projects.
--
-- THE BACKFILL IS THE WHOLE RISK, so it runs before the NOT NULL: every existing
-- row is an issue attachment, so its project is the one its issue belongs to. A
-- row whose issue vanished between these two statements cannot exist -- the FK
-- cascade means an issue delete takes the attachment with it, in the same
-- transaction as this one is not. If the ALTER below ever fails on a NULL, do NOT
-- widen it to a default: a row that cannot name its project is unreachable and
-- should be deleted, not guessed at.
--
-- Existing rows keep their `attachments/<ticketId>/...` object keys. Nothing
-- rewrites them and nothing needs to: the key is opaque and always read from the
-- row. Only new keys use the project.

-- AlterTable: add the owner, nullable for the backfill
ALTER TABLE "Attachment" ADD COLUMN "projectId" TEXT;

-- Backfill from the issue each row already points at
UPDATE "Attachment" a
SET "projectId" = t."projectId"
FROM "Ticket" t
WHERE t."id" = a."ticketId";

-- AlterTable: the owner is now required, and the issue link optional
ALTER TABLE "Attachment" ALTER COLUMN "projectId" SET NOT NULL;
ALTER TABLE "Attachment" ALTER COLUMN "ticketId" DROP NOT NULL;

-- CreateIndex
CREATE INDEX "Attachment_projectId_idx" ON "Attachment"("projectId");

-- AddForeignKey
ALTER TABLE "Attachment" ADD CONSTRAINT "Attachment_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;
