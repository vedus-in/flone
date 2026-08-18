-- A document can be published on a link: `Document.shareToken`, null by default.
--
-- Additive and nullable, so every existing row is private the moment this lands
-- and stays private until somebody publishes it deliberately. There is nothing to
-- backfill, and no window in which a document is readable that was not before.
--
-- The UNIQUE index is load bearing rather than tidy: the public route looks a
-- document up BY TOKEN, and that lookup is the entire authorization. A duplicate
-- token would make one link resolve to two documents.
--
-- Revoking sets the column back to NULL. Re-publishing mints a fresh token, so an
-- old URL 404s forever instead of coming back to life -- which is why nothing here
-- keeps a history of previous tokens.

-- AlterTable
ALTER TABLE "Document" ADD COLUMN "shareToken" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "Document_shareToken_key" ON "Document"("shareToken");
