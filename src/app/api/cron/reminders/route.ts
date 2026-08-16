import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';

import { runDueRecurringTickets } from '@/lib/recurring';
import { runDueReminders } from '@/lib/reminders';

/**
 * The scheduler's trigger -- BOTH schedulers. Point any cron at it, once a
 * minute:
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
 * THE PATH IS NOW A MISNOMER AND STAYS ONE. It runs reminders AND recurring
 * tickets, but the deployed Railway cron service has this exact URL baked into
 * its start command, so renaming the route is a silent outage: the cron keeps
 * firing, keeps getting a 404, and nothing anyone looks at goes red. Same
 * rotation hazard the reminders design records in §6 of
 * docs/superpowers/specs/2026-08-11-reminders-design.md. A better name is worth
 * less than a schedule that keeps running.
 *
 * SAFE TO CALL AT ANY RATE, INCLUDING CONCURRENTLY. Every send and every spawn
 * is claimed by a compare-and-swap inside its own tick, so an extra tick finds
 * nothing to do and two overlapping ticks cannot both act on the same
 * occurrence. Calling it more often than once a minute only wastes a query;
 * calling it less often makes reminders and tickets late, never wrong.
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

/**
 * Run one tick, or log its failure and return null.
 *
 * The try/catch belongs HERE, around each tick individually, and not around the
 * pair. The two share nothing but the clock, so a provider outage or one
 * malformed row that throws out of the reminders tick must still leave recurring
 * tickets spawning -- and vice versa. A single catch around both would make
 * either one able to silently disable the other half of the schedule, which is
 * the kind of failure nobody notices until a week of tickets is missing.
 *
 * A short code plus a correlation id, never the error (SPEC 4.7). Nothing is
 * rewound: the next tick picks up whatever this one did not claim.
 */
async function tick<T>(name: string, run: () => Promise<T>): Promise<T | null> {
  try {
    return await run();
  } catch {
    const ref = randomUUID().slice(0, 8);
    console.error(`[cron] ${name} failed ref=${ref}`);
    return null;
  }
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

  // ONE `now` for the whole request, shared by both ticks, so every row in
  // either batch is measured against the same instant and the counts in the log
  // add up. Two `new Date()` calls would let a row fall between them.
  const now = new Date();

  const reminders = await tick('reminders', () => runDueReminders(now));
  const recurring = await tick('recurring', () => runDueRecurringTickets(now));

  if (reminders && reminders.claimed > 0) {
    // Counts only -- never a title, an address, a phone number or an
    // organization. `emailed + called` can exceed `claimed` (a BOTH reminder
    // does two things); `skipped` counts rows that reached nobody at all, so
    // `delivered + skipped === claimed` is the line that has to add up.
    console.info(
      `[cron] reminders claimed=${reminders.claimed} emailed=${reminders.emailed} called=${reminders.called} skipped=${reminders.skipped}`,
    );
  }

  if (recurring && recurring.claimed > 0) {
    // Counts only again -- never a title, a project or an organization. A
    // claimed template is spawned or skipped and never both, so the skipped
    // count is `claimed - spawned` and a line where that is not zero is a
    // project with no workflow states left. `mailed` is a subset of `spawned`,
    // not a third bucket: an unassigned or unconfirmed assignee mails nobody.
    console.info(
      `[cron] recurring claimed=${recurring.claimed} spawned=${recurring.spawned} mailed=${recurring.mailed}`,
    );
  }

  // A 500 only after BOTH have run and both have logged, so a persistently
  // failing tick is still visible to whatever watches the status code without
  // the other one ever being skipped.
  if (!reminders || !recurring) {
    return Response.json({ error: 'failed' }, { status: 500, headers: NO_STORE });
  }

  return Response.json({ ok: true, ...reminders, recurring }, { headers: NO_STORE });
}

/**
 * Same handler on GET, because half the schedulers in the world only send one.
 * It mutates, which GET should not -- but the credential is required either way
 * and the work is idempotent, so the alternative is an operator discovering at
 * 3am that their pinger has been getting 405s all week.
 */
export const GET = POST;
