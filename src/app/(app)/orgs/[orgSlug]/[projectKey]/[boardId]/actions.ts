'use server';

/**
 * SPEC 6.8 -- board-scoped Server Actions: createTicket, moveTicket, reorderTicket.
 *
 * Universal rules honoured in every action below:
 *   1. The literal first statement is `await requireUser()`.
 *   2. Input is re-parsed with zod, without exception.
 *   3. Resources are resolved only through a `require*` helper, which walks UP
 *      from the leaf id to the Organization inside a single `where` clause.
 *   4. `Ticket.columnId` is NEVER written without `requireColumnInBoard` first.
 *   5. `revalidatePath` is given a concrete path built from the upward walk,
 *      never from a client-submitted string.
 */

import { Prisma, Priority } from '@prisma/client';
import { revalidatePath } from 'next/cache';
import { z } from 'zod';

import {
  boardPath,
  requireBoard,
  requireColumnInBoard,
  requireTicket,
  requireUser,
  runAction,
  ticketPath,
} from '@/lib/authz';
import { prisma } from '@/lib/db';
import { fail, ok, type ActionResult } from '@/lib/result';
import { TICKET_ORDER, cuid, ticketDescriptionSchema, ticketTitleSchema } from '@/lib/validation';

/** The one closed literal this file may return beyond the shared `ERRORS`. */
const INVALID_INPUT = 'Please check the form and try again.';

/* -------------------------------------------------------------------------- */
/* Local helpers                                                               */
/* -------------------------------------------------------------------------- */

/** FormData values are `string | File | null`; everything here wants a string. */
function field(formData: FormData, key: string): string {
  const value = formData.get(key);
  return typeof value === 'string' ? value : '';
}

/** First message per field. Every message originates in our own schemas. */
function fieldErrorsOf(error: z.ZodError): Record<string, string> {
  const out: Record<string, string> = {};
  for (const issue of error.issues) {
    const key = issue.path[0];
    if (typeof key === 'string' && !(key in out)) out[key] = issue.message;
  }
  return out;
}

/**
 * SPEC 7.5: the `number` retry is keyed STRICTLY to the `(boardId, number)`
 * constraint. A blanket `P2002` retry would silently mask genuine unique
 * violations. Prisma reports `meta.target` as either the column list or the
 * constraint name depending on version, so both shapes are handled.
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
  return joined.includes('boardId') && joined.includes('number');
}

/* -------------------------------------------------------------------------- */
/* createTicket                                                                */
/* -------------------------------------------------------------------------- */

const createTicketSchema = z.object({
  boardId: cuid,
  columnId: cuid,
  title: ticketTitleSchema,
  description: ticketDescriptionSchema,
});

export async function createTicket(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  return runAction(async () => {
    const user = await requireUser();

    const parsed = createTicketSchema.safeParse({
      boardId: field(formData, 'boardId'),
      columnId: field(formData, 'columnId'),
      title: field(formData, 'title'),
      description: field(formData, 'description'),
    });
    if (!parsed.success) return fail(INVALID_INPUT, fieldErrorsOf(parsed.error));

    // Walks board -> project -> organization -> membership. Any role may create.
    const ctx = await requireBoard(parsed.data.boardId);
    // MANDATORY: proves the target column belongs to THIS board, so a forged
    // columnId cannot drop a ticket into another board's column.
    const column = await requireColumnInBoard(ctx.board.id, parsed.data.columnId);

    const description = parsed.data.description.length > 0 ? parsed.data.description : null;

    // SPEC 6.8 / 7.5: `number = max + 1` inside a transaction, up to 3 attempts.
    for (let attempt = 0; ; attempt += 1) {
      try {
        await prisma.$transaction(async (tx) => {
          const highestNumber = await tx.ticket.aggregate({
            where: { boardId: ctx.board.id },
            _max: { number: true },
          });
          const highestPosition = await tx.ticket.aggregate({
            where: { boardId: ctx.board.id, columnId: column.id },
            _max: { position: true },
          });

          await tx.ticket.create({
            data: {
              boardId: ctx.board.id,
              columnId: column.id,
              number: (highestNumber._max.number ?? 0) + 1,
              position: (highestPosition._max.position ?? 0) + 1,
              title: parsed.data.title,
              description,
              // Identity comes from the session. Never from the form.
              createdById: user.id,
            },
          });
        });
        break;
      } catch (e) {
        if (attempt < 2 && isTicketNumberConflict(e)) continue;
        throw e;
      }
    }

    revalidatePath(boardPath(ctx.org, ctx.project, ctx.board));
    return ok();
  });
}

/* -------------------------------------------------------------------------- */
/* moveTicket                                                                  */
/* -------------------------------------------------------------------------- */

const moveTicketSchema = z.object({
  ticketId: cuid,
  toColumnId: cuid,
});

