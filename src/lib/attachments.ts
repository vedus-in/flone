/**
 * What an attachment is allowed to be, and how it is named in the bucket.
 *
 * Everything here is pure, and asserted by `scripts/check-bucket.ts`. It is also
 * the trust boundary: `accept="image/*"` on the file input is a convenience for
 * the file picker and nothing more, and a `POST` to `/api/attachments` never has
 * to have come from that input at all.
 *
 * NO `import 'server-only'`, and the second lib module without one (`result.ts` is
 * the other). The browser needs these rules too -- refusing a dropped PDF has to
 * be immediate and has to say something, and a 25 MB file should not be uploaded
 * just to be told no. THE POINT IS THAT IT IS THE SAME MODULE: a copy of the
 * allowlist in a client component is a copy that drifts, and the day it drifts the
 * browser and the server disagree about what is allowed. Nothing here is a secret
 * and nothing here touches a credential, so there is nothing to leak by bundling
 * it. `bucket.ts` -- which does hold the credential -- keeps its guard.
 *
 * NO DATABASE AND NO BUCKET IMPORT, on purpose, and now doubly so: the cleanup
 * that needs both lives at its one call site, beside `deleteIssue`.
 */

/**
 * The four raster formats a screenshot is ever pasted as, and nothing else.
 *
 * NO SVG, deliberately and permanently. An SVG is a document: it can carry
 * `<script>`, and the browser executes it when the file is opened as a top-level
 * document -- which the serve route's redirect makes trivially possible. It would
 * be same-origin XSS delivered through an `<img>` tag, so it is excluded here
 * rather than mitigated downstream.
 */
export const IMAGE_MIME_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'] as const;

export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;

/** Closed literals, in one place, so a route and a check cannot drift apart. */
export const ATTACHMENT_ERRORS = {
  NO_FILE: 'Choose an image to attach.',
  WRONG_TYPE: 'Only PNG, JPEG, GIF and WebP images can be attached.',
  TOO_LARGE: 'That image is larger than 10 MB.',
  NOT_CONFIGURED: 'Image attachments are not configured on this server.',
  FAILED: 'That image could not be uploaded. Try again.',
} as const;

/**
 * Accepts or rejects a candidate upload on its declared type and its real size.
 *
 * THE MIME TYPE IS THE CLIENT'S CLAIM, and v1 takes it at face value: a `.exe`
 * renamed to `.png` is refused because the browser reports
 * `application/octet-stream` for it, but a genuinely crafted request can lie.
 * That is an accepted limit, not an oversight -- the bytes are never executed,
 * never served from this origin (the serve route redirects to the bucket), and
 * never re-encoded, so a lying mime type buys the liar a file in a private
 * bucket. Magic-byte sniffing is the upgrade if that ever stops being true.
 *
 * The size is the file's OWN length, not a declared header, so it cannot be
 * understated. `size === 0` is refused: an empty image is a failed screenshot
 * capture, and storing it just makes a broken image in someone's description.
 */
export function validateUpload(file: { type: string; size: number }): string | null {
  if (file.size === 0) return ATTACHMENT_ERRORS.NO_FILE;
  if (!(IMAGE_MIME_TYPES as readonly string[]).includes(file.type)) {
    return ATTACHMENT_ERRORS.WRONG_TYPE;
  }
  if (file.size > MAX_ATTACHMENT_BYTES) return ATTACHMENT_ERRORS.TOO_LARGE;
  return null;
}

/**
 * A filename safe to put in an object key, in alt text, and in a log line.
 *
 * Everything outside `[A-Za-z0-9._-]` collapses to a hyphen, which takes care of
 * `../`, of absolute paths, of a Windows `C:\` prefix, of control characters and
 * of the whole class of "the name was also a command". Leading dots go too, so a
 * name cannot start a hidden file or be `..`.
 *
 * The result is decoration: the key's uniqueness comes from the row's cuid, so a
 * name that sanitizes down to nothing is simply replaced with `image`.
 */
export function sanitizeFilename(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? '';
  const cleaned = base
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^[.-]+/, '')
    .slice(0, 80);
  return cleaned.length > 0 ? cleaned : 'image';
}

/**
 * `attachments/<projectId>/<attachmentId>-<sanitized filename>`.
 *
 * Traceable without the database, which is the whole point of the shape: someone
 * looking at a bucket listing at 3am can tell which project an object belongs to
 * and what it was called, with no query and no export.
 *
 * THE PROJECT, NOT THE ISSUE. An image can be pasted into an issue that does not
 * exist yet, and an object key cannot be rewritten later -- an object is not
 * renamed, it is copied and deleted. So the key names the one owner that is always
 * known and never changes. Rows written before this used the issue id; nothing
 * rewrites them, because the key is opaque and always read from the row.
 */
export function attachmentKey(
  projectId: string,
  attachmentId: string,
  filename: string,
): string {
  return `attachments/${projectId}/${attachmentId}-${sanitizeFilename(filename)}`;
}

/* -------------------------------------------------------------------------- */
/* Saying no, in words                                                         */
/* -------------------------------------------------------------------------- */

/** Kept in one place: the sentence and the allowlist must not drift apart. */
const ALLOWED_LABEL = 'PNG, JPEG, GIF and WebP';
const LIMIT_LABEL = '10 MB';

/** One decimal, because "24.4 MB" answers "how far over?" and "24 MB" does not. */
function formatBytes(size: number): string {
  if (size < 1024) return `${size} bytes`;
  if (size < 1024 * 1024) return `${Math.round(size / 1024)} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

/** A pathological filename must not be able to push the layout around. */
function trimName(name: string): string {
  const clean = name.replace(/\s+/g, ' ').trim();
  return clean.length > 48 ? `${clean.slice(0, 47)}…` : clean;
}

/**
 * What to tell someone who just dropped the wrong thing, or null when nothing was
 * refused.
 *
 * SILENCE WAS THE BUG THIS FIXES. Dropping a PDF on a comment box used to do
 * nothing at all -- no upload, no message, no clue that the file was even seen --
 * which reads as a broken feature rather than as a refused file. So the message
 * names the file, says why, and says what would work instead.
 *
 * It re-runs `validateUpload` rather than taking a reason as an argument, so the
 * words can never describe a rule the server does not actually apply.
 */
export function rejectionMessage(
  rejected: ReadonlyArray<{ name: string; type: string; size: number }>,
): string | null {
  if (rejected.length === 0) return null;

  if (rejected.length > 1) {
    return `${rejected.length} files were not attached. ${ALLOWED_LABEL} images only, up to ${LIMIT_LABEL} each.`;
  }

  const file = rejected[0];
  const name = trimName(file.name);

  switch (validateUpload(file)) {
    case ATTACHMENT_ERRORS.TOO_LARGE:
      return `“${name}” is ${formatBytes(file.size)}. Images must be ${LIMIT_LABEL} or smaller.`;
    case ATTACHMENT_ERRORS.NO_FILE:
      return `“${name}” is empty, so there is nothing to attach.`;
    default:
      return `“${name}” is not an image that can be attached. ${ALLOWED_LABEL} only, up to ${LIMIT_LABEL}.`;
  }
}
