-- Reminder phone calls: one enum, one column on `Reminder`, four on `User`.
--
-- ADDITIVE ONLY. Every new column is nullable or defaulted, nothing is
-- backfilled and nothing is rewritten, so every existing row is byte-identical
-- after this runs. In particular `Reminder.channel` defaults to EMAIL: no
-- reminder scheduled before this migration starts phoning anybody.
--
-- `User.phone` is deliberately NOT unique. Uniqueness would read like a
-- protection and provide none -- it only stops a second account claiming a
-- number already claimed, which is not the attack -- while breaking the
-- ordinary case of a shared or reused handset. The control that matters is
-- `phoneVerified`, which the scheduler requires before it will place a call.

-- CreateEnum
CREATE TYPE "ReminderChannel" AS ENUM ('EMAIL', 'CALL', 'BOTH');

-- AlterTable
ALTER TABLE "Reminder" ADD COLUMN     "channel" "ReminderChannel" NOT NULL DEFAULT 'EMAIL';

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "phone" TEXT,
ADD COLUMN     "phoneVerified" TIMESTAMP(3),
ADD COLUMN     "phoneCodeHash" TEXT,
ADD COLUMN     "phoneCodeExpiresAt" TIMESTAMP(3);