export async function moveTicket(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  return runAction(async () => {
    await requireUser();

    const parsed = moveTicketSchema.safeParse({
      ticketId: field(formData, 'ticketId'),
      toColumnId: field(formData, 'toColumnId'),
    });
    if (!parsed.success) return fail(INVALID_INPUT, fieldErrorsOf(parsed.error));

    // Walks ticket -> board -> project -> organization -> membership.
    const ctx = await requireTicket(parsed.data.ticketId);
    // `ticket.boardId` comes from the authorized row, never from the client, so
    // a ticket can only ever land in a column of its OWN board.
    const target = await requireColumnInBoard(ctx.ticket.boardId, parsed.data.toColumnId);

    if (ctx.ticket.columnId !== target.id) {
      await prisma.$transaction(async (tx) => {
        const highestPosition = await tx.ticket.aggregate({
          where: { boardId: ctx.ticket.boardId, columnId: target.id },
          _max: { position: true },
        });
        await tx.ticket.update({
          where: { id: ctx.ticket.id },
          data: { columnId: target.id, position: (highestPosition._max.position ?? 0) + 1 },
        });
      });
    }

    revalidatePath(boardPath(ctx.org, ctx.project, ctx.board));
    revalidatePath(ticketPath(ctx.org, ctx.project, ctx.board, ctx.ticket.number));
    return ok();
  });
}

/* -------------------------------------------------------------------------- */
/* placeTicket -- the drag-and-drop primitive                                  */
/* -------------------------------------------------------------------------- */

const placeTicketSchema = z.object({
  ticketId: cuid,
  toColumnId: cuid,
  /** Destination index within the target column, clamped server-side. */
  toIndex: z.coerce.number().int().min(0).max(10_000),
});

/**
 * Move a ticket to an arbitrary (column, index). This is what a drop expresses,
 * and neither `moveTicket` (appends to the end) nor `reorderTicket` (swaps with
 * a neighbour) can say it.
 *
 * Takes plain arguments rather than FormData because it is invoked from a drag
 * handler, not a form submit. That changes nothing about trust: the arguments
 * are still zod-validated, the session is still re-derived here, and the target
 * column is still re-vetted against the ticket's OWN board, so a forged
 * `toColumnId` cannot move a ticket into another board or another tenant.
 */
export async function placeTicket(input: {
  ticketId: string;
  toColumnId: string;
  toIndex: number;
}): Promise<ActionResult> {
  return runAction(async () => {
    await requireUser();

    const parsed = placeTicketSchema.safeParse(input);
    if (!parsed.success) return fail(INVALID_INPUT, fieldErrorsOf(parsed.error));

    // Walks ticket -> board -> project -> organization -> membership.
    const ctx = await requireTicket(parsed.data.ticketId);
    // `ctx.ticket.boardId` is from the authorized row, never the client.
    const target = await requireColumnInBoard(ctx.ticket.boardId, parsed.data.toColumnId);
    const fromColumnId = ctx.ticket.columnId;

    await prisma.$transaction(async (tx) => {
      const destination = await tx.ticket.findMany({
        where: {
          boardId: ctx.ticket.boardId,
          columnId: target.id,
          id: { not: ctx.ticket.id },
        },
        orderBy: TICKET_ORDER,
        select: { id: true, position: true },
      });

      const index = Math.min(parsed.data.toIndex, destination.length);
      const ordered = [
        ...destination.slice(0, index),
        { id: ctx.ticket.id, position: -1 },
        ...destination.slice(index),
      ];

      const pending = new Map<string, { position: number; columnId?: string }>();
      ordered.forEach((row, i) => {
        if (row.id === ctx.ticket.id) {
          pending.set(row.id, { position: i, columnId: target.id });
        } else if (row.position !== i) {
          pending.set(row.id, { position: i });
        }
      });

      // Leaving a column leaves a hole; close it so positions stay dense.
      if (fromColumnId !== target.id) {
        const source = await tx.ticket.findMany({
          where: {
            boardId: ctx.ticket.boardId,
            columnId: fromColumnId,
            id: { not: ctx.ticket.id },
          },
          orderBy: TICKET_ORDER,
          select: { id: true, position: true },
        });
        source.forEach((row, i) => {
          if (row.position !== i) pending.set(row.id, { position: i });
        });
      }

      // One globally id-sorted write pass across BOTH columns. Sorting each
      // column separately would still let two opposite-direction drags take
      // locks in opposite orders and deadlock; a single ascending-id order is
      // the same for every concurrent transaction, so a cycle is impossible.
      const updates = [...pending.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1));
      for (const [id, data] of updates) {
        await tx.ticket.update({ where: { id }, data });
      }
    });

    revalidatePath(boardPath(ctx.org, ctx.project, ctx.board));
    revalidatePath(ticketPath(ctx.org, ctx.project, ctx.board, ctx.ticket.number));
    return ok();
  });
}

