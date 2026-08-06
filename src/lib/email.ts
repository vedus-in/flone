import 'server-only';
import { randomUUID } from 'node:crypto';
import type { ReactElement } from 'react';
import { after } from 'next/server';
import { render } from 'react-email';

/**
 * Email transport.
 *
 * Design: docs/superpowers/specs/2026-08-06-email-design.md
 *
 * One POST to Resend. The `resend` package is not a dependency: it wraps a
 * single request behind a bearer header, and this codebase already prefers the
 * runtime's own primitives (`node:crypto` for hashing and tokens) over packages
 * that wrap them.
 *
 * NOTHING HERE THROWS. Mail delivery is never allowed to fail a Server Action:
 * an issue that was assigned stays assigned whether or not Resend was
 * reachable. Every failure is one log line carrying a correlation id and a
 * status code -- never a recipient, never a token, never a link, never the
 * response body (SPEC 4.7).
 */

const ENDPOINT = 'https://api.resend.com/emails';

/** Resend is not permitted to hold a Node worker open indefinitely. */
const TIMEOUT_MS = 10_000;

export type Mail = { to: string; subject: string; html: string; text: string };

const isProduction = () => process.env.NODE_ENV === 'production';

/* -------------------------------------------------------------------------- */
/* Links                                                                       */
/* -------------------------------------------------------------------------- */

/**
 * The base every emailed link is built from.
 *
 * DELIBERATELY NOT DERIVED FROM THE REQUEST. Building a verification or reset
 * link out of `Host` / `X-Forwarded-Host` is host-header poisoning: an attacker
 * sets the header, the victim receives a genuine mail sent by the real system,
 * and the link hands the one-time token to the attacker's domain. The same
 * distrust of client-controllable proxy headers is already written down in
 * `src/lib/rate-limit.ts`; here the stakes are a credential rather than a rate
 * bucket.
 *
 * Required in production -- `sendMail` refuses to send without it, so a message
 * carrying a wrong link never leaves the process.
 */
function baseUrl(): string | null {
  const configured = process.env.APP_URL?.trim();
  if (configured) return configured.replace(/\/+$/, '');
  return isProduction() ? null : 'http://localhost:3000';
}

/** Absolute URL for an app path. `path` must start with `/`. */
export function appUrl(path: string): string {
  return `${baseUrl() ?? 'http://localhost:3000'}${path}`;
}

/**
 * A one-time link carrying a token. The token rides in the query string, which
 * is the only place a link can carry it; every route that reads one consumes it
 * immediately and redirects, so it does not persist in the address bar.
 */
export function tokenUrl(path: string, token: string): string {
  return `${appUrl(path)}?token=${encodeURIComponent(token)}`;
}

/* -------------------------------------------------------------------------- */
/* Send                                                                        */
/* -------------------------------------------------------------------------- */

export async function sendMail(mail: Mail): Promise<void> {
  const ref = randomUUID().slice(0, 8);
  const apiKey = process.env.RESEND_API_KEY?.trim();

  if (!apiKey) {
    // A PRODUCTION instance with no key is misconfigured, and must say so
    // WITHOUT printing the message. The body carries one-time verification,
    // reset and invitation links; writing those to a log hands anyone with log
    // access a working credential for any account on the instance. The
    // environment check is the whole control here -- do not collapse these two
    // branches back together.
    if (isProduction()) {
      console.error(`[email] not_configured ref=${ref}`);
      return;
    }

    // Development only: print the message instead of sending it, links and all,
    // so a fresh checkout can click through registration, reset and invitations
    // with no Resend account. Reachable only when NODE_ENV is not production.
    console.info(
      `[email] dev_no_key ref=${ref} to=${mail.to} subject=${mail.subject}\n${mail.text}`,
    );
    return;
  }

  const from = process.env.EMAIL_FROM?.trim();
  if (!from || !baseUrl()) {
    // Misconfigured rather than unconfigured: a key is present, so this is a
    // production instance missing EMAIL_FROM or APP_URL. Sending now would
    // deliver a real mail with a broken or attacker-suppliable link.
    console.error(`[email] not_configured ref=${ref}`);
    return;
  }

  try {
    const response = await fetch(ENDPOINT, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${apiKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        from,
        to: [mail.to],
        subject: mail.subject,
        html: mail.html,
        text: mail.text,
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });

    if (!response.ok) {
      // Status only. The body can echo the recipient address back.
      console.error(`[email] send_failed ref=${ref} status=${response.status}`);
    }
  } catch {
    // Network error, DNS failure, or the timeout above.
    console.error(`[email] send_error ref=${ref}`);
  }
}

/**
 * Render and send after the response has been flushed.
 *
 * `after()` is the native Next 15 mechanism, so there is no queue, no worker and
 * no retry. A dropped message is always recoverable by the user -- resend the
 * verification, request another reset link -- which is why a retry layer would
 * not earn its weight. Rendering happens in here too, so a caller never waits on
 * it either.
 */
export function queueMail(to: string, subject: string, element: ReactElement): void {
  after(async () => {
    try {
      const [html, text] = await Promise.all([
        render(element),
        render(element, { plainText: true }),
      ]);
      await sendMail({ to, subject, html, text });
    } catch {
      // A template that throws must not take the request's `after` callback --
      // and with it any other queued work -- down with it.
      console.error(`[email] render_failed ref=${randomUUID().slice(0, 8)}`);
    }
  });
}
