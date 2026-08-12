import 'server-only';

import { prisma } from '@/lib/db';
import { appUrl } from '@/lib/email';
import { sendReminderMail } from '@/lib/mailer';
import {
  CHANNEL_CALLS,
  CHANNEL_EMAILS,
  REPEAT_LABEL,
  formatWhen,
  nextRun,
  speechFor,
} from '@/lib/reminder-math';
import { REMINDER_VOICE, placeCall } from '@/lib/voice';

/**
 * The scheduler tick.
 *
 * Design: docs/superpowers/specs/2026-08-11-reminders-design.md
 *
 * Called by `/api/cron/reminders` and by nothing else. The arithmetic it rests
 * on is in `src/lib/reminder-math.ts`, which is pure and covered by
 * `scripts/check-model.ts`; this file is the part that talks to the database.
 *
 * THE ONE INVARIANT: a given occurrence of a given reminder produces AT MOST
 * ONE email. It is held by a compare-and-swap, not by a lock:
 *
 *   1. read the due rows, each carrying the `nextRunAt` value it was read at;
 *   2. `updateMany` where the id AND that same `nextRunAt` still match;
 *   3. send only if that write claimed a row (`count === 1`).
 *
 * Two ticks overlapping -- a slow send, an over-eager cron, a redeploy that
 * leaves the old container running -- both see the row, but only one write can
 * match the old value, so only one sends. That is also why the schedule is
 * advanced BEFORE the message goes out rather than after: the failure this
 * design chooses is a lost reminder, never a duplicated one. A user who never
 * got a nudge asks about it; a user who got four identical ones turns the
 * feature off.
 */

/**
 * How many reminders one tick will handle. Bounded so a backlog -- a scheduler
 * that was off for a week, an import -- costs a fixed number of provider calls
 * per tick and drains over several instead of hanging one request until it times
 * out. Anything left over is still due and is picked up by the next tick.
 */
const BATCH = 100;

export type TickResult = {
  /** Rows this tick won the compare-and-swap for. */
  claimed: number;
  /** Of those, the ones an email was actually composed for. */
  emailed: number;
  /** Of those, the ones the voice service accepted a call for. */
  called: number;
  /**
   * Claimed but delivered NOWHERE -- an unconfirmed address, an unverified
   * phone, or a voice service that would not take the call. A claimed row is
   * always exactly one of delivered or skipped, so the counts in the cron log
   * add up to `claimed` and a number that does not is a bug worth chasing.
   */
  skipped: number;
};

export async function runDueReminders(now: Date): Promise<TickResult> {
  const due = await prisma.reminder.findMany({
    where: { nextRunAt: { lte: now } },
    orderBy: [{ nextRunAt: 'asc' }, { id: 'asc' }],
    take: BATCH,
    select: {
      id: true,
      title: true,
      repeat: true,
      channel: true,
      nextRunAt: true,
      tzOffsetMinutes: true,
      createdById: true,
      recipient: {
        select: {
          id: true,
          name: true,
          email: true,
          emailVerified: true,
          phone: true,
          phoneVerified: true,
        },
      },
      createdBy: { select: { name: true } },
      organization: { select: { name: true, slug: true } },
      project: { select: { name: true } },
    },
  });

  const result: TickResult = { claimed: 0, emailed: 0, called: 0, skipped: 0 };

  for (const reminder of due) {
    // Narrowing only: `nextRunAt <= now` cannot match null, so this is never hit.
    const dueAt = reminder.nextRunAt;
    if (!dueAt) continue;

    // Strictly in the future, however long the scheduler was down -- see
    // `nextRun`. Null ends a one-time reminder without deleting it, so the row
    // stays on the page as "Sent" until somebody clears it.
    const following = nextRun(dueAt, reminder.repeat, now);

    const claim = await prisma.reminder.updateMany({
      where: { id: reminder.id, nextRunAt: dueAt },
      data: { nextRunAt: following, lastSentAt: now },
    });
    if (claim.count === 0) continue;
    result.claimed += 1;

    const scope = reminder.project?.name ?? reminder.organization.name;
    // Null when they scheduled it themselves, which changes the copy on both
    // the email and the call.
    const setBy =
      reminder.createdById === reminder.recipient.id ? null : reminder.createdBy.name;

    // Whether ANY channel got through. A claimed row is delivered or skipped,
    // never both and never neither.
    let delivered = false;

    // ---- Email --------------------------------------------------------------
    //
    // App-wide rule: never send to an address nobody has confirmed. Applied
    // AFTER the claim on purpose -- filtering unverified recipients out of the
    // due query instead would leave those rows permanently due and re-read by
    // every tick forever.
    if (CHANNEL_EMAILS[reminder.channel] && reminder.recipient.emailVerified) {
      await sendReminderMail({
        email: reminder.recipient.email,
        title: reminder.title,
        when: formatWhen(dueAt, reminder.tzOffsetMinutes),
        scope,
        repeat: REPEAT_LABEL[reminder.repeat],
        setBy,
        url: appUrl(`/orgs/${encodeURIComponent(reminder.organization.slug)}/reminders`),
      });
      result.emailed += 1;
      delivered = true;
    }

    // ---- Call ---------------------------------------------------------------
    //
    // SECOND, not first, and that order is the point: for a BOTH reminder the
    // cheap reliable channel goes out before the one that depends on a separate
    // service and a carrier. If the voice service is down, the email has already
    // left.
    //
    // `phoneVerified` is the exact counterpart of `emailVerified` and is
    // enforced here for the same reason -- it is the only thing standing between
    // this feature and a robocall vector, since scheduling a daily reminder for
    // yourself is something every member may do.
    if (
      CHANNEL_CALLS[reminder.channel] &&
      reminder.recipient.phone &&
      reminder.recipient.phoneVerified
    ) {
      const placed = await placeCall({
        to: reminder.recipient.phone,
        say: speechFor({ title: reminder.title, scope, setBy }),
        voice: REMINDER_VOICE,
      });
      // A refused call is NOT retried and NOT re-queued. The schedule was
      // advanced by the claim above, and the alternative -- rewinding
      // `nextRunAt` -- is how one unreachable provider turns into the same
      // person being phoned repeatedly once it recovers.
      if (placed) {
        result.called += 1;
        delivered = true;
      }
    }

    if (!delivered) result.skipped += 1;
  }

  return result;
}
