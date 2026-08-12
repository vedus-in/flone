'use server';

/**
 * Daily Challenges Server Actions.
 *
 * The universal rules from `issue-actions.ts` hold here unchanged: the literal
 * first statement is `await requireUser()`, input is re-parsed with zod, and
 * every resource resolves through a `require*` helper that walks UP to the
 * Organization inside one `where` clause.
 *
 * What this file deliberately does NOT contain is a second way to write a
 * status. `moveChallenge` resolves a column to a state of the issue's own
 * project and then calls `setIssueState` -- the project board's own write path,
 * which stamps `startedAt` / `completedAt` and revalidates every surface the
 * issue appears on. Reimplementing that here is how the challenge board and the
 * project board would start to disagree.
 */

import { revalidatePath } from 'next/cache';
import { z } from 'zod';

import { challengesPath, requireTicket, requireUser, runAction } from '@/lib/authz';
import { challengeColumn, positionWrites } from '@/lib/challenges';
import { prisma } from '@/lib/db';
import { fail, ok, type ActionResult } from '@/lib/result';
import { INVALID_INPUT, fieldErrorsOf } from '@/lib/action-input';
import { STATE_ORDER, cuid } from '@/lib/validation';
import { setIssueState } from '../[workspaceSlug]/[projectKey]/issue-actions';

/**
 * A project can legally have no state of a given type -- the seed provides one
 * of each, but the states are the project's own and nothing stops them being
 * renamed or deleted down to a subset.
 */
const NO_STATE = "That issue's project has no status matching this column.";

const ticketOnly = z.object({ ticketId: cuid });

/** The board, in the order it now reads. Bounded like any other client array. */
const order = z.array(cuid).max(500);

/**
 * Persist the arrangement of the caller's OWN board.
 *
 * `ChallengePick.position` is dense across the whole board rather than per
 * column: the client sends every card it can see, read top-left to
 * bottom-right, so one renumbering settles both the order within a column and
 * where a card landed after changing column. Picks span projects, so
 * `Ticket.position` -- dense per (project, state) -- cannot express this.
 *
 * Every write is scoped to the session user, so an id the caller does not own
 * matches no row and reorders nothing. That is the whole authorization here.
 */
async function writeOrder(userId: string, ticketIds: string[]): Promise<void> {
  if (ticketIds.length === 0) return;

  await prisma.$transaction(
    positionWrites(ticketIds).map(({ ticketId, position }) =>
      prisma.challengePick.updateMany({ where: { userId, ticketId }, data: { position } }),
    ),
  );
}

/* -------------------------------------------------------------------------- */
/* addChallenge                                                                */
/* -------------------------------------------------------------------------- */

/**
 * Put an issue on the caller's own board.
 *
 * `requireTicket` walks ticket -> project -> organization -> membership, so an
 * id belonging to an organization the caller is not a member of 404s before
 * anything is written. There is no `userId` in the input: it comes from the
 * session, so this cannot be used to fill somebody else's board.
 */
export async function addChallenge(input: { ticketId: string }): Promise<ActionResult> {
  return runAction(async () => {
    const user = await requireUser();

    const parsed = ticketOnly.safeParse(input);
    if (!parsed.success) return fail(INVALID_INPUT, fieldErrorsOf(parsed.error));

    const ctx = await requireTicket(parsed.data.ticketId);

    // `skipDuplicates` against the (userId, ticketId) unique: picking the same
    // issue twice is a no-op, not an error the user has to read.
    await prisma.challengePick.createMany({
      data: { userId: user.id, ticketId: ctx.ticket.id },
      skipDuplicates: true,
    });

    revalidatePath(challengesPath(ctx.org));
    return ok(`Added ${ctx.project.key}-${ctx.ticket.number}.`);
  });
}

/* -------------------------------------------------------------------------- */
/* removeChallenge                                                             */
/* -------------------------------------------------------------------------- */

/**
 * Take an issue off the caller's board. Writes nothing to the issue itself.
 *
 * `deleteMany` scoped to the session user rather than `delete` by pick id: there
 * is then no id in play that could name somebody else's row, so the authorization
 * is structural rather than a check that could be forgotten.
 */
