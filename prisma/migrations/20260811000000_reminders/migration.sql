-- Scheduling and email reminders: one enum, one table, no change to any
-- existing one. Nothing is backfilled and nothing is rewritten, so every
-- organization, project, issue and comment is byte-identical after this runs.
--
-- INSERTs nothing, so there is no id to mint here and no `gen_random_uuid()`:
-- `Reminder.id` is written only by Prisma, whose @default(cuid()) is applied
-- client-side and already produces the cuid shape every Server Action's zod
-- schema demands.

-- CreateEnum
CREATE TYPE "ReminderRepeat" AS ENUM ('ONCE', 'DAILY', 'WEEKLY');

-- CreateTable
CREATE TABLE "Reminder" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "projectId" TEXT,
    "title" TEXT NOT NULL,
    "repeat" "ReminderRepeat" NOT NULL DEFAULT 'ONCE',
    "nextRunAt" TIMESTAMP(3),
    "lastSentAt" TIMESTAMP(3),
    "tzOffsetMinutes" INTEGER NOT NULL DEFAULT 0,
    "recipientId" TEXT NOT NULL,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Reminder_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Reminder_nextRunAt_idx" ON "Reminder"("nextRunAt");

-- CreateIndex
CREATE INDEX "Reminder_organizationId_idx" ON "Reminder"("organizationId");

-- AddForeignKey
ALTER TABLE "Reminder" ADD CONSTRAINT "Reminder_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Reminder" ADD CONSTRAINT "Reminder_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Reminder" ADD CONSTRAINT "Reminder_recipientId_fkey" FOREIGN KEY ("recipientId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Reminder" ADD CONSTRAINT "Reminder_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
