import { createHash, timingSafeEqual } from 'node:crypto';

/**
 * The voice service. Places one call, speaks one sentence, hangs up.
 *
 * Design: docs/superpowers/specs/2026-08-12-reminder-calls-design.md
 *
 * A SEPARATE DEPLOYMENT, and deliberately a dumb pipe. It knows nothing about
 * reminders, users, organizations or Prisma -- it takes a phone number and a
 * sentence and speaks it. Everything that decides WHETHER to call, and WHO to
 * call, stays in the web app next to the compare-and-swap that makes a reminder
 * fire at most once. Giving this process its own database connection would put
 * two services in a race over one table and require a second copy of the schema,
 * which is the coupling the split was meant to remove.
 *
 * What the split actually buys:
 *
 *   - the Twilio credentials exist in ONE service that renders no HTML, runs no
 *     user code and holds no session;
 *   - swapping Twilio for a regional carrier (Exotel for +91, say) is a deploy
 *     of this directory rather than a change to the app;
 *   - a provider outage cannot block a web request, because nothing here is on
 *     the request path.
 *
 * No framework and no Twilio SDK: the REST call is one form-encoded POST, and
 * the entire dependency list is empty on purpose.
 */

/**
 * The four lines of `Bun.serve` this file actually uses, declared rather than
 * installed. `@types/bun` is 40MB of ambient declarations for one function call
 * in a service whose entire dependency list is otherwise empty -- and it would
 * be a devDependency of the WEB app's `package.json`, since that is where
 * `tsc --noEmit` runs from.
 */
declare const Bun: {
  serve(options: {
    port: number;
    hostname: string;
    fetch: (request: Request) => Response | Promise<Response>;
  }): { port: number; hostname: string };
};

const SID = process.env.TWILIO_ACCOUNT_SID?.trim();
const AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN?.trim();
const FROM = process.env.TWILIO_FROM?.trim();
const SECRET = process.env.VOICE_SECRET?.trim();

/** Twilio's `<Say>` caps well short of this; the bound is against a runaway caller. */
const MAX_SAY = 1000;

/**
 * E.164: a leading `+`, a non-zero country digit, up to 15 digits total. The
 * same shape the web app validates, repeated here because a service that trusts
 * its caller's validation is a service that stops being safe the day it gains a
 * second caller.
 */
const E164 = /^\+[1-9]\d{6,14}$/;

/* -------------------------------------------------------------------------- */
/* TwiML                                                                       */
/* -------------------------------------------------------------------------- */

/**
 * THE SECURITY BOUNDARY OF THIS SERVICE.
 *
 * The spoken text is written by a user and is interpolated into an XML document
 * that Twilio EXECUTES. Without escaping, a reminder titled
 *
 *     hi</Say><Dial>+1900...</Dial><Say>
 *
 * turns a notification into a premium-rate dial-out billed to this account --
 * the same class of bug as SQL injection, with a phone bill attached. Escaping
 * happens HERE, at the point of construction, rather than at any call site, so
 * a future caller cannot forget it.
 *
 * Numeric character references rather than named entities (`&#60;` not `&lt;`):
 * they are valid in XML with no DTD, which is what TwiML is.
 */
