/**
 * SPEC §4.11 — the Server Action return contract.
 *
 * This is one of TWO lib modules deliberately NOT `server-only`: client
 * components import the `ActionResult` type for `useActionState`. The other is
 * `attachments.ts`, whose upload rules the browser applies before starting an
 * upload the server would only refuse -- see its header for why sharing the module
 * beats copying the values.
 *
 * `error` must be one of the `ERRORS` literals or a specific, closed,
 * user-meaningful literal declared in the action's own file
 * (e.g. `'That key is already in use.'`). Never return `String(e)`, a Prisma
 * error message, or a Prisma error code.
 */

export type ActionResult =
  | { ok: true; message?: string }
  | { ok: false; error: string; fieldErrors?: Record<string, string> };

export const ERRORS = {
  UNAUTHENTICATED: 'You are signed out. Please sign in again.',
  INVALID_CREDENTIALS: 'Invalid email or password.',
  NOT_FOUND: 'Not found.',
  FORBIDDEN: "You don't have permission to do that.",
  RATE_LIMITED: 'Too many attempts. Try again in a few minutes.',
  UNEXPECTED: 'Something went wrong.',
} as const;

export type ErrorLiteral = (typeof ERRORS)[keyof typeof ERRORS];

/** Convenience constructors so actions never hand-roll the shape. */
export function ok(message?: string): ActionResult {
  return message === undefined ? { ok: true } : { ok: true, message };
}

export function fail(error: string, fieldErrors?: Record<string, string>): ActionResult {
  return fieldErrors === undefined ? { ok: false, error } : { ok: false, error, fieldErrors };
}
