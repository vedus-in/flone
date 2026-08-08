-- Daily Challenges: one table, no changes to any existing one.
--
-- INSERTs nothing, so there is no id to mint here and no `gen_random_uuid()`
-- anywhere in this file: `ChallengePick.id` is written only by Prisma, whose
-- @default(cuid()) is applied client-side and already produces the cuid shape
-- every Server Action's zod schema demands.

-- CreateTable
CREATE TABLE "ChallengePick" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "ticketId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ChallengePick_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ChallengePick_ticketId_idx" ON "ChallengePick"("ticketId");

-- CreateIndex
CREATE UNIQUE INDEX "ChallengePick_userId_ticketId_key" ON "ChallengePick"("userId", "ticketId");

-- AddForeignKey
ALTER TABLE "ChallengePick" ADD CONSTRAINT "ChallengePick_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ChallengePick" ADD CONSTRAINT "ChallengePick_ticketId_fkey" FOREIGN KEY ("ticketId") REFERENCES "Ticket"("id") ON DELETE CASCADE ON UPDATE CASCADE;
