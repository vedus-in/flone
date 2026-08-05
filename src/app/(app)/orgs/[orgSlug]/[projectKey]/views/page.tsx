import Link from 'next/link';

import { issuesPath, loadPage, requireProjectByKey } from '@/lib/authz';
import { prisma } from '@/lib/db';
import { ActionForm } from '../../../../action-form';
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

type Params = { orgSlug: string; projectKey: string };

const DATE = new Intl.DateTimeFormat('en-GB', {
  dateStyle: 'medium',
  timeZone: 'UTC',
});

export default async function ViewsPage({ params }: { params: Promise<Params> }) {
  const { orgSlug, projectKey } = await params;
  const ctx = await loadPage(() => requireProjectByKey(orgSlug, projectKey.toUpperCase()));

  const views = await prisma.savedView.findMany({
    where: {
      projectId: ctx.project.id,
      // Shared, or your own. Never anyone else's private view.
      OR: [{ isShared: true }, { createdById: ctx.user.id }],
      project: { organization: { memberships: { some: { userId: ctx.user.id } } } },
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
    <div className="flex flex-col gap-4">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-lg font-semibold text-primary">Views</h1>
        <Link
          href={base}
          className="rounded-lg border border-secondary px-2.5 py-1.5 text-[0.8125rem] text-tertiary no-underline transition-colors hover:bg-secondary hover:text-primary"
        >
          Build a new one
        </Link>
      </header>

      {views.length === 0 ? (
        <div className="rounded-xl border border-secondary px-4 py-10 text-center text-sm text-tertiary">
          No saved views yet. Filter the issues list, then choose &ldquo;Save as view&rdquo;.
        </div>
      ) : (
        <ul className="overflow-hidden rounded-xl border border-secondary">
          {views.map((view) => (
            <li
              key={view.id}
              className="flex items-center gap-3 border-b border-secondary px-3 py-2 last:border-b-0 hover:bg-secondary/60"
            >
              <Link
                href={`${base}${view.query ? `?${view.query}` : ''}`}
                className="min-w-0 flex-1 truncate text-[0.8125rem] text-primary no-underline hover:underline"
              >
                {view.name}
              </Link>

              {!view.isShared ? (
                <span className="shrink-0 rounded-full border border-secondary px-2 py-px text-[0.6875rem] text-tertiary">
                  Private
                </span>
              ) : null}

              <span className="hidden shrink-0 text-[0.6875rem] text-tertiary sm:block">
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
                    className="rounded px-1.5 py-0.5 text-[0.6875rem] text-tertiary transition-colors hover:text-error-primary"
                  >
                    Delete
                  </button>
                </ActionForm>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
