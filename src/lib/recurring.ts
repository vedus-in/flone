import 'server-only';

import { canSeeProject, ticketPath } from '@/lib/authz';
import { prisma } from '@/lib/db';
import { appUrl } from '@/lib/email';
import { sendRecurringTicketMail } from '@/lib/mailer';
import {
  TICKET_REPEAT_LABEL,
  dueDateFor,
  formatDateStamp,
  nextOccurrence,
} from '@/lib/reminder-math';
import { defaultComposeState, ensureDefaultStates } from '@/lib/states';
import { insertTicket } from '@/lib/ticket-insert';

/**
 * The recurring-ticket scheduler tick.
 *
 * Design: docs/superpowers/specs/2026-08-16-recurring-tickets-design.md
 *
 * Called by `/api/cron/reminders` and by nothing else -- the same route, because
 * the deployed cron has that URL baked in. Shaped line-for-line like
 * `runDueReminders` in `src/lib/reminders.ts`, deliberately: the arithmetic it
 * rests on is the pure, Node-testable `nextOccurrence` in
 * `src/lib/reminder-math.ts`, and this file is the part that talks to the
 * database.
 *
 * THE ONE INVARIANT: a given occurrence of a given template produces AT MOST ONE
 * ticket. It is held by a compare-and-swap, not by a lock:
 *
 *   1. read the due rows, each carrying the `nextRunAt` value it was read at;
 *   2. `updateMany` where the id AND that same `nextRunAt` still match;
 *   3. spawn only if that write claimed a row (`count === 1`).
 *
 * Two ticks overlapping -- a slow insert, an over-eager cron, a redeploy that
 * leaves the old container running -- both see the row, but only one write can
 * match the old value, so only one spawns. That is also why the schedule is
 * advanced BEFORE the ticket is created rather than after: the failure this
 * design chooses is a missing ticket, never a duplicated one. A missing review
 * gets asked about; a board that grows two identical tickets every morning gets
 * the feature turned off.
 *
 * The tick performs NO authorization, exactly as the reminders tick does not: it
 * acts on rows a member session already created inside a project it was already
 * a member of, and it files a ticket that same member could have filed by hand.
 */

/**
 * How many templates one tick will handle. Bounded so a backlog -- a scheduler
 * that was off for a week, an import -- costs a fixed number of inserts per tick
 * and drains over several instead of hanging one request until it times out.
 * Anything left over is still due and is picked up by the next tick.
 */
const BATCH = 100;

export type RecurringTickResult = {
  /** Rows this tick won the compare-and-swap for. */
  claimed: number;
  /** Of those, the ones a Ticket row was actually created for. */
  spawned: number;
  /** Of those spawned, the ones whose assignee was mailed. Not a partition. */
  mailed: number;
  /**
   * Claimed but NOT spawned -- a project with no resolvable workflow state at
   * all. A claimed row is always exactly one of spawned or skipped, so
   * `spawned + skipped === claimed` and a log line where it does not is a bug
   * worth chasing.
   */
  skipped: number;
};

export async function runDueRecurringTickets(now: Date): Promise<RecurringTickResult> {
  const due = await prisma.recurringTicket.findMany({
    where: { nextRunAt: { lte: now } },
    orderBy: [{ nextRunAt: 'asc' }, { id: 'asc' }],
    take: BATCH,
    select: {
      id: true,
      title: true,
      description: true,
      priority: true,
      assigneeId: true,
      repeat: true,
      anchorAt: true,
      nextRunAt: true,
      tzOffsetMinutes: true,
      createdById: true,
      labels: { select: { id: true } },
      assignee: { select: { id: true, email: true, emailVerified: true } },
      project: {
        select: {
          id: true,
          name: true,
          key: true,
          description: true,
          workspace: { select: { slug: true } },
          organization: { select: { id: true, name: true, slug: true } },
        },
      },
    },
  });

  const result: RecurringTickResult = { claimed: 0, spawned: 0, mailed: 0, skipped: 0 };

  for (const template of due) {
    // Narrowing only: `nextRunAt <= now` cannot match null (that is what PAUSED
    // is), so this is never hit.
    const dueAt = template.nextRunAt;
    if (!dueAt) continue;

    // Strictly in the future however long the scheduler was down, and computed
    // from `anchorAt` rather than from `dueAt` -- see `nextOccurrence` for why
    // both properties are load-bearing.
    const following = nextOccurrence(
      template.anchorAt,
      template.repeat,
      now,
      template.tzOffsetMinutes,
    );

    const claim = await prisma.recurringTicket.updateMany({
      where: { id: template.id, nextRunAt: dueAt },
      data: { nextRunAt: following, lastSpawnedAt: now },
    });
    if (claim.count === 0) continue;
    result.claimed += 1;

    // Resolved per spawn, never stored: a stored state id is a reference that a
    // deleted or renamed state turns into a dangling pointer this tick trips
    // over at 3am. `ensureDefaultStates` also repairs a project that somehow has
    // none, which is the only way this can return null.
    const states = await ensureDefaultStates(template.project.id);
    const state = defaultComposeState(states);
    if (!state) {
      // Counted, not thrown. One project with no workflow states must not stop
      // the other 99 templates in the batch from spawning. The schedule has
      // already been advanced, so the row is not re-read forever either.
      result.skipped += 1;
      continue;
    }

    const dueDate = dueDateFor(dueAt, template.tzOffsetMinutes);

    // The assignee is RE-PROVED at spawn time, after the claim. The template may
    // be months old and the person may have left the organization since -- or
    // just this project, now that a project can be private. Either way they
    // spawn an UNASSIGNED ticket that sits on the board, not an error that kills
    // the batch and not a mail about an issue they cannot open. Applied after
    // the claim rather than as a filter on the due query for the same reason the
    // reminders tick applies its unverified-address rule there -- filtering in
    // the query would leave the row permanently due and re-read by every tick
    // forever.
    const assigned = template.assigneeId
      ? await canSeeProject(template.project.id, template.assigneeId)
      : false;
    const assigneeId = assigned ? template.assigneeId : null;

    const title = `${template.title} — ${formatDateStamp(dueAt, template.tzOffsetMinutes)}`;

    // Same insert path `createIssue` uses, so a spawned ticket is numbered,
    // positioned and stamped identically to a hand-filed one. Labels connect by
    // id: a label deleted since the template was written has already vanished
    // from the join table, so the set is valid by construction.
    const created = await insertTicket({
      projectId: template.project.id,
      state,
      title,
      description: template.description,
      priority: template.priority,
      assigneeId,
      labelIds: template.labels.map((label) => label.id),
      dueDate,
      // The tick has no session. The template's creator authors the ticket.
      createdById: template.createdById,
    });
    result.spawned += 1;

    // App-wide rule, unbent: never send to an address nobody has confirmed. The
    // never-mail-the-actor rule DOES bend, exactly as it does for reminders and
    // for the same reason -- a template you set up and assigned to yourself
    // arriving silently would defeat the point, and at spawn time the actor is a
    // cron tick. An unassigned template mails nobody: the ticket on the board is
    // the notification surface.
    if (template.assignee && assigneeId && template.assignee.emailVerified) {
      await sendRecurringTicketMail({
        email: template.assignee.email,
        issueKey: `${template.project.key}-${created.number}`,
        issueTitle: title,
        projectName: template.project.name,
        repeat: TICKET_REPEAT_LABEL[template.repeat],
        url: appUrl(
          ticketPath(
            template.project.organization,
            { ...template.project, workspaceSlug: template.project.workspace.slug },
            created.number,
          ),
        ),
      });
      result.mailed += 1;
    }
  }

  return result;
}
