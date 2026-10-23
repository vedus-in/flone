import 'server-only';
import { randomUUID } from 'node:crypto';
import type { ReactElement } from 'react';
import { after } from 'next/server';
import { render } from 'react-email';
import { createTransport } from 'nodemailer';

/**
 * Email transport.
 *
 * Design: docs/superpowers/specs/2026-08-06-email-design.md
 *
 * Two transports, picked by configuration: Resend when `RESEND_API_KEY` is
 * set, otherwise SMTP when `SMTP_HOST` is set. Resend is one POST, so the
 * `resend` package is not a dependency: it wraps a single request behind a
 * bearer header. SMTP is not one request -- STARTTLS, AUTH and MIME multipart
 * are a protocol, not a few lines -- so that one goes through `nodemailer`.
 * SMTP is what lets a self-hosted instance use whatever mail server it already
 * has.
 *
 * NOTHING HERE THROWS. Mail delivery is never allowed to fail a Server Action:
 * an issue that was assigned stays assigned whether or not the provider was
 * reachable. Every failure is one log line carrying a correlation id and a
 * status code -- never a recipient, never a token, never a link, never the
 * response body (SPEC 4.7).
 */

const ENDPOINT = 'https://api.resend.com/emails';

/** No provider is permitted to hold a Node worker open indefinitely. */
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

type Transport = 'resend' | 'smtp';

/** Resend wins when both are configured, so adding SMTP changes no live instance. */
function configuredTransport(): Transport | null {
  if (process.env.RESEND_API_KEY?.trim()) return 'resend';
  if (process.env.SMTP_HOST?.trim()) return 'smtp';
  return null;
}

export async function sendMail(mail: Mail): Promise<void> {
  const ref = randomUUID().slice(0, 8);
  const transport = configuredTransport();

  if (!transport) {
    // A PRODUCTION instance with no transport is misconfigured, and must say so
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
    // with no mail provider. Reachable only when NODE_ENV is not production.
    console.info(
      `[email] dev_no_key ref=${ref} to=${mail.to} subject=${mail.subject}\n${mail.text}`,
    );
    return;
  }

  const from = process.env.EMAIL_FROM?.trim();
  if (!from || !baseUrl()) {
    // Misconfigured rather than unconfigured: a transport is present, so this is
    // a production instance missing EMAIL_FROM or APP_URL. Sending now would
    // deliver a real mail with a broken or attacker-suppliable link.
    console.error(`[email] not_configured ref=${ref}`);
    return;
  }

  if (transport === 'resend') {
    await sendViaResend(mail, from, ref);
  } else {
    await sendViaSmtp(mail, from, ref);
  }
}

async function sendViaResend(mail: Mail, from: string, ref: string): Promise<void> {
  try {
    const response = await fetch(ENDPOINT, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${process.env.RESEND_API_KEY?.trim()}`,
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
 * `SMTP_SECURE` means TLS from the first byte (port 465). Left unset it follows
 * the port, and on any other port nodemailer upgrades with STARTTLS when the
 * server offers it. With credentials configured that upgrade is REQUIRED: a
 * server that quietly stops offering STARTTLS must not receive a password in
 * the clear. An unauthenticated relay (a local Postfix, a test catcher) is
 * allowed to stay plain.
 *
 * Null when the port is not a port, so a typo is `not_configured` rather than a
 * connection attempt to somewhere unintended.
 */
function smtpOptions() {
  const port = Number(process.env.SMTP_PORT?.trim() || 587);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) return null;

  const secureSetting = process.env.SMTP_SECURE?.trim().toLowerCase();
  const secure = secureSetting ? secureSetting === 'true' : port === 465;
  const user = process.env.SMTP_USER?.trim();

  return {
    host: process.env.SMTP_HOST?.trim(),
    port,
    secure,
    requireTLS: !secure && Boolean(user),
    auth: user ? { user, pass: process.env.SMTP_PASSWORD ?? '' } : undefined,
    connectionTimeout: TIMEOUT_MS,
    greetingTimeout: TIMEOUT_MS,
    socketTimeout: TIMEOUT_MS,
  };
}

async function sendViaSmtp(mail: Mail, from: string, ref: string): Promise<void> {
  const options = smtpOptions();
  if (!options) {
    console.error(`[email] not_configured ref=${ref}`);
    return;
  }

  try {
    await createTransport(options).sendMail({
      from,
      to: mail.to,
      subject: mail.subject,
      html: mail.html,
      text: mail.text,
    });
  } catch (error) {
    // The SMTP response code only. The error message can carry the recipient
    // address, or the server's whole reply to it.
    const code = (error as { responseCode?: number }).responseCode;
    console.error(
      code ? `[email] send_failed ref=${ref} status=${code}` : `[email] send_error ref=${ref}`,
    );
  }
}

/**
 * Render both parts and send. NEVER THROWS, exactly like `sendMail`: a template
 * that blows up is one log line, not a failed caller.
 *
 * Awaited directly by the reminder scheduler, which is not serving a browser and
 * so has no response for `after()` to run behind -- and which wants the send
 * finished before the process is free to exit.
 */
export async function renderAndSend(
  to: string,
  subject: string,
  element: ReactElement,
): Promise<void> {
  try {
    const [html, text] = await Promise.all([
      render(element),
      render(element, { plainText: true }),
    ]);
    await sendMail({ to, subject, html, text });
  } catch {
    console.error(`[email] render_failed ref=${randomUUID().slice(0, 8)}`);
  }
}

/**
 * Render and send after the response has been flushed.
 *
 * `after()` is the native Next 15 mechanism, so there is no queue, no worker and
 * no retry. A dropped message is always recoverable by the user -- resend the
 * verification, request another reset link -- which is why a retry layer would
 * not earn its weight. Rendering happens in there too, so a caller never waits
 * on it either.
 */
export function queueMail(to: string, subject: string, element: ReactElement): void {
  // The callback must not throw: it would take any other work queued on this
  // request down with it. `renderAndSend` already swallows everything.
  after(() => renderAndSend(to, subject, element));
}
