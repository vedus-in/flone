import Link from 'next/link';

import { documentPath, loadPage, requireProjectByKey } from '@/lib/authz';
import { prisma } from '@/lib/db';
import { flattenTree } from '@/lib/documents';
import { Field, Input, SubmitButton } from '@/components/ui';
import { ActionForm } from '../../../../../action-form';
import { createDocument } from './actions';

/**
 * The project's documents: the whole tree on one page.
 *
 * ONE QUERY FOR THE WHOLE TREE, shaped in memory by `flattenTree`. A project's
 * documents are a handful of short rows -- id, parent, title -- so reading all of
 * them and indenting by depth costs less than a recursive CTE and far less than a
 * query per level. Bodies are NOT selected here: one of them can be 100k
 * characters, and this page renders none of them.
 *
 * The tree IS the organisation, as it is in Notion. There are no folders, no
 * tags and no second grouping to keep in sync -- a document is either under
 * another one or at the top level.
 *
 * Creating takes a title and nothing else: the body is written on the document's
 * own page, so the form here is one field and a button, and the action navigates
 * straight to what it made.
 */

type Params = { orgSlug: string; workspaceSlug: string; projectKey: string };

const DATE = new Intl.DateTimeFormat('en-GB', { dateStyle: 'medium', timeZone: 'UTC' });

export default async function DocsPage({ params }: { params: Promise<Params> }) {
  const { orgSlug, workspaceSlug, projectKey } = await params;
  const ctx = await loadPage(() =>
    requireProjectByKey(orgSlug, workspaceSlug, projectKey.toUpperCase()),
  );

  const documents = await prisma.document.findMany({
    where: { projectId: ctx.project.id },
    // Siblings read alphabetically: there is no hand-set order to respect, which
    // is the whole reason `Document` has no `position` column.
    orderBy: [{ title: 'asc' }, { id: 'asc' }],
    select: {
      id: true,
      parentId: true,
      title: true,
      updatedAt: true,
      createdBy: { select: { name: true } },
    },
  });

  const tree = flattenTree(documents);

  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex min-w-0 flex-col gap-1">
          <h1 className="text-lg font-semibold text-primary">Documents</h1>
          <p className="text-sm text-tertiary">
            Long-form pages for {ctx.project.name} — written in Markdown, nested however you
            like.
          </p>
        </div>
      </header>

      <ActionForm
        action={createDocument}
        className="flex flex-wrap items-end gap-3 rounded-xl border border-secondary p-3"
        // No `resetOnSuccess`: the action navigates to the document it just
        // created, so there is no form left to clear.
        aria-label="New document"
      >
        <input type="hidden" name="projectId" value={ctx.project.id} />
        <Field htmlFor="new-document-title" label="New document" className="min-w-0 flex-1">
          {/* `isRequired`, not `required`: `InputBase` spreads its props and then
              writes `required={isRequired}`, so a plain `required` is discarded. */}
          <Input
            id="new-document-title"
            name="title"
            isRequired
            maxLength={200}
            autoComplete="off"
            placeholder="Engineering handbook"
          />
        </Field>
        <SubmitButton size="sm" pendingLabel="Creating...">
          Create
        </SubmitButton>
      </ActionForm>

      {tree.length === 0 ? (
        <div className="rounded-xl border border-secondary px-4 py-10 text-center text-sm text-tertiary">
          No documents yet. Name one above and start writing.
        </div>
      ) : (
        <ul className="overflow-hidden rounded-xl border border-secondary">
          {tree.map((document) => (
            <li
              key={document.id}
              className="flex items-center gap-3 border-b border-secondary px-3 py-2 last:border-b-0 hover:bg-secondary/60"
            >
              <Link
                href={documentPath(ctx.org, ctx.project, document.id)}
                // Depth as an inline indent rather than a Tailwind class: the
                // nesting is unbounded, and a class per level would be a fixed
                // ladder that runs out.
                style={{ paddingInlineStart: `${document.depth * 1.25}rem` }}
                className="min-w-0 flex-1 truncate text-[0.8125rem] text-primary no-underline hover:underline"
              >
                {document.title}
              </Link>
              <span className="hidden shrink-0 text-[0.6875rem] text-tertiary sm:block">
                {document.createdBy.name} · {DATE.format(document.updatedAt)}
              </span>
            </li>
          ))}
        </ul>
      )}

      {tree.length > 0 ? (
        <p className="text-xs text-tertiary">
          {tree.length} {tree.length === 1 ? 'document' : 'documents'} in {ctx.project.key}.
        </p>
      ) : null}
    </div>
  );
}
