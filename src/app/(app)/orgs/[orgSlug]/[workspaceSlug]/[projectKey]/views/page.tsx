import Link from 'next/link';

import { projectCrumb } from '@/components/crumbs';
import { IconPlus, IconViews } from '@/components/icons';
import { PAGE_BAR_ACTION, PageBar } from '@/components/page-bar';
import { issuesPath, loadPage, requireProjectByKey, visibleProject } from '@/lib/authz';
import { prisma } from '@/lib/db';
import { ActionForm } from '../../../../../action-form';
import { deleteSavedView } from '../actions';

/**
 * Saved views: named filters.
 *
 * A view is a stored query string and a name, so replaying one is a plain link
 * back to the issues list. Nothing is duplicated and nothing can go stale
 * against the filters the list actually understands -- a view naming a label
 * that was since deleted simply shows the unfiltered list.
 *
 * Private views belong to their creator. The `where` clause makes that a
 * database predicate rather than a render-time `if`, so another member's private
 * view is not merely hidden -- it is never fetched.
 */

type Params = { orgSlug: string; workspaceSlug: string; projectKey: string };

const DATE = new Intl.DateTimeFormat('en-US', {
  dateStyle: 'medium',
  timeZone: 'UTC',
});

export default async function ViewsPage({ params }: { params: Promise<Params> }) {
  const { orgSlug, workspaceSlug, projectKey } = await params;
  const ctx = await loadPage(() => requireProjectByKey(orgSlug, workspaceSlug, projectKey.toUpperCase()));

  const views = await prisma.savedView.findMany({
    where: {
      projectId: ctx.project.id,
      // Shared, or your own. Never anyone else's private view.
      OR: [{ isShared: true }, { createdById: ctx.user.id }],
      project: visibleProject(ctx.user.id),
    },
    orderBy: [{ name: 'asc' }, { id: 'asc' }],
    select: {
      id: true,
      name: true,
      query: true,
      isShared: true,
      createdAt: true,
      createdById: true,
      createdBy: { select: { name: true } },
    },
  });

  const base = issuesPath(ctx.org, ctx.project);
  const canManage = ctx.role === 'ADMIN' || ctx.role === 'OWNER';

  return (
    <>
      <PageBar
        crumbs={[projectCrumb(ctx.org, ctx.project), { label: 'Views' }]}
        actions={
          <Link href={base} className={PAGE_BAR_ACTION}>
            <IconPlus className="size-3.5" />
            New view
          </Link>
        }
      />

      {views.length === 0 ? (
        <p className="px-4.5 py-10 text-center text-sm text-tertiary">
          No saved views yet. Filter the issues list, then choose &ldquo;Save as view&rdquo;.
        </p>
      ) : (
        <ul className="flex flex-col py-2">
          {views.map((view) => (
            <li
              key={view.id}
              className="group mx-2 flex h-11 items-center gap-3 rounded-md px-2.5 transition-colors hover:bg-secondary"
            >
              <IconViews className="size-4 text-tertiary" />
              <Link
                href={`${base}${view.query ? `?${view.query}` : ''}`}
                className="min-w-0 flex-1 truncate text-sm font-medium text-primary no-underline"
              >
                {view.name}
              </Link>

              {!view.isShared ? (
                <span className="shrink-0 rounded-full border border-secondary px-2 py-px text-[0.6875rem] text-tertiary">
                  Private
                </span>
              ) : null}

              <span className="hidden shrink-0 text-xs text-tertiary sm:block">
                {view.createdBy.name} &middot; {DATE.format(view.createdAt)}
              </span>

              {view.createdById === ctx.user.id || canManage ? (
                <ActionForm
                  action={deleteSavedView}
                  className="shrink-0"
                  aria-label={`Delete ${view.name}`}
                >
                  <input type="hidden" name="projectId" value={ctx.project.id} />
                  <input type="hidden" name="viewId" value={view.id} />
                  <button
                    type="submit"
                    className="rounded-md px-1.5 py-0.5 text-xs text-tertiary opacity-0 transition group-hover:opacity-100 hover:text-error-primary focus-visible:opacity-100"
                  >
                    Delete
                  </button>
                </ActionForm>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
