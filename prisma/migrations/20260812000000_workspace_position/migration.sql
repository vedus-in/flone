-- Hand-arranged sidebar order for workspaces: one column with a default, one
-- index. No backfill -- every existing row lands on 0, and `WORKSPACE_ORDER`
-- breaks the tie by name, so an organization that never touches the arrows
-- renders in exactly the order it rendered in before this ran.

-- AlterTable
ALTER TABLE "Workspace" ADD COLUMN "position" INTEGER NOT NULL DEFAULT 0;

-- CreateIndex
CREATE INDEX "Workspace_organizationId_position_idx" ON "Workspace"("organizationId", "position");
