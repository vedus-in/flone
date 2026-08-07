-- Workspace: a named grouping of Projects inside an Organization, and a new URL
-- segment (`/orgs/acme/platform/ENG`).
--
-- `Project.workspaceId` is REQUIRED, so this migration cannot simply add the
-- column: every existing row needs a home first. The order below is the only one
-- that is safe on a live database --
--   1. create the table
--   2. give every organization a default workspace
--   3. add the column NULLABLE
--   4. backfill it
--   5. only then SET NOT NULL and add the foreign key
-- Adding a NOT NULL column with no default to a populated table fails outright;
-- adding the FK before the backfill fails on the first orphan row.

-- 1. -------------------------------------------------------------------------
CREATE TABLE "Workspace" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Workspace_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "Workspace_organizationId_slug_key" ON "Workspace"("organizationId", "slug");

ALTER TABLE "Workspace" ADD CONSTRAINT "Workspace_organizationId_fkey"
    FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- 2. -------------------------------------------------------------------------
-- One default workspace per organization. The id is CUID-SHAPED on purpose: the
-- application generates `cuid()` ids and validates them with `z.string().cuid()`,
-- so a bare `gen_random_uuid()` here would mint rows that every Server Action
-- rejects as malformed input. `'c' || <32 hex chars>` satisfies the cuid regex.
INSERT INTO "Workspace" ("id", "organizationId", "name", "slug", "createdAt", "updatedAt")
SELECT
    ('c' || replace(gen_random_uuid()::text, '-', '')),
    o."id",
    'General',
    'general',
    CURRENT_TIMESTAMP,
    CURRENT_TIMESTAMP
FROM "Organization" o;

-- 3. -------------------------------------------------------------------------
ALTER TABLE "Project" ADD COLUMN "workspaceId" TEXT;

-- 4. -------------------------------------------------------------------------
UPDATE "Project" p
SET "workspaceId" = w."id"
FROM "Workspace" w
WHERE w."organizationId" = p."organizationId"
  AND w."slug" = 'general';

-- 5. -------------------------------------------------------------------------
ALTER TABLE "Project" ALTER COLUMN "workspaceId" SET NOT NULL;

CREATE INDEX "Project_workspaceId_idx" ON "Project"("workspaceId");

-- RESTRICT, not CASCADE: deleting a workspace must never delete the projects
-- grouped under it, and with them every issue those projects own.
ALTER TABLE "Project" ADD CONSTRAINT "Project_workspaceId_fkey"
    FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
