import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';

import { runDueReminders } from '@/lib/reminders';

/**
 * The reminder scheduler's trigger. Point any cron at it, once a minute:
 *
 *   curl -fsS -X POST -H "authorization: Bearer $CRON_SECRET" \
 *     https://your-app/api/cron/reminders
 *
 * A route rather than a worker process, because the mail layer is Next's: the
 * templates are TSX, `src/lib/email.ts` is `server-only`, and running any of it
 * outside the app would mean a second copy of the render path. One HTTP call
 * also means the schedule can come from anywhere -- a Railway cron service, a
 * GitHub Actions workflow, an uptime pinger -- with no code change.
 *
 * SAFE TO CALL AT ANY RATE, INCLUDING CONCURRENTLY. Every send is claimed by a
 * compare-and-swap in `runDueReminders`, so an extra tick finds nothing to do
 * and two overlapping ticks cannot both send the same occurrence. Calling it
 * more often than once a minute only wastes a query; calling it less often makes
 * reminders late, never wrong.
 */

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const NO_STORE = { 'Cache-Control': 'no-store' };

/**
 * Constant-time bearer comparison.
 *
 * Both sides are hashed first so `timingSafeEqual` always sees two 32-byte
 * buffers -- it throws on a length mismatch, and that throw would itself leak
 * the secret's length. There is no user and no session here: the header IS the
 * whole credential, which is why it never reaches a log or a response body.
 *
 * With `CRON_SECRET` unset the endpoint is CLOSED, in every environment. An
 * unauthenticated trigger is a way for anyone to make the instance send mail,
 * and "it is only development" is exactly how that reaches production.
 */
function authorized(request: Request): boolean {
  const secret = process.env.CRON_SECRET?.trim();
  if (!secret) return false;

  const header = request.headers.get('authorization') ?? '';
  const presented = header.startsWith('Bearer ') ? header.slice(7).trim() : '';

  const digest = (value: string) => createHash('sha256').update(value).digest();
  return timingSafeEqual(digest(presented), digest(secret));
}

export async function POST(request: Request): Promise<Response> {
  if (!process.env.CRON_SECRET?.trim()) {
    console.error('[cron] reminders not_configured');
    return Response.json({ error: 'not_configured' }, { status: 503, headers: NO_STORE });
  }

  if (!authorized(request)) {
    return new Response(null, {
      status: 401,
      headers: { ...NO_STORE, 'WWW-Authenticate': 'Bearer realm="flone"' },
    });
  }

  try {
    // One `now` for the whole tick, so every row in the batch is measured
    // against the same instant and the counts in the log add up.
    const result = await runDueReminders(new Date());
    if (result.claimed > 0) {
      // Counts only -- never a title, an address, a phone number or an
      // organization. `emailed + called` can exceed `claimed` (a BOTH reminder
      // does two things); `skipped` counts rows that reached nobody at all, so
      // `delivered + skipped === claimed` is the line that has to add up.
      console.info(
        `[cron] reminders claimed=${result.claimed} emailed=${result.emailed} called=${result.called} skipped=${result.skipped}`,
      );
    }
    return Response.json({ ok: true, ...result }, { headers: NO_STORE });
  } catch {
    // A short code plus a correlation id, never the error (SPEC 4.7). The next
    // tick retries whatever this one did not claim.
    const ref = randomUUID().slice(0, 8);
    console.error(`[cron] reminders failed ref=${ref}`);
    return Response.json({ error: 'failed' }, { status: 500, headers: NO_STORE });
  }
}

/**
 * Same handler on GET, because half the schedulers in the world only send one.
 * It mutates, which GET should not -- but the credential is required either way
 * and the work is idempotent, so the alternative is an operator discovering at
 * 3am that their pinger has been getting 405s all week.
 */
export const GET = POST;
