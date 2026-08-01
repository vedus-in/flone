-- Strictly additive: adds one nullable-safe column with a default, one new
-- table, and backfills. No existing column is altered or dropped, so this is
-- safe to apply to a database that already holds live data.

-- AlterTable
ALTER TABLE "User" ADD COLUMN "isAdmin" BOOLEAN NOT NULL DEFAULT false;

-- CreateIndex
CREATE INDEX "User_isAdmin_idx" ON "User"("isAdmin");

-- CreateTable
CREATE TABLE "AppSetting" (
    "id" TEXT NOT NULL DEFAULT 'singleton',
    "registrationEnabled" BOOLEAN NOT NULL DEFAULT true,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "updatedById" TEXT,

    CONSTRAINT "AppSetting_pkey" PRIMARY KEY ("id")
);

-- Seed the one and only settings row. Registration stays enabled by default so
-- applying this migration does not silently lock anybody out.
INSERT INTO "AppSetting" ("id", "registrationEnabled", "updatedAt")
VALUES ('singleton', true, CURRENT_TIMESTAMP)
ON CONFLICT ("id") DO NOTHING;

-- Backfill the first site administrator. Without this, an instance that
-- already has accounts would have zero admins and nobody could ever reach
-- /admin to disable registration. The earliest account wins, which matches the
-- "first user to register becomes the admin" rule the application applies to
-- new instances.
UPDATE "User"
SET "isAdmin" = true
WHERE "id" = (
  SELECT "id" FROM "User" ORDER BY "createdAt" ASC, "id" ASC LIMIT 1
);
