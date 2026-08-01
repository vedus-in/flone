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

import { Prisma } from '@prisma/client';
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

      for (let i = 0; i < reordered.length; i += 1) {
        const row = reordered[i];
        if (row.position === i) continue;
        await tx.ticket.update({ where: { id: row.id }, data: { position: i } });
      }
    });

    revalidatePath(boardPath(ctx.org, ctx.project, ctx.board));
    return ok();
  });
}
