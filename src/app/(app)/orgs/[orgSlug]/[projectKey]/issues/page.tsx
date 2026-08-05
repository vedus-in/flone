import Link from 'next/link';

import { IssueListView } from '@/components/issue-row';
import { loadPage, issuesPath, requireProjectByKey } from '@/lib/authz';
import { hasActiveFilter, loadIssues, parseIssueFilters, withFilter } from '@/lib/issues';
import { PRIORITY_LABEL, PRIORITY_ORDER, TAB_LABEL, ISSUE_TABS } from '@/lib/model';
import { defaultComposeState } from '@/lib/states';
import { loadWorkspace } from '@/lib/workspace';
import { cx } from '@/lib/utils/cx';

import { IssueComposer } from '../issue-composer';
import { SaveViewForm } from '../views/save-view-form';

/**
 * The issues list: Active / Backlog / All issues, grouped by workflow state.
 *
 * The filter state lives entirely in the query string. That is not a shortcut --
 * it is what makes every view shareable, bookmarkable and correct under
 * back/forward with no client state at all, and it is what lets a saved view be
 * nothing more than a stored query string.
 *
 * `requireProjectByKey` constrains the project key AND the org slug in one query
 * together with the caller's membership, so a mismatch anywhere in the tuple
 * yields a plain 404 with no existence oracle.
 */

type Params = { orgSlug: string; projectKey: string };
type Search = Record<string, string | string[] | undefined>;

export default async function IssuesPage({
  params,
  searchParams,
}: {
  params: Promise<Params>;
  searchParams: Promise<Search>;
}) {
  const { orgSlug, projectKey } = await params;
  const search = await searchParams;

  const ctx = await loadPage(() => requireProjectByKey(orgSlug, projectKey.toUpperCase()));
  const filters = parseIssueFilters(search);
  const workspace = await loadWorkspace(ctx);
  const { groups, total, truncated } = await loadIssues(ctx, { filters });

  const base = issuesPath(ctx.org, ctx.project);
  const composeState = defaultComposeState(workspace.states);

  return (
    <div className="flex flex-col gap-4">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <h1 className="text-lg font-semibold text-primary">Issues</h1>
          <span className="text-sm text-tertiary tabular-nums">
            {total} {total === 1 ? 'issue' : 'issues'}
          </span>
        </div>
        {composeState ? (
          <IssueComposer
            projectId={ctx.project.id}
            projectKey={ctx.project.key}
            states={workspace.states}
            boards={workspace.boards}
            cycles={workspace.cycles}
            labels={workspace.labels}
            members={workspace.members}
            defaultStateId={composeState.id}
            defaultBoardId={filters.boardId ?? ''}
            defaultCycleId={filters.cycleId ?? ''}
          />
        ) : null}
      </header>

      {/* Tabs. Plain links, so each one is a real URL you can send someone. */}
      <nav aria-label="Issue filter" className="flex items-center gap-1 border-b border-secondary">
        {ISSUE_TABS.map((tab) => {
          const active = filters.tab === tab;
          return (
            <Link
              key={tab}
              href={`${base}${withFilter(filters, { tab })}`}
              aria-current={active ? 'page' : undefined}
              className={cx(
                '-mb-px border-b-2 px-3 py-1.5 text-[0.8125rem] no-underline transition-colors',
                active
                  ? 'border-brand font-medium text-primary'
                  : 'border-transparent text-tertiary hover:text-primary',
              )}
            >
              {TAB_LABEL[tab]}
            </Link>
          );
        })}
      </nav>

      {/* A native GET form. No JavaScript, no client state, and the resulting
          URL is the shareable thing the whole page is built around. */}
      <form method="get" action={base} className="flex flex-wrap items-center gap-2">
        <input type="hidden" name="tab" value={filters.tab} />

        <input
          type="search"
          name="q"
          defaultValue={filters.query ?? ''}
          placeholder="Filter by title…"
          maxLength={200}
          aria-label="Filter by title"
          className="h-8 min-w-40 flex-1 rounded-lg border border-secondary bg-primary px-2.5 text-[0.8125rem] text-primary placeholder:text-tertiary focus:outline-2 focus:outline-offset-1 focus:outline-focus-ring"
        />

        <FilterSelect name="assignee" label="Assignee" value={filters.assigneeId} anyLabel="Anyone">
          {workspace.members.map((member) => (
            <option key={member.id} value={member.id}>
              {member.name}
            </option>
          ))}
        </FilterSelect>

        {workspace.labels.length > 0 ? (
          <FilterSelect name="label" label="Label" value={filters.labelId} anyLabel="Any label">
            {workspace.labels.map((label) => (
              <option key={label.id} value={label.id}>
                {label.name}
              </option>
            ))}
          </FilterSelect>
        ) : null}

        {workspace.boards.length > 0 ? (
          <FilterSelect name="board" label="Board" value={filters.boardId} anyLabel="Any board">
            {workspace.boards.map((board) => (
              <option key={board.id} value={board.id}>
                {board.name}
              </option>
            ))}
          </FilterSelect>
        ) : null}

        <FilterSelect name="priority" label="Priority" value={filters.priority} anyLabel="Any priority">
          {PRIORITY_ORDER.map((priority) => (
            <option key={priority} value={priority}>
              {PRIORITY_LABEL[priority]}
            </option>
          ))}
        </FilterSelect>

        <button
          type="submit"
          className="h-8 rounded-lg border border-secondary px-2.5 text-[0.8125rem] text-primary transition-colors hover:bg-secondary"
        >
          Apply
        </button>

        {hasActiveFilter(filters) ? (
          <Link
            href={`${base}?tab=${filters.tab}`}
            className="h-8 rounded-lg px-2 text-[0.8125rem] leading-8 text-tertiary no-underline hover:text-primary"
          >
            Clear
          </Link>
        ) : null}
      </form>

      {/* Outside the filter form on purpose: a form inside a form is invalid
          HTML, and the browser silently drops the inner one. */}
      {hasActiveFilter(filters) ? (
        <SaveViewForm
          projectId={ctx.project.id}
          query={withFilter(filters, {}).replace(/^\?/, '')}
        />
      ) : null}

      <IssueListView
        groups={groups}
        emptyMessage={
          hasActiveFilter(filters)
            ? 'No issues match those filters.'
            : filters.tab === 'backlog'
              ? 'The backlog is empty.'
              : 'No issues yet. Create one to get started.'
        }
      />

      {truncated ? (
        <p className="text-xs text-tertiary">
          Showing the first 500 issues. Narrow the filters to see the rest.
        </p>
      ) : null}
    </div>
  );
}

/**
 * One filter dropdown. Submits with the form rather than on change, so the page
 * navigates once after several choices instead of once per choice.
 */
function FilterSelect({
  name,
  label,
  value,
  anyLabel,
  children,
}: {
  name: string;
  label: string;
  value: string | null;
  anyLabel: string;
  children: React.ReactNode;
}) {
  return (
    <select
      name={name}
      defaultValue={value ?? ''}
      aria-label={label}
      className="h-8 rounded-lg border border-secondary bg-primary px-2 text-[0.8125rem] text-primary focus:outline-2 focus:outline-offset-1 focus:outline-focus-ring"
    >
      <option value="">{anyLabel}</option>
      {children}
    </select>
  );
}
