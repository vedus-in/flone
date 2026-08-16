import 'server-only';

import { Prisma, type Priority, type WorkflowStateType } from '@prisma/client';

import { prisma } from '@/lib/db';
import { stampsFor } from '@/lib/model';

/**
 * The one place a `Ticket` row is created.
 *
 * Extracted from `createIssue` rather than copied, because there are now two
 * callers -- the create form and the recurring-ticket scheduler -- and two
 * copies of `number = max + 1` would eventually disagree about numbering,
 * positioning or lifecycle stamps, in a way only a duplicate-key error at 3am
 * would tell anyone about.
 *
 * Deliberately NOT in a `'use server'` module: every export of one of those is a
 * directly addressable POST endpoint, and this function takes a bare `projectId`
 * with no membership check of its own. Behind that boundary it would be a
 * cross-tenant write anyone could call. Same reason, same wording, as
 * `src/lib/states.ts`.
 *
 * IT AUTHORIZES NOTHING. `projectId`, `state.id`, `boardId`, `cycleId`,
 * `parentId`, `labelIds`, `assigneeId` and `createdById` must every one of them
 * already have been proved by an authorized upward walk (`requireProject`,
 * `requireStateInProject`, `requireBoardInProject`, `requireCycleInProject`,
 * `requireParentInProject`, `filterLabelsInProject`, the org-membership check)
 * or come from a row that was itself created behind those guards. What is passed
 * in is written.
 */

export type InsertTicketInput = {
  projectId: string;
  /** The landing state. Only `id` and `type` are read; `type` decides the stamps. */
  state: { id: string; type: WorkflowStateType };
  title: string;
  /** Already normalized: the empty string is the caller's `null`, not ours. */
  description: string | null;
  priority: Priority;
  assigneeId: string | null;
  /** Absent and null mean the same thing for each of these -- filed under none. */
  boardId?: string | null;
  cycleId?: string | null;
  parentId?: string | null;
  labelIds?: string[];
  dueDate?: Date | null;
  /** The session user for a hand-filed issue; the template's creator for a spawn. */
  createdById: string;
};

/**
 * SPEC 7.5, rekeyed: the `number` retry is tied STRICTLY to the
 * `(projectId, number)` constraint. A blanket `P2002` retry would silently mask
 * genuine unique violations -- a duplicate label name, say.
 */
function isTicketNumberConflict(e: unknown): boolean {
  if (!(e instanceof Prisma.PrismaClientKnownRequestError) || e.code !== 'P2002') return false;
  const target: unknown = e.meta?.target;
  const parts = Array.isArray(target)
    ? target.map((part) => String(part))
    : typeof target === 'string'
      ? [target]
      : [];
  const joined = parts.join(',');
  return joined.includes('projectId') && joined.includes('number');
}

/**
 * Append to the end of a state's column, in the issue's own project.
 *
 * Exported because `moveToState` in the issue actions appends the same way, and
 * two definitions of "the end of the column" is one more than the number of ways
 * positions may be allocated.
 */
export async function nextPosition(
  tx: Prisma.TransactionClient,
  projectId: string,
  stateId: string,
): Promise<number> {
  const highest = await tx.ticket.aggregate({
    where: { projectId, stateId },
    _max: { position: true },
  });
  return (highest._max.position ?? 0) + 1;
}

/**
 * Create the ticket and return the number it was given.
 *
 * `number = max + 1` inside a transaction, up to 3 attempts (SPEC 7.5), keyed to
 * the project rather than the board. Two people filing at the same instant both
 * read the same max; the loser loses on the `(projectId, number)` unique index
 * and retries, which is why the retry must not swallow any other conflict.
 */
export async function insertTicket(input: InsertTicketInput): Promise<{ number: number }> {
  const stamps = stampsFor(input.state.type, { startedAt: null, completedAt: null });
  const labelIds = input.labelIds ?? [];

  for (let attempt = 0; ; attempt += 1) {
    try {
      return await prisma.$transaction(async (tx) => {
        const [number, position] = await Promise.all([
          tx.ticket
            .aggregate({ where: { projectId: input.projectId }, _max: { number: true } })
            .then((row) => (row._max.number ?? 0) + 1),
          nextPosition(tx, input.projectId, input.state.id),
        ]);

        return tx.ticket.create({
          data: {
            projectId: input.projectId,
            stateId: input.state.id,
            boardId: input.boardId ?? null,
            cycleId: input.cycleId ?? null,
            parentId: input.parentId ?? null,
            number,
            position,
            title: input.title,
            description: input.description,
            priority: input.priority,
            assigneeId: input.assigneeId,
            dueDate: input.dueDate ?? null,
            startedAt: stamps.startedAt,
            completedAt: stamps.completedAt,
            ...(labelIds.length > 0 ? { labels: { connect: labelIds.map((id) => ({ id })) } } : {}),
            createdById: input.createdById,
          },
          select: { number: true },
        });
      });
    } catch (e) {
      if (attempt < 2 && isTicketNumberConflict(e)) continue;
      throw e;
    }
  }
}