export function escapeXml(value: string): string {
  return value.replace(/[<>&'"]/g, (char) => `&#${char.charCodeAt(0)};`);
}

/**
 * The whole call, as one document.
 *
 * There is no `<Hangup>` and no webhook: Twilio ends the call when the verbs run
 * out, which is exactly the behaviour this feature wants. That is also why the
 * inline `Twiml` parameter is used instead of `Url` -- an answer URL would mean
 * a second publicly reachable endpoint whose only job is to return this string.
 */
export function twiml(say: string, voice: string): string {
  return `<Response><Say voice="${escapeXml(voice)}">${escapeXml(say)}</Say></Response>`;
}

/* -------------------------------------------------------------------------- */
/* Request validation                                                          */
/* -------------------------------------------------------------------------- */

export type CallRequest = { to: string; say: string; voice?: string };

/** The default Amazon Polly voice. Overridable per call so the app can pick a locale. */
const DEFAULT_VOICE = 'Polly.Joanna';

/**
 * Parses the body, or returns the reason it is unusable. Every rejection is the
 * caller's bug, so the reason is returned to the caller -- unlike the Twilio
 * failures below, which say nothing beyond a status.
 */
export function parseCall(body: unknown): { ok: true; call: Required<CallRequest> } | { ok: false; reason: string } {
  if (typeof body !== 'object' || body === null) return { ok: false, reason: 'body' };

  const { to, say, voice } = body as Record<string, unknown>;

  if (typeof to !== 'string' || !E164.test(to)) return { ok: false, reason: 'to' };
  if (typeof say !== 'string' || say.trim().length === 0) return { ok: false, reason: 'say' };
  if (say.length > MAX_SAY) return { ok: false, reason: 'say_too_long' };
  if (voice !== undefined && (typeof voice !== 'string' || !/^[\w.-]{1,40}$/.test(voice))) {
    return { ok: false, reason: 'voice' };
  }

  return { ok: true, call: { to, say: say.trim(), voice: voice ?? DEFAULT_VOICE } };
}

/* -------------------------------------------------------------------------- */
/* Auth                                                                        */
/* -------------------------------------------------------------------------- */

/**
 * Constant-time bearer comparison, character for character the same as
 * `/api/cron/reminders`. Both sides are hashed first so `timingSafeEqual` always
 * sees two 32-byte buffers -- it throws on a length mismatch, and that throw
 * would itself leak the secret's length.
 *
 * WITH `VOICE_SECRET` UNSET THE SERVICE IS CLOSED, in every environment. On
 * Railway this process has no public domain and is reachable only over the
 * private network, so the bearer is the second lock rather than the only one --
 * but a service whose only protection is "nobody can route to it" becomes an
 * open dialer the first time somebody generates a domain to debug something.
 */
function authorized(request: Request): boolean {
  if (!SECRET) return false;

  const header = request.headers.get('authorization') ?? '';
  const presented = header.startsWith('Bearer ') ? header.slice(7).trim() : '';

  const digest = (value: string) => createHash('sha256').update(value).digest();
  return timingSafeEqual(digest(presented), digest(SECRET));
}

/* -------------------------------------------------------------------------- */
/* Twilio                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * One form-encoded POST. `URLSearchParams` does the encoding, so the XML travels
 * through no shell and no argv splitter -- which is the whole reason the same
 * document that fails when pasted into a Windows terminal succeeds from here.
 * (PowerShell 5.1 strips the quotes around `voice="..."` on its way to a native
 * exe, and Twilio answers the resulting invalid XML with "an application error
 * has occurred". Recorded in the README, because it costs an afternoon twice.)
 */
async function placeCall(call: Required<CallRequest>): Promise<number> {
  const response = await fetch(
    `https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(SID!)}/Calls.json`,
    {
      method: 'POST',
      headers: {
        authorization: `Basic ${Buffer.from(`${SID}:${AUTH_TOKEN}`).toString('base64')}`,
        'content-type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({
        To: call.to,
        From: FROM!,
        Twiml: twiml(call.say, call.voice),
      }),
      // Twilio queues the call and answers immediately; anything slower than
      // this is a provider problem, and the caller has already advanced the
      // reminder's schedule and is not waiting on the outcome.
      signal: AbortSignal.timeout(15_000),
    },
  );

  return response.status;
}

/* -------------------------------------------------------------------------- */
/* Server                                                                      */
/* -------------------------------------------------------------------------- */

const configured = Boolean(SID && AUTH_TOKEN && FROM && SECRET);

const server = Bun.serve({
  port: Number(process.env.PORT ?? 3001),

  /**
   * `::`, NOT the `0.0.0.0` Bun defaults to.
   *
   * Railway's private network is IPv6-only. A process bound to `0.0.0.0` is
   * listening on IPv4 only, so `voice.railway.internal` resolves, connects to
   * nothing, and every reminder call fails with a connection error that looks
   * like a wrong hostname. `::` accepts both families and is what makes this
   * service reachable without a public domain.
   */
  hostname: '::',

  async fetch(request) {
    const { pathname } = new URL(request.url);

    // Railway's healthcheck. Reports the process, NOT the credentials: a health
    // endpoint that fails on missing configuration turns a bad variable into a
    // deploy that never goes live and therefore never shows its own logs.
    if (pathname === '/health') {
      return Response.json({ ok: true, configured });
    }

    if (pathname !== '/call') return new Response(null, { status: 404 });
    if (request.method !== 'POST') return new Response(null, { status: 405 });

    if (!configured) {
      console.error('[voice] not_configured');
      return Response.json({ error: 'not_configured' }, { status: 503 });
    }

    if (!authorized(request)) {
      return new Response(null, {
        status: 401,
        headers: { 'WWW-Authenticate': 'Bearer realm="flone-voice"' },
      });
    }

    const body = await request.json().catch(() => null);
    const parsed = parseCall(body);
    if (!parsed.ok) {
      console.warn(`[voice] rejected reason=${parsed.reason}`);
      return Response.json({ error: parsed.reason }, { status: 400 });
    }

    try {
      const status = await placeCall(parsed.call);
      const placed = status >= 200 && status < 300;

      // Counts and status codes only -- never the number, never the sentence.
      // The same rule the cron log follows, and it matters more here: the
      // sentence is somebody's reminder and the number is personal data.
      console.info(`[voice] ${placed ? 'placed' : 'rejected'} twilio=${status}`);

      // 502 rather than passing Twilio's status through: a 400 from Twilio is
      // not a 400 from this caller, and reporting it as one would send the web
      // app looking for a bug in its own payload.
      return placed
        ? new Response(null, { status: 202 })
        : Response.json({ error: 'provider' }, { status: 502 });
    } catch {
      console.error('[voice] provider_unreachable');
      return Response.json({ error: 'provider' }, { status: 502 });
    }
  },
});

console.info(`[voice] listening on ${server.port} configured=${configured}`);
