import { randomUUID } from 'node:crypto';
import { z } from 'zod';

import {
  AuthzError,
  findPublicAttachment,
  isNextControlFlowError,
  requireAttachment,
} from '@/lib/authz';
import { objectUrl } from '@/lib/bucket';

/**
 * Serve one attachment: `GET /api/attachments/<id>`.
 *
 * This is the `src` of every `<img>` a description or comment renders, and it is
 * a REDIRECT, not a proxy. The response is a 302 to a presigned bucket URL that
 * expires in five minutes, so the image bytes travel from the bucket to the
 * browser and never through this process -- bucket egress is free where service
 * egress is billed, and a 10 MB screenshot does not occupy a server connection
 * for the length of someone's hotel wifi.
 *
 * TWO CONSEQUENCES OF THE REDIRECT, both load bearing:
 *
 *   1. THE PAGE CSP MUST ALLOW THE BUCKET ORIGIN. A CSP fetch directive is
 *      re-checked on every redirect hop, so `img-src 'self'` alone blocks the
 *      bucket even though the browser only ever asked this origin for the image.
 *      `next.config.ts` adds `S3_ENDPOINT` to `img-src` for exactly this reason,
 *      AT BUILD TIME -- see the warning there before debugging a blocked image.
 *
 *   2. THE REDIRECT ITSELF MUST NOT BE CACHED. `private, no-store` is what keeps
 *      a five-minute credential out of the disk cache and out of any shared cache
 *      in front of the app, and it is what makes revoked access take effect on the
 *      next request rather than whenever a cached 302 happens to expire.
 *
 * GET AND STATE: nothing here mutates (SPEC 4.6's binding rule). The one write on
 * this path is the idempotent session-expiry extension inside `readSession`, which
 * is the carve-out the rule already names.
 *
 * A missing attachment, an attachment in another tenant and a signed-out caller
 * are all 404 -- `requireAttachment` derives access in one query, so there is no
 * separate 403 to leak the existence of an issue from.
 *
 * THE ONE EXCEPTION IS A PUBLISHED DOCUMENT. A shared page renders
 * `![shot](/api/attachments/<id>)` like any other body, and its reader has no
 * session -- so without the second lookup below every screenshot in a shared
 * document would be a broken image for exactly the person it was sent to. That
 * lookup is narrow and is checked SECOND, after the membership walk has already
 * failed: an attachment is servable this way only while a document in its own
 * project both carries a `shareToken` and names this id in its body. Revoking the
 * share closes the image in the same query, with nothing else to remember.
 */

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Five minutes: long enough for a slow connection, short enough to be a leak. */
const URL_TTL_SECONDS = 5 * 60;

/**
 * `private, no-store` on the redirect. Nothing stops the browser caching the
 * BYTES it fetches from the bucket -- that response is the bucket's to control --
 * and that is the intended split: the image may be cached, the credential may not.
 */
const NO_STORE = { 'Cache-Control': 'private, no-store' } as const;

/**
 * A uuid, because the upload route mints one (see `Attachment.id` in the schema).
 * Shape only: the row is still resolved through the authorization walk.
 */
const idSchema = z.string().uuid();

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await params;

  // A segment that cannot be an id is a 404 without touching the database.
  if (!idSchema.safeParse(id).success) {
    return new Response(null, { status: 404, headers: NO_STORE });
  }

  /** The 302 both paths below answer with, once a key has been proved. */
  const serve = (key: string): Response =>
    // Hand-built rather than `Response.redirect`, which accepts no headers and so
    // cannot carry the `no-store` that keeps the signed URL out of caches.
    new Response(null, {
      status: 302,
      headers: { ...NO_STORE, Location: objectUrl(key, URL_TTL_SECONDS) },
    });

  try {
    const ctx = await requireAttachment(id);
    return serve(ctx.attachment.key);
  } catch (e) {
    if (isNextControlFlowError(e)) throw e;

    if (e instanceof AuthzError) {
      // The member walk said no. It may still be an image inside a document
      // somebody published -- that is a different question about the ROW, not
      // about the caller, and it is asked only here, after the first one failed.
      const shared = await findPublicAttachment(id);
      if (shared) return serve(shared.key);

      // 401 only for a missing session, so a signed-out browser is told to sign
      // in rather than shown a broken image forever. Everything else is 404.
      const status = e.kind === 'UNAUTHENTICATED' ? 401 : 404;
      return new Response(null, { status, headers: NO_STORE });
    }

    // Never the error: a presigning failure's message can carry the credential.
    console.error(`[attachments] serve_failed ref=${randomUUID().slice(0, 8)}`);
    return new Response(null, { status: 500, headers: NO_STORE });
  }
}
