import Link from 'next/link';

import { documentPath, loadPage, requireProjectByKey } from '@/lib/authz';
import { prisma } from '@/lib/db';
import { flattenTree } from '@/lib/documents';
import { SubmitButton } from '@/components/ui';
import { ActionForm } from '../../../../../action-form';
import { createDocument } from './actions';
import { DocIcon } from './doc-icon';

/**
 * The project's documents: the whole tree on one page.
 *
 * ONE QUERY FOR THE WHOLE TREE, shaped in memory by `flattenTree`. A project's
 * documents are a handful of short rows -- id, parent, title -- so reading all of
 * them and indenting by depth costs less than a recursive CTE and far less than a
 * query per level. Bodies are NOT selected here: one of them can be 100k
 * characters, and this page renders none of them.
 *
 * THE LAYOUT IS A READING COLUMN, not the admin table the rest of the app uses:
 * `max-w-3xl mx-auto`, a large title, and rows that are hover targets rather
 * than bordered cells. Documents are prose, and prose earns the page Notion
 * gives it -- the shell's `max-w-7xl` stays for the surfaces that are actually
 * tables.
 *
 * The tree IS the organisation, as it is in Notion. There are no folders, no
 * tags and no second grouping to keep in sync -- a document is either under
 * another one or at the top level.
 *
 * Creating is the quiet row at the foot of the list, exactly where Notion puts
 * "+ New page": a borderless input, Enter or the button submits, and the action
 * navigates straight to the new document -- the body is written there.
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
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-8 py-4 lg:py-10">
      <header className="flex flex-col gap-2">
        <h1 className="text-3xl font-bold tracking-tight text-balance text-primary">
          Documents
        </h1>
        <p className="text-sm text-pretty text-tertiary">
          Long-form pages for {ctx.project.name}, written in Markdown and nested however you
          like.
        </p>
      </header>

      <div className="flex flex-col gap-px">
        {tree.length === 0 ? (
          <p className="px-2 pb-4 text-sm text-tertiary">
            Nothing here yet. Name a page below and start writing.
          </p>
        ) : (
          <ul className="flex flex-col gap-px">
            {tree.map((document) => (
              <li key={document.id}>
                <Link
                  href={documentPath(ctx.org, ctx.project, document.id)}
                  // Depth as an inline margin rather than a Tailwind class: the
                  // nesting is unbounded, and a class per level would be a fixed
                  // ladder that runs out. Margin, not padding, so the hover
                  // surface indents with the row.
                  style={{ marginInlineStart: `${document.depth * 1.5}rem` }}
                  className="group flex items-center gap-2.5 rounded-md px-2 py-1.5 no-underline transition-colors hover:bg-secondary/60"
                >
                  <DocIcon className="size-4 shrink-0 text-tertiary" />
                  <span className="min-w-0 flex-1 truncate text-[0.9375rem] font-medium text-primary">
                    {document.title}
                  </span>
                  {/* Quiet until the row is under the pointer: the list reads as
                      titles, and the provenance is there when you ask. */}
                  <span className="hidden shrink-0 text-xs text-tertiary opacity-0 transition-opacity group-hover:opacity-100 sm:block">
                    {document.createdBy.name} · {DATE.format(document.updatedAt)}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        )}

        <ActionForm
          action={createDocument}
          // No `resetOnSuccess`: the action navigates to the document it just
          // created, so there is no form left to clear.
          className="group flex items-center gap-2.5 rounded-md px-2 py-1.5 transition-colors focus-within:bg-secondary/40 hover:bg-secondary/40"
          aria-label="New document"
        >
          <input type="hidden" name="projectId" value={ctx.project.id} />
          <svg
            viewBox="0 0 16 16"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.2"
            strokeLinecap="round"
            className="size-4 shrink-0 text-tertiary"
            aria-hidden="true"
          >
            <path d="M8 3.5v9M3.5 8h9" />
          </svg>
          {/* A bare input, not the bordered field control: this row is furniture
              of the list, and Enter submits it like any form with one text input. */}
          <input
            name="title"
            required
            maxLength={200}
            autoComplete="off"
            placeholder="New document"
            aria-label="New document title"
            className="min-w-0 flex-1 bg-transparent text-[0.9375rem] text-primary placeholder:text-tertiary focus:outline-none"
          />
          <SubmitButton
            size="sm"
            color="link-gray"
            pendingLabel="Creating..."
            className="opacity-0 transition-opacity group-focus-within:opacity-100 group-hover:opacity-100"
          >
            Create
          </SubmitButton>
        </ActionForm>
      </div>
    </div>
  );
}
