'use server';

/**
 * SPEC 6.9 -- comment-scoped Server Actions.
 *
 * The issue writes that used to live here moved up to
 * `[projectKey]/issue-actions.ts` when an issue stopped belonging to a board.
 * What remains is the comment thread, which is genuinely local to this route.
 *
 * Every action re-derives the session itself: a Server Action is a directly
 * addressable POST endpoint that the layout which rendered the form does not
 * cover, so nothing above it may be trusted to have authorized anything.
 *
 * Every resource is resolved through a `require*` helper that walks UP to the
 * Organization inside one `where` clause (comment -> ticket -> project ->
 * organization -> membership). No `organizationId`, `projectId`, `userId` or
 * `role` is ever read from the form.
 */

import { revalidatePath } from 'next/cache';
import { z } from 'zod';

import {
  requireAuthorOrRole,
  requireComment,
  requireTicket,
  requireUser,
  runAction,
  ticketPath,
  ticketSurfaces,
} from '@/lib/authz';
import { prisma } from '@/lib/db';
import { appUrl } from '@/lib/email';
import { notifyCommentEdited, notifyNewComment } from '@/lib/mailer';
import { fail, ok, type ActionResult } from '@/lib/result';
import { INVALID_INPUT, field, fieldErrorsOf } from '@/lib/action-input';
import { commentBodySchema, cuid } from '@/lib/validation';

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

    // The thread: whoever filed it, whoever owns it, everyone who has already
    // commented, plus anyone the body @mentioned. `notifyNewComment` resolves
    // and deduplicates that set, drops the author, and drops anyone who has
    // muted comment mail -- so a self-comment on your own issue sends nothing.
    // The mentions are re-derived there from the stored body against THIS
    // organization's members; nothing about who was tagged comes off the form.
    await notifyNewComment({
      ticketId: ctx.ticket.id,
      organizationId: ctx.org.id,
      actorId: user.id,
      actorName: user.name,
      body: parsed.data.body,
      issue: {
        issueKey: `${ctx.project.key}-${ctx.ticket.number}`,
        issueTitle: ctx.ticket.title,
        projectName: ctx.project.name,
        url: appUrl(ticketPath(ctx.org, ctx.project, ctx.ticket.number)),
      },
    });

    for (const path of ticketSurfaces(ctx)) revalidatePath(path);
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

    // Walks comment -> ticket -> project -> organization -> membership.
    const ctx = await requireComment(parsed.data.commentId);
    requireAuthorOrRole(ctx, ctx.comment.authorId, 'ADMIN');

    await prisma.comment.update({
      where: { id: ctx.comment.id },
      data: { body: parsed.data.body },
    });

    // Tagging someone you forgot is the ordinary reason a comment gets edited,
    // and after posting it is the only way to do it. Only the mentions the edit
    // ADDED are mailed -- `ctx.comment.body` is the pre-edit text.
    await notifyCommentEdited({
      organizationId: ctx.org.id,
      actorId: ctx.user.id,
      actorName: ctx.user.name,
      previousBody: ctx.comment.body,
      body: parsed.data.body,
      issue: {
        issueKey: `${ctx.project.key}-${ctx.ticket.number}`,
        issueTitle: ctx.ticket.title,
        projectName: ctx.project.name,
        url: appUrl(ticketPath(ctx.org, ctx.project, ctx.ticket.number)),
      },
    });

    for (const path of ticketSurfaces(ctx)) revalidatePath(path);
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

    for (const path of ticketSurfaces(ctx)) revalidatePath(path);
    return ok();
  });
}
