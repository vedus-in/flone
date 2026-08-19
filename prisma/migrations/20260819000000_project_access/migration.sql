-- Project-level access control: a visibility flag plus an explicit member list.
--
-- Purely additive, and NOT a data migration. `Project.access` defaults to OPEN,
-- which is exactly what every project already was -- every member of the
-- organization could see it -- so this deploy changes nobody's access and the
-- table starts empty. A project becomes private only when somebody says so.
--
-- `ProjectMember` carries no role. Whether you may see a private project is what
-- this table answers; what you may DO once you can is still the `Membership`
-- role on the organization, and duplicating that here would be a second answer
-- to a settled question.
--
-- Cascade on both foreign keys. Deleting a project takes its list with it, and
-- deleting a user leaves no orphan grants behind. Both directions can only ever
-- REMOVE access, never widen it, which is the right way for this table to fail.
--
-- The index on "userId" is what makes the visibility predicate cheap: every
-- project-rooted read in `src/lib/authz.ts` now ORs in `members: { some: { userId } }`,
-- so it runs on the sidebar, on search, and on every issue page.

-- CreateEnum
CREATE TYPE "ProjectAccess" AS ENUM ('OPEN', 'PRIVATE');

-- AlterTable
ALTER TABLE "Project" ADD COLUMN "access" "ProjectAccess" NOT NULL DEFAULT 'OPEN';

-- CreateTable
CREATE TABLE "ProjectMember" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProjectMember_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ProjectMember_userId_idx" ON "ProjectMember"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "ProjectMember_projectId_userId_key" ON "ProjectMember"("projectId", "userId");

-- AddForeignKey
ALTER TABLE "ProjectMember" ADD CONSTRAINT "ProjectMember_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProjectMember" ADD CONSTRAINT "ProjectMember_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
