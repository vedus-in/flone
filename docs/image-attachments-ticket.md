Add the ability to attach images to tickets: paste from clipboard, drag-and-drop, or pick a file. Images render inline in the ticket description and comments.

## Storage decision

Railway bucket (S3-compatible), created inside the existing flone Railway project.

- $0.015/GB-month, free egress, free unlimited API operations — same storage price as Cloudflare R2, but no separate Cloudflare account, and credentials auto-inject into the service as env vars (`BUCKET`, `ACCESS_KEY_ID`, `SECRET_ACCESS_KEY`, `ENDPOINT`, `REGION`).
- Expected cost at ticket-screenshot scale: ~10 GB ≈ $0.15/month.
- Buckets are private; images are served via short-lived presigned URLs.

## Data model

New Prisma model `Attachment`:

- `id`, `ticketId` (FK, cascade delete), `key` (bucket object key), `filename`, `mimeType`, `size`, `uploadedById`, `createdAt`.
- Object key format: `attachments/<ticketId>/<attachmentId>-<sanitized-filename>` so bucket contents are traceable without the DB.

## API

**`POST /api/attachments`** — multipart upload.

- Auth: session user must have access to the target ticket (reuse existing authz helpers).
- Validate: `mimeType` must be `image/png|jpeg|gif|webp`; max size 10 MB. Reject anything else with a 4xx — this is a trust boundary, don't rely on the client accept filter.
- Put object to bucket (Bun's built-in S3 client — zero new dependencies), create `Attachment` row, return `{ id, url: "/api/attachments/<id>", filename }`.

**`GET /api/attachments/[id]`** — serve.

- Auth-check the user against the attachment's ticket, then 302-redirect to a ~5-minute presigned GET URL. The redirect keeps image bytes on free bucket egress instead of billed service egress.
- `Cache-Control: private, no-store` on the redirect itself.

**Deletion** — when a ticket is deleted, delete its attachment rows and bucket objects (best-effort on the bucket side; orphaned objects are pennies, log and move on).

## UI

On the ticket description editor and the comment box:

- `onPaste`: if `clipboardData.files` contains an image, upload it and insert `![filename](/api/attachments/<id>)` at the cursor.
- `onDrop`: same handler for dropped image files.
- An attach button: `<input type="file" accept="image/*">`, same upload path.
- While uploading, insert a `![uploading filename…]()` placeholder and replace it on success; remove it and toast on failure.
- Rendering comes free: descriptions/comments already render through react-markdown, so `![](...)` just works. Confirm the markdown sanitizer/allowlist permits relative `/api/attachments/...` image sources.

## Infra

- Create bucket `flone-attachments` in the flone Railway project, attach the credential variables to the app service.
- Local dev: point the same env vars at the same bucket or a dev bucket — no code difference.

## Acceptance criteria

- Pasting a screenshot into a ticket description or comment uploads it and shows the image inline after save.
- Drag-and-drop and the attach button do the same.
- A user without access to the ticket gets 403/404 from both upload and serve routes.
- A 25 MB file or a `.exe` renamed to `.png` (wrong magic bytes not required — mime check is enough for v1) is rejected with a clear error.
- Deleting a ticket removes its attachments from the DB.
- MCP `ticket read` output is unaffected (image markdown appears as-is in the description text).

## Out of scope (v1)

- Non-image attachments (PDFs etc.) — model and routes don't preclude it, just not built.
- Image resizing/thumbnailing — serve originals.
- Public/shareable image links — everything stays behind auth.