export async function removeChallenge(input: { ticketId: string }): Promise<ActionResult> {
  return runAction(async () => {
    const user = await requireUser();

    const parsed = ticketOnly.safeParse(input);
    if (!parsed.success) return fail(INVALID_INPUT, fieldErrorsOf(parsed.error));

    const ctx = await requireTicket(parsed.data.ticketId);

    await prisma.challengePick.deleteMany({
      where: { userId: user.id, ticketId: ctx.ticket.id },
    });

    revalidatePath(challengesPath(ctx.org));
    return ok();
  });
}

/* -------------------------------------------------------------------------- */
/* reorderChallenges                                                           */
/* -------------------------------------------------------------------------- */

const reorderSchema = z.object({ ticketIds: order.min(1) });

/**
 * Rearrange the board without touching a single issue.
 *
 * This is what a drop that stayed inside its column means, and it deliberately
 * does NOT go near `setIssueState`: a column admits more than one state -- To-do
 * holds backlog and unstarted, In Progress holds every STARTED state a project
 * has -- so writing the column's canonical status on a reorder would quietly
 * promote a backlog issue or collapse "In Review" into "In Progress".
 */
export async function reorderChallenges(input: { ticketIds: string[] }): Promise<ActionResult> {
  return runAction(async () => {
    const user = await requireUser();

    const parsed = reorderSchema.safeParse(input);
    if (!parsed.success) return fail(INVALID_INPUT, fieldErrorsOf(parsed.error));

    // Solely to name the organization to revalidate. The reorder itself is
    // scoped to the session user, so this cannot reach another person's board.
    const ctx = await requireTicket(parsed.data.ticketIds[0]);

    await writeOrder(user.id, parsed.data.ticketIds);

    revalidatePath(challengesPath(ctx.org));
    return ok();
  });
}

/* -------------------------------------------------------------------------- */
/* moveChallenge -- the drop handler                                           */
/* -------------------------------------------------------------------------- */

const moveSchema = z.object({
  ticketId: cuid,
  column: z.string().min(1).max(20),
  /** Optional: MCP moves a card without knowing where the board scrolled to. */
  order: order.optional(),
});

/**
 * Move a card between columns.
 *
 * Two quite different things wear one gesture here, and the split is the reason
 * the feature is safe:
 *
 *   - To-do / In Progress / Done resolve the column's state TYPE to a concrete
 *     state of the issue's OWN project and change the issue's real status. That
 *     shows up on the project board, the issues list, the cycle burndown and
 *     everywhere else immediately, because it is the same single field.
 *
 *   - Completed writes NO status. It deletes the pick, and the card leaves this
 *     board alone. An issue's project sees nothing at all.
 */
export async function moveChallenge(input: {
  ticketId: string;
  column: string;
  order?: string[];
}): Promise<ActionResult> {
  return runAction(async () => {
    const user = await requireUser();

    const parsed = moveSchema.safeParse(input);
    if (!parsed.success) return fail(INVALID_INPUT, fieldErrorsOf(parsed.error));

    const column = challengeColumn(parsed.data.column);
    if (!column) return fail(INVALID_INPUT);

    const ctx = await requireTicket(parsed.data.ticketId);

    // Where the card landed in its new column, from the same drop. Written
    // first so it holds even if the status write below is refused.
    await writeOrder(user.id, parsed.data.order ?? []);

    if (column.sets === null) {
      await prisma.challengePick.deleteMany({
        where: { userId: user.id, ticketId: ctx.ticket.id },
      });
      revalidatePath(challengesPath(ctx.org));
      return ok();
    }

    // Lowest position wins, so a project carrying both "In Progress" and
    // "In Review" -- both STARTED -- lands on the one it lists first. The
    // project id is `ctx.ticket.projectId`, from the authorized row and never
    // from the client, so this cannot reach a state of another project.
    const state = await prisma.workflowState.findFirst({
      where: { projectId: ctx.ticket.projectId, type: column.sets },
      orderBy: STATE_ORDER,
      select: { id: true },
    });
    if (!state) return fail(NO_STATE);

    // The project board's write path, re-entered whole: it re-derives the
    // session, re-resolves the ticket, proves the state belongs to the project,
    // stamps the lifecycle dates and revalidates every surface the issue is on.
    const result = await setIssueState({ ticketId: ctx.ticket.id, stateId: state.id });
    if (!result.ok) return result;

    revalidatePath(challengesPath(ctx.org));
    return ok();
  });
}
