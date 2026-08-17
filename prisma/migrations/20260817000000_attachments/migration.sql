-- Image attachments: one table. No change to any existing table, nothing
-- backfilled, nothing rewritten -- every organization, project, issue and comment
-- is byte-identical after this runs.
--
-- INSERTs nothing, so there is no id to mint here and no `gen_random_uuid()`
-- DEFAULT either: `Attachment.id` is the one id in this schema the application
-- always supplies itself (`randomUUID()` in the upload route), because the bucket
-- object key embeds it and the object is written before the row. A DEFAULT here
-- would be dead code that quietly disagrees with the Prisma schema.
--
-- `ticketId` cascades so the rows follow the issue. The BUCKET OBJECTS cannot:
-- nothing in Postgres can reach a bucket, so `purgeTicketAttachments` deletes
-- them best-effort before the row goes. `uploadedById` is Restrict, matching
-- `Comment.authorId` -- a user with authored content is not hard-deletable.

-- CreateTable
CREATE TABLE "Attachment" (
    "id" TEXT NOT NULL,
    "ticketId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "filename" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "size" INTEGER NOT NULL,
    "uploadedById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Attachment_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Attachment_ticketId_idx" ON "Attachment"("ticketId");

-- AddForeignKey
ALTER TABLE "Attachment" ADD CONSTRAINT "Attachment_ticketId_fkey" FOREIGN KEY ("ticketId") REFERENCES "Ticket"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Attachment" ADD CONSTRAINT "Attachment_uploadedById_fkey" FOREIGN KEY ("uploadedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
