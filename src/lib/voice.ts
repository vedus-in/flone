import 'server-only';

/**
 * The web app's side of the voice service.
 *
 * Design: docs/superpowers/specs/2026-08-12-reminder-calls-design.md
 *
 * One function, one `fetch`, and NEVER THROWS. The two callers -- the scheduler
 * tick and phone verification -- both treat a failed call as "no call happened"
 * and carry on, so an exception escaping here would only be a way to abort a
 * batch of reminders because one provider request timed out.
 *
 * Everything about telephony lives on the other side of this boundary. This file
 * knows a phone number, a sentence and a URL; it does not know Twilio exists,
 * which is what makes swapping the provider a deploy of `services/voice` rather
 * than a change to the app.
 *
 * NOT A `'use server'` MODULE, and nothing here may ever be re-exported from
 * one -- the same rule `mailer.ts` states. Next turns every export of a
 * `'use server'` file into a public POST endpoint, and `placeCall` published
 * that way is an open dialer.
 */

/**
 * The voice every reminder and verification call is read in.
 *
 * NEURAL TIER, not standard. Amazon Polly ships the same names in three
 * generations -- `Polly.Joanna` (standard), `-Neural`, and `-Generative` -- and
 * the suffix is the whole difference between a 2004 IVR and something a person
 * will sit through. Standard voices flatten prosody, which is worst exactly
 * where this feature needs clarity: a six-digit verification code read as a
 * monotone run of syllables is one somebody has to ask to hear again, and there
 * is nobody to ask.
 *
 * Neural rather than `-Generative` because generative bills highest per
 * character and a recurring reminder repeats forever; the gap between neural
 * and generative is smaller than the gap between standard and neural.
 *
 * Locale-neutral en-US on purpose. `Polly.Kajal-Neural` (en-IN) reads Indian
 * names and numbers more naturally and is the swap to make if that becomes the
 * main audience -- this constant is the only place it is named.
 */
export const REMINDER_VOICE = 'Polly.Joanna-Neural';

/**
 * Long enough for a provider hiccup, short enough that a batch of 100 reminders
 * cannot be held open by a hanging service. The scheduler has already advanced
 * the schedule before it gets here, so waiting longer buys nothing.
 */
const TIMEOUT_MS = 15_000;

/**
 * Places one call and returns whether the provider accepted it.
 *
 * `true` means QUEUED, not answered. Nothing in this app learns whether a human
 * picked up: that would need Twilio's status callbacks, and therefore a second
 * public endpoint, for information no screen currently shows.
 */
export async function placeCall(input: {
  /** E.164. Validated again by the service, which does not trust this caller. */
  to: string;
  say: string;
  voice?: string;
}): Promise<boolean> {
  const url = process.env.VOICE_URL?.trim();
  const secret = process.env.VOICE_SECRET?.trim();

  // With either unset the feature is simply OFF -- the same shape as the app
  // with no `RESEND_API_KEY`. Logged every time rather than silently, because
  // "calls are configured but nothing rings" and "calls were never configured"
  // look identical from the reminders page.
  if (!url || !secret) {
    console.warn('[voice] not_configured');
    return false;
  }

  try {
    const response = await fetch(`${url.replace(/\/+$/, '')}/call`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${secret}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ to: input.to, say: input.say, voice: input.voice }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
      // Server-to-server on a private network; nothing about this is cacheable.
      cache: 'no-store',
    });

    // Status only. Never the number and never the sentence -- the number is
    // personal data and the sentence is somebody's reminder.
    if (!response.ok) {
      console.error(`[voice] call_failed status=${response.status}`);
      return false;
    }
    return true;
  } catch {
    // Timeout, DNS, connection refused -- one message, no detail. The caller
    // has already decided what a failure means and it is never a retry.
    console.error('[voice] call_unreachable');
    return false;
  }
}