/* -------------------------------------------------------------------------- */
/* reorderTicket                                                               */
/* -------------------------------------------------------------------------- */

const reorderTicketSchema = z.object({
  ticketId: cuid,
  direction: z.enum(['up', 'down']),
});

export async function reorderTicket(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  return runAction(async () => {
    await requireUser();

    const parsed = reorderTicketSchema.safeParse({
      ticketId: field(formData, 'ticketId'),
      direction: field(formData, 'direction'),
    });
    if (!parsed.success) return fail(INVALID_INPUT, fieldErrorsOf(parsed.error));

    const ctx = await requireTicket(parsed.data.ticketId);

    // SPEC 7.4: swapping two `position` values is WRONG when the two are tied,
    // which the non-unique, never-compacted scheme permits. So the single
    // affected column is densely renumbered inside the transaction instead.
    await prisma.$transaction(async (tx) => {
      const siblings = await tx.ticket.findMany({
        where: { boardId: ctx.ticket.boardId, columnId: ctx.ticket.columnId },
        orderBy: TICKET_ORDER,
        select: { id: true, position: true },
      });

      const index = siblings.findIndex((row) => row.id === ctx.ticket.id);
      if (index === -1) return;

      const swapWith = parsed.data.direction === 'up' ? index - 1 : index + 1;
      // Already at the edge of its column: a no-op, not an error.
      if (swapWith < 0 || swapWith >= siblings.length) return;

      const reordered = siblings.slice();
      const moved = reordered[index];
      reordered[index] = reordered[swapWith];
      reordered[swapWith] = moved;

      // Compute the full id -> position mapping first, then write it in a
      // canonical order (ascending id). The mapping does not depend on the
      // order the UPDATEs are issued in, but the row locks do: issuing them in
      // `reordered` order means two concurrent reorders of the same column can
      // take locks in opposite orders and deadlock, which surfaces to the user
      // as a spurious "Something went wrong." Ascending id is the same order
      // for every concurrent transaction, so a lock cycle is impossible.
      const updates = reordered
        .map((row, i) => ({ id: row.id, position: i, was: row.position }))
        .filter((u) => u.was !== u.position)
        .sort((a, b) => (a.id < b.id ? -1 : 1));

      for (const u of updates) {
        await tx.ticket.update({ where: { id: u.id }, data: { position: u.position } });
      }
    });

    revalidatePath(boardPath(ctx.org, ctx.project, ctx.board));
    return ok();
  });
}

/* -------------------------------------------------------------------------- */
/* Card context-menu actions                                                   */
/*                                                                             */
/* All take plain arguments rather than FormData because they are invoked from  */
/* a menu, not a form submit. That changes nothing about trust: each one still  */
/* re-derives the session, zod-validates its input, and resolves the ticket     */
/* through `requireTicket`, which walks ticket -> board -> project ->           */
/* organization -> membership in a single where clause.                        */
/* -------------------------------------------------------------------------- */

const setPrioritySchema = z.object({
  ticketId: cuid,
  priority: z.nativeEnum(Priority),
});

export async function setTicketPriority(input: {
  ticketId: string;
  priority: Priority;
}): Promise<ActionResult> {
  return runAction(async () => {
    await requireUser();

    const parsed = setPrioritySchema.safeParse(input);
    if (!parsed.success) return fail(INVALID_INPUT, fieldErrorsOf(parsed.error));

    const ctx = await requireTicket(parsed.data.ticketId);

    await prisma.ticket.update({
      where: { id: ctx.ticket.id },
      data: { priority: parsed.data.priority },
    });

    revalidatePath(boardPath(ctx.org, ctx.project, ctx.board));
    revalidatePath(ticketPath(ctx.org, ctx.project, ctx.board, ctx.ticket.number));
    return ok();
  });
}

const setDueDateSchema = z.object({
  ticketId: cuid,
  /** ISO date (YYYY-MM-DD), or null to clear. */
  dueDate: z.union([z.string().regex(/^\d{4}-\d{2}-\d{2}$/), z.null()]),
});

export async function setTicketDueDate(input: {
  ticketId: string;
  dueDate: string | null;
}): Promise<ActionResult> {
  return runAction(async () => {
    await requireUser();

    const parsed = setDueDateSchema.safeParse(input);
    if (!parsed.success) return fail(INVALID_INPUT, fieldErrorsOf(parsed.error));

    const ctx = await requireTicket(parsed.data.ticketId);

    // Parsed as UTC midnight so the stored instant does not drift a day
    // depending on where the server happens to be running.
    const value =
      parsed.data.dueDate === null ? null : new Date(`${parsed.data.dueDate}T00:00:00.000Z`);
    if (value !== null && Number.isNaN(value.getTime())) return fail(INVALID_INPUT);

    await prisma.ticket.update({
      where: { id: ctx.ticket.id },
      data: { dueDate: value },
    });

    revalidatePath(boardPath(ctx.org, ctx.project, ctx.board));
    revalidatePath(ticketPath(ctx.org, ctx.project, ctx.board, ctx.ticket.number));
    return ok();
  });
}

