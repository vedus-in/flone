-- Documents: long-form Markdown pages inside a project, nested by `parentId`.
--
-- Additive only. No existing table is touched, so this is safe to apply while the
-- old code is still serving: nothing reads or writes "Document" until the deploy
-- carrying the routes lands.
--
-- THE SELF FOREIGN KEY CASCADES, which in Postgres deletes a whole subtree in one
-- statement when its root goes. That is the intent (deleting a section deletes
-- what was filed under it), and it is also why the application refuses to create
-- a cycle in this column: a cyclic parent chain is not merely wrong data, it is a
-- page render that never terminates. See `wouldCycle` in src/lib/documents.ts.
--
-- No `position` column: siblings are ordered by title. Adding hand-set ordering
-- later is one more additive migration.

-- CreateTable
CREATE TABLE "Document" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "parentId" TEXT,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Document_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Document_projectId_parentId_idx" ON "Document"("projectId", "parentId");

-- CreateIndex
CREATE INDEX "Document_parentId_idx" ON "Document"("parentId");

-- AddForeignKey
ALTER TABLE "Document" ADD CONSTRAINT "Document_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Document" ADD CONSTRAINT "Document_parentId_fkey" FOREIGN KEY ("parentId") REFERENCES "Document"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Document" ADD CONSTRAINT "Document_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
