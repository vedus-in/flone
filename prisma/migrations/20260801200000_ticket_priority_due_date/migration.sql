-- Strictly additive: a new enum, two new columns (one with a default, one
-- nullable) and two indexes. No existing column is altered or dropped, so this
-- is safe against a database that already holds live tickets.

-- CreateEnum
CREATE TYPE "Priority" AS ENUM ('NONE', 'LOW', 'MEDIUM', 'HIGH', 'URGENT');

-- AlterTable
ALTER TABLE "Ticket" ADD COLUMN "priority" "Priority" NOT NULL DEFAULT 'NONE';
ALTER TABLE "Ticket" ADD COLUMN "dueDate" TIMESTAMP(3);

-- CreateIndex
CREATE INDEX "Ticket_boardId_priority_idx" ON "Ticket"("boardId", "priority");
CREATE INDEX "Ticket_boardId_dueDate_idx" ON "Ticket"("boardId", "dueDate");
