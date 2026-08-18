'use server';

/**
 * Document Server Actions, at PROJECT scope.
 *
 * The universal rules hold unchanged (SPEC 6.1): the literal first statement is
 * `await requireUser()`, every input is re-parsed with zod using the shared
 * schemas, and every client-supplied id is proved to belong to the
 * already-authorized project before it is written -- the document itself by
 * `requireDocument`, which walks up to the organization in one query, and a
 * `parentId` by a `findFirst` carrying the project id from that walk.
 *
 * WHO MAY DO WHAT mirrors the issue, not the project settings: any member may
 * create, edit and move, because writing down what the team knows is not an
 * escalation over filing an issue about it. Deleting is the creator, ADMIN or
 * OWNER -- the same rule as deleting an issue or a recurring template, and here
 * it matters more than either, because a delete takes the whole subtree with it.
 *
 * CONTENT AND PLACE ARE TWO ACTIONS, not one with four optional fields. They are
 * different writes with different rules: `updateDocument` cannot move anything,
 * so no edit can restructure the tree by accident, and `moveDocument` is the only
 * writer of `parentId`, so the cycle guard has exactly one place to live. The
 * recurring-template form splits CONTENT from SCHEDULE for the same reason.
 */

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { Role } from '@prisma/client';
import { z } from 'zod';

import {
  atLeast,
  docsPath,
  documentPath,
  requireDocument,
  requireProject,
  requireUser,
  runAction,
} from '@/lib/authz';
import { prisma } from '@/lib/db';
import { INVALID_INPUT, field, fieldErrorsOf } from '@/lib/action-input';
import { wouldCycle } from '@/lib/documents';
import { fail, ok, type ActionResult } from '@/lib/result';
import { cuid, documentBodySchema, documentTitleSchema } from '@/lib/validation';

const NOT_YOURS = 'Only the person who wrote this, or an admin, can delete it.';

const WOULD_CYCLE = 'A document cannot be filed inside itself.';

/** The empty string is how "top level" travels, exactly as '' means "none" elsewhere. */
const parentIdSchema = z.union([cuid, z.literal('')]).default('');

/**
 * A `parentId` from a form, proved to be a document of the SAME project.
 *
 * Returns null for "top level". A forged or foreign id is rejected rather than
 * dropped: silently filing a page at the top level when the caller asked for a
 * parent would look like the move worked and put the document somewhere nobody
 * chose.
 */
async function resolveParent(projectId: string, parentId: string): Promise<string | null> {
  if (parentId === '') return null;
  const parent = await prisma.document.findFirst({
    where: { id: parentId, projectId },
    select: { id: true },
  });
  return parent?.id ?? null;
}

/* -------------------------------------------------------------------------- */
/* createDocument                                                              */
/* -------------------------------------------------------------------------- */

const createSchema = z.object({
  projectId: cuid,
  title: documentTitleSchema,
  body: documentBodySchema.default(''),
  parentId: parentIdSchema,
});

/**
 * Navigates to the new document on success, which is what makes the "New
 * document" form one field: you name it here and write it there.
 */
export async function createDocument(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  // An object rather than a `let`, matching the other navigating actions: the
  // assignment happens inside a closure, and TypeScript cannot narrow a captured
  // local written there.
  const nav: { to?: string } = {};

  const result = await runAction(async () => {
    const user = await requireUser();

    const parsed = createSchema.safeParse({
      projectId: field(formData, 'projectId'),
      title: field(formData, 'title'),
      body: field(formData, 'body'),
      parentId: field(formData, 'parentId'),
    });
    if (!parsed.success) return fail(INVALID_INPUT, fieldErrorsOf(parsed.error));
    const input = parsed.data;

    // Walks project -> workspace -> organization -> membership in one query.
    const ctx = await requireProject(input.projectId);

    const parentId = await resolveParent(ctx.project.id, input.parentId);
    if (input.parentId !== '' && parentId === null) return fail(INVALID_INPUT);

    const document = await prisma.document.create({
      data: {
        projectId: ctx.project.id,
        parentId,
        title: input.title,
        body: input.body,
        // Identity comes from the session. Never from the form.
        createdById: user.id,
      },
      select: { id: true },
    });

    revalidatePath(docsPath(ctx.org, ctx.project));
    // The parent renders its children, so it is stale the moment this row exists.
    if (parentId) revalidatePath(documentPath(ctx.org, ctx.project, parentId));
    nav.to = documentPath(ctx.org, ctx.project, document.id);
    return ok();
  });

  // Outside `runAction`: `redirect()` signals by throwing, and `runAction` would
  // re-throw it correctly but the intent is clearer here, where every other
  // navigating action puts it.
  if (!result.ok) return result;
  if (nav.to) redirect(nav.to);
  return result;
}

/* -------------------------------------------------------------------------- */
/* updateDocument                                                              */
/* -------------------------------------------------------------------------- */

const updateSchema = z.object({
  documentId: cuid,
  title: documentTitleSchema,
  body: documentBodySchema.default(''),
});

