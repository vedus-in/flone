-- Manual ordering on the Daily Challenges board: one nullable-free column with
-- a default, added to a table nothing else reads. No backfill, because 0 for
-- every existing row is exactly the "never dragged" state -- the page's
-- secondary sort (priority, then last touched) keeps those boards as they are
-- until someone drags a card.

-- AlterTable
ALTER TABLE "ChallengePick" ADD COLUMN "position" INTEGER NOT NULL DEFAULT 0;
