import 'server-only';

import { prisma } from '@/lib/db';
import { appUrl } from '@/lib/email';
import { sendReminderMail } from '@/lib/mailer';
import { REPEAT_LABEL, formatWhen, nextRun } from '@/lib/reminder-math';

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
  sent: number;
  /** Claimed but not sent: the recipient has never confirmed their address. */
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
      nextRunAt: true,
      tzOffsetMinutes: true,
      createdById: true,
      recipient: { select: { id: true, name: true, email: true, emailVerified: true } },
      createdBy: { select: { name: true } },
      organization: { select: { name: true, slug: true } },
      project: { select: { name: true } },
    },
  });

  const result: TickResult = { claimed: 0, sent: 0, skipped: 0 };

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

    // App-wide rule: never send to an address nobody has confirmed. Applied
    // AFTER the claim on purpose -- skipping it before would leave the row
    // permanently due and re-read by every tick forever.
    if (!reminder.recipient.emailVerified) {
      result.skipped += 1;
      continue;
    }

    await sendReminderMail({
      email: reminder.recipient.email,
      title: reminder.title,
      when: formatWhen(dueAt, reminder.tzOffsetMinutes),
      scope: reminder.project?.name ?? reminder.organization.name,
      repeat: REPEAT_LABEL[reminder.repeat],
      // Null when they scheduled it themselves, which changes the copy.
      setBy:
        reminder.createdById === reminder.recipient.id ? null : reminder.createdBy.name,
      url: appUrl(`/orgs/${encodeURIComponent(reminder.organization.slug)}/reminders`),
    });
    result.sent += 1;
  }

  return result;
}
