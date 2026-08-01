'use server';

/**
 * SPEC 6.9 -- ticket- and comment-scoped Server Actions.
 *
 * Every action re-derives the session itself: a Server Action is a directly
 * addressable POST endpoint that the layout which rendered the form does not
 * cover, so nothing above it may be trusted to have authorized anything.
 *
 * Every resource is resolved through a `require*` helper that walks UP to the
 * Organization inside one `where` clause (comment -> ticket -> board -> project
 * -> organization -> membership). No `organizationId`, `projectId`, `userId` or
 * `role` is ever read from the form.
 *
 * `redirect()` is called AFTER the try/catch closes, on the success path only.
 */

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { z } from 'zod';

import {
  assertOrgMember,
  boardPath,
  requireAuthorOrRole,
  requireComment,
  requireTicket,
  requireUser,
  runAction,
  ticketPath,
} from '@/lib/authz';
import { prisma } from '@/lib/db';
import { fail, ok, type ActionResult } from '@/lib/result';
import { commentBodySchema, cuid, ticketDescriptionSchema, ticketTitleSchema } from '@/lib/validation';

/** The one closed literal this file may return beyond the shared `ERRORS`. */
const INVALID_INPUT = 'Please check the form and try again.';

/* -------------------------------------------------------------------------- */
/* Local helpers                                                               */
/* -------------------------------------------------------------------------- */

function field(formData: FormData, key: string): string {
  const value = formData.get(key);
  return typeof value === 'string' ? value : '';
}

function fieldErrorsOf(error: z.ZodError): Record<string, string> {
  const out: Record<string, string> = {};
  for (const issue of error.issues) {
    const key = issue.path[0];
    if (typeof key === 'string' && !(key in out)) out[key] = issue.message;
  }
  return out;
}

/* -------------------------------------------------------------------------- */
/* updateTicket                                                                */
/* -------------------------------------------------------------------------- */

const updateTicketSchema = z.object({
  ticketId: cuid,
  title: ticketTitleSchema,
  description: ticketDescriptionSchema,
});

export async function updateTicket(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  return runAction(async () => {
    await requireUser();

    const parsed = updateTicketSchema.safeParse({
      ticketId: field(formData, 'ticketId'),
      title: field(formData, 'title'),
      description: field(formData, 'description'),
    });
    if (!parsed.success) return fail(INVALID_INPUT, fieldErrorsOf(parsed.error));

    // Any role may edit a ticket (SPEC role matrix).
    const ctx = await requireTicket(parsed.data.ticketId);

    await prisma.ticket.update({
      where: { id: ctx.ticket.id },
      data: {
        title: parsed.data.title,
        description: parsed.data.description.length > 0 ? parsed.data.description : null,
      },
    });

    revalidatePath(ticketPath(ctx.org, ctx.project, ctx.board, ctx.ticket.number));
    revalidatePath(boardPath(ctx.org, ctx.project, ctx.board));
    return ok('Ticket updated.');
  });
}

/* -------------------------------------------------------------------------- */
/* assignTicket                                                                */
/* -------------------------------------------------------------------------- */

const assignTicketSchema = z.object({
  ticketId: cuid,
  /** The empty string unassigns. */
  assigneeId: z.union([cuid, z.literal('')]),
});

export async function assignTicket(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  return runAction(async () => {
    await requireUser();

    const parsed = assignTicketSchema.safeParse({
      ticketId: field(formData, 'ticketId'),
      assigneeId: field(formData, 'assigneeId'),
    });
    if (!parsed.success) return fail(INVALID_INPUT, fieldErrorsOf(parsed.error));

    const ctx = await requireTicket(parsed.data.ticketId);

    // MANDATORY before any write of `assigneeId`: a candidate outside this
    // organization raises NOT_FOUND, so assignment cannot be used to probe for
    // user ids across the tenant boundary.
    if (parsed.data.assigneeId !== '') {
      await assertOrgMember(ctx.org.id, parsed.data.assigneeId);
    }

    await prisma.ticket.update({
      where: { id: ctx.ticket.id },
      data: { assigneeId: parsed.data.assigneeId === '' ? null : parsed.data.assigneeId },
    });

    revalidatePath(ticketPath(ctx.org, ctx.project, ctx.board, ctx.ticket.number));
    revalidatePath(boardPath(ctx.org, ctx.project, ctx.board));
    return ok('Assignee updated.');
  });
}

