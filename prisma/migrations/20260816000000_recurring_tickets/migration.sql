-- Recurring tickets: one enum, one table, one implicit m:n join. No change to
-- any existing table. Nothing is backfilled and nothing is rewritten, so every
-- organization, project, issue and comment is byte-identical after this runs.
--
-- INSERTs nothing, so there is no id to mint here and no `gen_random_uuid()`:
-- `RecurringTicket.id` is written only by Prisma, whose @default(cuid()) is
-- applied client-side and already produces the cuid shape every Server Action's
-- zod schema demands.

-- CreateEnum
CREATE TYPE "TicketRepeat" AS ENUM ('DAILY', 'WEEKDAYS', 'WEEKLY', 'MONTHLY');

-- CreateTable
CREATE TABLE "RecurringTicket" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "priority" "Priority" NOT NULL DEFAULT 'NONE',
    "assigneeId" TEXT,
    "repeat" "TicketRepeat" NOT NULL,
    "anchorAt" TIMESTAMP(3) NOT NULL,
    "nextRunAt" TIMESTAMP(3),
    "lastSpawnedAt" TIMESTAMP(3),
    "tzOffsetMinutes" INTEGER NOT NULL DEFAULT 0,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RecurringTicket_pkey" PRIMARY KEY ("id")
);

-- CreateTable: the implicit m:n join for `labels`. Prisma names the columns
-- "A" and "B" alphabetically by model -- Label before RecurringTicket -- and
-- the `_AB_pkey` / `_B_index` names are the shape Prisma 6 expects; anything
-- else reads as schema drift on the next `migrate` run.
CREATE TABLE "_RecurringTicketLabels" (
    "A" TEXT NOT NULL,
    "B" TEXT NOT NULL,

    CONSTRAINT "_RecurringTicketLabels_AB_pkey" PRIMARY KEY ("A","B")
);

-- CreateIndex
CREATE INDEX "RecurringTicket_nextRunAt_idx" ON "RecurringTicket"("nextRunAt");

-- CreateIndex
CREATE INDEX "RecurringTicket_projectId_idx" ON "RecurringTicket"("projectId");

-- CreateIndex
CREATE INDEX "_RecurringTicketLabels_B_index" ON "_RecurringTicketLabels"("B");

-- AddForeignKey
ALTER TABLE "RecurringTicket" ADD CONSTRAINT "RecurringTicket_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RecurringTicket" ADD CONSTRAINT "RecurringTicket_assigneeId_fkey" FOREIGN KEY ("assigneeId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RecurringTicket" ADD CONSTRAINT "RecurringTicket_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "_RecurringTicketLabels" ADD CONSTRAINT "_RecurringTicketLabels_A_fkey" FOREIGN KEY ("A") REFERENCES "Label"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "_RecurringTicketLabels" ADD CONSTRAINT "_RecurringTicketLabels_B_fkey" FOREIGN KEY ("B") REFERENCES "RecurringTicket"("id") ON DELETE CASCADE ON UPDATE CASCADE;