/** Title and body together: the edit form owns both, and neither may be dropped. */
export async function updateDocument(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  return runAction(async () => {
    await requireUser();

    const parsed = updateSchema.safeParse({
      documentId: field(formData, 'documentId'),
      title: field(formData, 'title'),
      body: field(formData, 'body'),
    });
    if (!parsed.success) return fail(INVALID_INPUT, fieldErrorsOf(parsed.error));
    const input = parsed.data;

    const ctx = await requireDocument(input.documentId);

    // Scoped to the project the walk proved as well as to the id, so the WRITE
    // itself cannot reach outside the tenant even if the guard above were edited
    // wrongly one day.
    await prisma.document.updateMany({
      where: { id: ctx.document.id, projectId: ctx.project.id },
      data: { title: input.title, body: input.body },
    });

    revalidatePath(docsPath(ctx.org, ctx.project));
    revalidatePath(documentPath(ctx.org, ctx.project, ctx.document.id));
    // A renamed document is stale in its parent's children list too.
    if (ctx.document.parentId) {
      revalidatePath(documentPath(ctx.org, ctx.project, ctx.document.parentId));
    }
    return ok('Saved.');
  });
}

/* -------------------------------------------------------------------------- */
/* moveDocument                                                                */
/* -------------------------------------------------------------------------- */

const moveSchema = z.object({ documentId: cuid, parentId: parentIdSchema });

/**
 * The ONLY writer of `parentId`, and therefore the only place the acyclic
 * invariant can be broken.
 *
 * The picker on the page already omits the illegal choices, and this rejects them
 * again: a `<select>` is a suggestion, a POST body is whatever the caller typed,
 * and the MCP tool has no picker at all. Filing a document inside its own subtree
 * would detach that branch from every root -- it would vanish from the tree page,
 * the breadcrumbs and the MCP listing while still occupying rows and still
 * cascading a delete -- and would spin `ancestorChain` forever if the walk did not
 * defend itself.
 *
 * The whole project's `(id, parentId)` pairs are read to answer it. That is one
 * short query against a handful of rows, and it is the same query that renders
 * the tree; a recursive CTE would be a second way to express the same rule.
 */
export async function moveDocument(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  return runAction(async () => {
    await requireUser();

    const parsed = moveSchema.safeParse({
      documentId: field(formData, 'documentId'),
      parentId: field(formData, 'parentId'),
    });
    if (!parsed.success) return fail(INVALID_INPUT, fieldErrorsOf(parsed.error));
    const input = parsed.data;

    const ctx = await requireDocument(input.documentId);

    const parentId = await resolveParent(ctx.project.id, input.parentId);
    if (input.parentId !== '' && parentId === null) return fail(INVALID_INPUT);

    const rows = await prisma.document.findMany({
      where: { projectId: ctx.project.id },
      select: { id: true, parentId: true, title: true },
    });
    if (wouldCycle(rows, ctx.document.id, parentId)) return fail(WOULD_CYCLE);

    await prisma.document.updateMany({
      where: { id: ctx.document.id, projectId: ctx.project.id },
      data: { parentId },
    });

    revalidatePath(docsPath(ctx.org, ctx.project));
    revalidatePath(documentPath(ctx.org, ctx.project, ctx.document.id));
    // BOTH ends of the move: the old parent lost a child and the new one gained
    // one, and each of them renders that list.
    for (const id of [ctx.document.parentId, parentId]) {
      if (id) revalidatePath(documentPath(ctx.org, ctx.project, id));
    }
    return ok(parentId === null ? 'Moved to the top level.' : 'Moved.');
  });
}

/* -------------------------------------------------------------------------- */
/* deleteDocument                                                              */
/* -------------------------------------------------------------------------- */

const deleteSchema = z.object({ documentId: cuid });

/**
 * Deletes the document AND everything filed under it -- the `parentId` foreign key
 * cascades, so one statement takes the whole subtree.
 *
 * That is the intent ("delete this section" means the section), which is exactly
 * why this is the one role-gated action here and why the page makes you open a
 * disclosure that names the descendant count before the button exists to press.
 * There is no trash: the confirmation is the safety, and a member deleting a
 * colleague's handbook is not tidying up.
 */
export async function deleteDocument(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  const nav: { to?: string } = {};

  const result = await runAction(async () => {
    await requireUser();

    const parsed = deleteSchema.safeParse({ documentId: field(formData, 'documentId') });
    if (!parsed.success) return fail(INVALID_INPUT, fieldErrorsOf(parsed.error));

    const ctx = await requireDocument(parsed.data.documentId);
    // A rejection, not a thrown FORBIDDEN: the caller is already inside the
    // project and is looking at the document, so a sentence reads better than a
    // 404. Same choice `deleteRecurringTicket` makes, for the same reason.
    if (ctx.document.createdById !== ctx.user.id && !atLeast(ctx.role, Role.ADMIN)) {
      return fail(NOT_YOURS);
    }

    await prisma.document.deleteMany({
      where: { id: ctx.document.id, projectId: ctx.project.id },
    });

    revalidatePath(docsPath(ctx.org, ctx.project));
    // Back to the parent when there is one, so deleting a leaf leaves you where
    // you were reading rather than at the top of the tree -- revalidated first,
    // or it would render the row that has just gone.
    if (ctx.document.parentId) {
      revalidatePath(documentPath(ctx.org, ctx.project, ctx.document.parentId));
    }
    nav.to = ctx.document.parentId
      ? documentPath(ctx.org, ctx.project, ctx.document.parentId)
      : docsPath(ctx.org, ctx.project);
    return ok();
  });

  if (!result.ok) return result;
  if (nav.to) redirect(nav.to);
  return result;
}