/* -------------------------------------------------------------------------- */
/* deleteTicket                                                                */
/* -------------------------------------------------------------------------- */

const deleteTicketSchema = z.object({ ticketId: cuid });

export async function deleteTicket(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  // A plain object holder, so the redirect target survives the closure without
  // relying on control-flow narrowing across an `await`.
  const navigation: { to?: string } = {};

  const result = await runAction(async () => {
    await requireUser();

    const parsed = deleteTicketSchema.safeParse({ ticketId: field(formData, 'ticketId') });
    if (!parsed.success) return fail(INVALID_INPUT, fieldErrorsOf(parsed.error));

    const ctx = await requireTicket(parsed.data.ticketId);
    // SPEC 7.18: the author, or ADMIN/OWNER. A MEMBER may not destroy another
    // member's work, while ticket EDITING stays open to every member.
    requireAuthorOrRole(ctx, ctx.ticket.createdById, 'ADMIN');

    // Comments cascade with the ticket.
    await prisma.ticket.delete({ where: { id: ctx.ticket.id } });

    revalidatePath(boardPath(ctx.org, ctx.project, ctx.board));
    navigation.to = boardPath(ctx.org, ctx.project, ctx.board);
    return ok();
  });

  if (result.ok && navigation.to) redirect(navigation.to);
  return result;
}

/* -------------------------------------------------------------------------- */
/* createComment                                                               */
/* -------------------------------------------------------------------------- */

const createCommentSchema = z.object({
  ticketId: cuid,
  body: commentBodySchema,
});

export async function createComment(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  return runAction(async () => {
    const user = await requireUser();

    const parsed = createCommentSchema.safeParse({
      ticketId: field(formData, 'ticketId'),
      body: field(formData, 'body'),
    });
    if (!parsed.success) return fail(INVALID_INPUT, fieldErrorsOf(parsed.error));

    const ctx = await requireTicket(parsed.data.ticketId);

    await prisma.comment.create({
      data: {
        ticketId: ctx.ticket.id,
        // Authorship comes from the session, never from the form.
        authorId: user.id,
        body: parsed.data.body,
      },
    });

    revalidatePath(ticketPath(ctx.org, ctx.project, ctx.board, ctx.ticket.number));
    revalidatePath(boardPath(ctx.org, ctx.project, ctx.board));
    return ok();
  });
}

/* -------------------------------------------------------------------------- */
/* updateComment                                                               */
/* -------------------------------------------------------------------------- */

const updateCommentSchema = z.object({
  commentId: cuid,
  body: commentBodySchema,
});

export async function updateComment(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  return runAction(async () => {
    await requireUser();

    const parsed = updateCommentSchema.safeParse({
      commentId: field(formData, 'commentId'),
      body: field(formData, 'body'),
    });
    if (!parsed.success) return fail(INVALID_INPUT, fieldErrorsOf(parsed.error));

    // Walks comment -> ticket -> board -> project -> organization -> membership.
    const ctx = await requireComment(parsed.data.commentId);
    requireAuthorOrRole(ctx, ctx.comment.authorId, 'ADMIN');

    await prisma.comment.update({
      where: { id: ctx.comment.id },
      data: { body: parsed.data.body },
    });

    revalidatePath(ticketPath(ctx.org, ctx.project, ctx.board, ctx.ticket.number));
    return ok('Comment updated.');
  });
}

/* -------------------------------------------------------------------------- */
/* deleteComment                                                               */
/* -------------------------------------------------------------------------- */

const deleteCommentSchema = z.object({ commentId: cuid });

export async function deleteComment(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  return runAction(async () => {
    await requireUser();

    const parsed = deleteCommentSchema.safeParse({ commentId: field(formData, 'commentId') });
    if (!parsed.success) return fail(INVALID_INPUT, fieldErrorsOf(parsed.error));

    const ctx = await requireComment(parsed.data.commentId);
    requireAuthorOrRole(ctx, ctx.comment.authorId, 'ADMIN');

    await prisma.comment.delete({ where: { id: ctx.comment.id } });

    revalidatePath(ticketPath(ctx.org, ctx.project, ctx.board, ctx.ticket.number));
    revalidatePath(boardPath(ctx.org, ctx.project, ctx.board));
    return ok();
  });
}