const assignFromBoardSchema = z.object({
  ticketId: cuid,
  /** The empty string unassigns. */
  assigneeId: z.union([cuid, z.literal('')]),
});

export async function assignTicketFromBoard(input: {
  ticketId: string;
  assigneeId: string;
}): Promise<ActionResult> {
  return runAction(async () => {
    await requireUser();

    const parsed = assignFromBoardSchema.safeParse(input);
    if (!parsed.success) return fail(INVALID_INPUT, fieldErrorsOf(parsed.error));

    const ctx = await requireTicket(parsed.data.ticketId);

    // The assignee must be a member of THIS organization. Without this check a
    // valid cuid for any user on the instance would be accepted, which both
    // leaks that the account exists and lets a stranger be assigned work.
    if (parsed.data.assigneeId !== '') {
      const membership = await prisma.membership.findFirst({
        where: { organizationId: ctx.org.id, userId: parsed.data.assigneeId },
        select: { id: true },
      });
      if (!membership) return fail('That person is not a member of this organization.');
    }

    await prisma.ticket.update({
      where: { id: ctx.ticket.id },
      data: { assigneeId: parsed.data.assigneeId === '' ? null : parsed.data.assigneeId },
    });

    revalidatePath(boardPath(ctx.org, ctx.project, ctx.board));
    revalidatePath(ticketPath(ctx.org, ctx.project, ctx.board, ctx.ticket.number));
    return ok();
  });
}

const deleteFromBoardSchema = z.object({ ticketId: cuid });

export async function deleteTicketFromBoard(input: { ticketId: string }): Promise<ActionResult> {
  return runAction(async () => {
    await requireUser();

    const parsed = deleteFromBoardSchema.safeParse(input);
    if (!parsed.success) return fail(INVALID_INPUT, fieldErrorsOf(parsed.error));

    const ctx = await requireTicket(parsed.data.ticketId);

    // Comments cascade with the ticket per the schema.
    await prisma.ticket.delete({ where: { id: ctx.ticket.id } });

    revalidatePath(boardPath(ctx.org, ctx.project, ctx.board));
    return ok();
  });
}

const moveToBoardSchema = z.object({
  ticketId: cuid,
  toBoardId: cuid,
});

/**
 * Move a ticket to a DIFFERENT board in the same project.
 *
 * The ticket's `number` is unique per board, so it has to be reallocated in the
 * destination, and the ticket has to land in a real column of that board.
 */
export async function moveTicketToBoard(input: {
  ticketId: string;
  toBoardId: string;
}): Promise<ActionResult> {
  return runAction(async () => {
    await requireUser();

    const parsed = moveToBoardSchema.safeParse(input);
    if (!parsed.success) return fail(INVALID_INPUT, fieldErrorsOf(parsed.error));

    const ctx = await requireTicket(parsed.data.ticketId);
    // Authorizes the destination independently -- it is a client-supplied id.
    const destination = await requireBoard(parsed.data.toBoardId);

    if (destination.board.id === ctx.ticket.boardId) return ok('Already on that board.');
    // Both boards are membership-checked above, but they could still belong to
    // different projects; keep a ticket inside its own project.
    if (destination.project.id !== ctx.project.id) {
      return fail('A ticket can only move between boards of the same project.');
    }

    await prisma.$transaction(async (tx) => {
      const firstColumn = await tx.boardColumn.findFirst({
        where: { boardId: destination.board.id },
        orderBy: [{ position: 'asc' }, { id: 'asc' }],
        select: { id: true },
      });
      if (!firstColumn) throw new Error('destination board has no columns');

      const [highestNumber, highestPosition] = await Promise.all([
        tx.ticket.aggregate({
          where: { boardId: destination.board.id },
          _max: { number: true },
        }),
        tx.ticket.aggregate({
          where: { boardId: destination.board.id, columnId: firstColumn.id },
          _max: { position: true },
        }),
      ]);

      await tx.ticket.update({
        where: { id: ctx.ticket.id },
        data: {
          boardId: destination.board.id,
          columnId: firstColumn.id,
          number: (highestNumber._max.number ?? 0) + 1,
          position: (highestPosition._max.position ?? 0) + 1,
        },
      });
    });

    revalidatePath(boardPath(ctx.org, ctx.project, ctx.board));
    revalidatePath(boardPath(destination.org, destination.project, destination.board));
    return ok('Moved to another board.');
  });
}
