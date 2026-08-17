import 'server-only';

/**
 * What an attachment is allowed to be, and how it is named in the bucket.
 *
 * Everything here is pure, and asserted by `scripts/check-bucket.ts`. It is also
 * the trust boundary: `accept="image/*"` on the file input is a convenience for
 * the file picker and nothing more, and a `POST` to `/api/attachments` never has
 * to have come from that input at all.
 *
 * NO DATABASE AND NO BUCKET IMPORT, on purpose. The rules are the part worth
 * testing without a Postgres connection or a credential, so the cleanup that
 * needs both lives at its one call site, beside `deleteIssue`.
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
