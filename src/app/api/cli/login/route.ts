import { randomUUID } from 'node:crypto';

import { isNextControlFlowError } from '@/lib/authz';
import { ERRORS } from '@/lib/result';
import { rotatePresentedSession } from '@/lib/session';
import { attemptSignIn } from '@/lib/sign-in';

/**
 * Sign-in for non-browser clients — the `flone` CLI is the only one today.
 *
 * SPEC §1 rules out a REST/JSON API, and this is not one: it exposes no
 * resource, and every board, ticket and comment still goes through `/api/mcp`.
 * It exists because a Server Action is only callable from a browser, so the one
 * thing a CLI cannot do over the MCP endpoint is obtain the token that endpoint
 * requires. That is the whole surface — two verbs, no nouns.
 *
 * The credential checks are NOT here. They are in `@/lib/sign-in`, shared
 * verbatim with the browser's `signIn` action: same rate limits consumed before
 * hashing, same dummy hash on the unknown-email branch, same single failure
 * literal, same email-verification gate positioned after the password check.
 *
 * This route sets NO cookie, and that is deliberate. The token goes back in the
 * body, so a cross-site POST — which cannot read the response without CORS, and
 * this route grants none — achieves nothing. There is no CSRF surface to add a
 * token for.
 */

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const NO_STORE = { 'Cache-Control': 'no-store' } as const;

function json(body: unknown, status: number): Response {
  return Response.json(body, { status, headers: NO_STORE });
}

/** One status per outcome. Each maps onto a message the body already carries. */
const STATUS = {
  INVALID: 401,
  RATE_LIMITED: 429,
  UNVERIFIED: 403,
} as const;

export async function POST(request: Request): Promise<Response> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    // Same literal as a wrong password: a malformed body must not be
    // distinguishable from a bad credential by anything but the status.
    return json({ error: ERRORS.INVALID_CREDENTIALS }, STATUS.INVALID);
  }

  const { email, password } = (body ?? {}) as { email?: unknown; password?: unknown };

  try {
    const outcome = await attemptSignIn(email, password);

    if (!outcome.ok) return json({ error: outcome.error }, STATUS[outcome.reason]);

    return json(
      {
        token: outcome.token,
        expiresAt: outcome.expiresAt.toISOString(),
        user: { name: outcome.user.name, email: outcome.user.email },
      },
      200,
    );
  } catch (e) {
    if (isNextControlFlowError(e)) throw e;
    // Never `e.message` — a short code plus a correlation id (SPEC §4.7).
    console.error(`[cli/login] unexpected_failure ref=${randomUUID().slice(0, 8)}`);
    return json({ error: ERRORS.UNEXPECTED }, 500);
  }
}

/**
 * Sign out: destroy the session presented as `Authorization: Bearer <token>`.
 *
 * `rotatePresentedSession()` reads the presented credential and deletes its
 * row — despite the name, minting a replacement is the caller's job and this
 * caller does not. Without this, `flone logout` could only forget a token
 * locally and would leave a live 30-day credential behind it.
 *
 * Unauthenticated and already-revoked both answer 204: logout is idempotent,
 * and a token that is gone is exactly the state being asked for.
 */
export async function DELETE(): Promise<Response> {
  try {
    await rotatePresentedSession();
  } catch (e) {
    if (isNextControlFlowError(e)) throw e;
    console.error(`[cli/logout] unexpected_failure ref=${randomUUID().slice(0, 8)}`);
    return json({ error: ERRORS.UNEXPECTED }, 500);
  }
  return new Response(null, { status: 204, headers: NO_STORE });
}
