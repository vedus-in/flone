import { randomUUID } from 'node:crypto';

import {
  ATTACHMENT_ERRORS,
  attachmentKey,
  sanitizeFilename,
  validateUpload,
} from '@/lib/attachments';
import { AuthzError, isNextControlFlowError, requireTicket, requireUser } from '@/lib/authz';
import { bucketConfig, putObject } from '@/lib/bucket';
import { prisma } from '@/lib/db';
import { ERRORS } from '@/lib/result';
import { LIMITS, consume, uploadUserKey } from '@/lib/rate-limit';
import { cuid } from '@/lib/validation';

/**
 * Image upload: `POST /api/attachments`, multipart, one file per call.
 *
 * WHY A ROUTE HANDLER AND NOT A SERVER ACTION. Actions are capped at
 * `bodySizeLimit: '512kb'` (SPEC 4.8) and that cap is global -- raising it to
 * 10 MB to carry a screenshot would raise it for every form in the application,
 * including the unauthenticated ones. A route handler takes the body without
 * moving that ceiling for anything else. This is the third route handler in the
 * repo and, like the other two, it exposes no resource: one verb, no nouns, and
 * no way to enumerate anything.
 *
 * CSRF: the same argument as `/api/mcp` (SPEC 4.6, as amended). `sameSite='lax'`
 * omits the session cookie from a cross-site POST, so a forged upload arrives
 * unauthenticated and is refused by `requireUser`. A cross-site caller cannot set
 * an `Authorization` header either. The response is JSON with no CORS, so nothing
 * cross-origin can read it even if it could send it.
 *
 * AUTHORIZATION IS THE TICKET'S, not the file's: `requireTicket` walks the
 * client-supplied `ticketId` up to its organization inside one query, so a member
 * of another tenant gets the same 404 as a nonexistent issue. Any member who can
 * see an issue can attach to it -- the same rule as editing its description,
 * which is what the image ends up inside.
 */

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const NO_STORE = { 'Cache-Control': 'no-store' } as const;

function json(body: unknown, status: number): Response {
  return Response.json(body, { status, headers: NO_STORE });
}

export async function POST(request: Request): Promise<Response> {
  try {
    // A missing bucket is a server-configuration answer, not a bad request, and
    // it is checked before anything is parsed: uploading 10 MB only to discover
    // there is nowhere to put it wastes the user's connection.
    if (!bucketConfig()) {
      console.error('[attachments] not_configured');
      return json({ error: ATTACHMENT_ERRORS.NOT_CONFIGURED }, 503);
    }

    const user = await requireUser();

    // Keyed on the USER, not the IP: every uploader is an authenticated member,
    // and the thing being rationed is bucket space rather than CPU. It caps what
    // one compromised or careless account can write in an hour and nothing else.
    if (!consume(uploadUserKey(user.id), LIMITS.UPLOAD_USER.limit, LIMITS.UPLOAD_USER.windowMs)) {
      return json({ error: ERRORS.RATE_LIMITED }, 429);
    }

    const form = await request.formData();

    const parsedTicketId = cuid.safeParse(form.get('ticketId'));
    if (!parsedTicketId.success) return json({ error: ERRORS.NOT_FOUND }, 404);

    const file = form.get('file');
    if (!(file instanceof File)) return json({ error: ATTACHMENT_ERRORS.NO_FILE }, 400);

    const rejection = validateUpload(file);
    if (rejection) return json({ error: rejection }, 400);

    // The authorization walk. Everything above this line is shape checking.
    const ctx = await requireTicket(parsedTicketId.data);

    const filename = sanitizeFilename(file.name);
    // The id is minted here rather than by Prisma's default, because the object
    // key contains it and the object is written BEFORE the row: a failed PUT must
    // not leave a row pointing at nothing, and the reverse -- an object with no
    // row -- is just an orphan nobody can reach.
    const id = randomUUID();
    const key = attachmentKey(ctx.ticket.id, id, filename);

    await putObject(key, await file.arrayBuffer(), file.type);

    await prisma.attachment.create({
      data: {
        id,
        ticketId: ctx.ticket.id,
        key,
        filename,
        mimeType: file.type,
        size: file.size,
        uploadedById: user.id,
      },
    });

    // A relative URL, so it works under any origin and needs no `APP_URL`.
    return json({ id, url: `/api/attachments/${id}`, filename }, 201);
  } catch (e) {
    if (isNextControlFlowError(e)) throw e;

    if (e instanceof AuthzError) {
      switch (e.kind) {
        case 'UNAUTHENTICATED':
          return json({ error: ERRORS.UNAUTHENTICATED }, 401);
        case 'FORBIDDEN':
          return json({ error: ERRORS.FORBIDDEN }, 403);
        default:
          return json({ error: ERRORS.NOT_FOUND }, 404);
      }
    }

    // A short code plus a correlation id -- never the error, which for a failed
    // PUT carries the presigned URL, and that URL is a credential (SPEC 4.7).
    console.error(`[attachments] upload_failed ref=${randomUUID().slice(0, 8)}`);
    return json({ error: ATTACHMENT_ERRORS.FAILED }, 500);
  }
}
