import Link from 'next/link';

import { ComposeInState } from '@/components/compose-in-state';
import { projectCrumb } from '@/components/crumbs';
import { FilterMenu, type FilterGroup } from '@/components/filter-menu';
import { IconClose, IconSearch } from '@/components/icons';
import { IssueListView } from '@/components/issue-row';
import { PageBar, PageToolbar, ViewTab } from '@/components/page-bar';
import { loadPage, issuesPath, requireProjectByKey } from '@/lib/authz';
import { hasActiveFilter, loadIssues, parseIssueFilters, withFilter } from '@/lib/issues';
import { PRIORITY_LABEL, PRIORITY_ORDER, TAB_LABEL, ISSUE_TABS } from '@/lib/model';
import { defaultComposeState } from '@/lib/states';
import { loadWorkspace } from '@/lib/workspace';

import { IssueComposer } from '../issue-composer';
import { RowBoardMenu } from '../row-board-menu';
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

type Params = { orgSlug: string; workspaceSlug: string; projectKey: string };
type Search = Record<string, string | string[] | undefined>;

export default async function IssuesPage({
  params,
  searchParams,
}: {
  params: Promise<Params>;
  searchParams: Promise<Search>;
}) {
  const { orgSlug, workspaceSlug, projectKey } = await params;
  const search = await searchParams;

  const ctx = await loadPage(() => requireProjectByKey(orgSlug, workspaceSlug, projectKey.toUpperCase()));
  const filters = parseIssueFilters(search);
  const workspace = await loadWorkspace(ctx);
  const { groups, total, truncated } = await loadIssues(ctx, { filters });

  const base = issuesPath(ctx.org, ctx.project);
  const composeState = defaultComposeState(workspace.states);

  /** The link that sets one filter -- or clears it, when it is already set. */
  const toggle = (key: string, value: string, active: boolean) =>
    `${base}${withFilter(filters, { [key]: active ? null : value })}`;

  const filterGroups: FilterGroup[] = [
    {
      id: 'assignee',
      label: 'Assignee',
      options: workspace.members.map((member) => ({
        id: `assignee-${member.id}`,
        label: member.name,
        href: toggle('assignee', member.id, filters.assigneeId === member.id),
        active: filters.assigneeId === member.id,
        glyph: { type: 'person', name: member.name },
      })),
    },
    {
      id: 'priority',
      label: 'Priority',
      options: PRIORITY_ORDER.map((priority) => ({
        id: `priority-${priority}`,
        label: PRIORITY_LABEL[priority],
        href: toggle('priority', priority, filters.priority === priority),
        active: filters.priority === priority,
        glyph: { type: 'priority', value: priority },
      })),
    },
    ...(workspace.labels.length > 0
      ? [
          {
            id: 'label',
            label: 'Labels',
            options: workspace.labels.map((label) => ({
              id: `label-${label.id}`,
              label: label.name,
              href: toggle('label', label.id, filters.labelId === label.id),
              active: filters.labelId === label.id,
              glyph: { type: 'dot', color: label.color ?? 'gray' } as const,
            })),
          },
        ]
      : []),
    ...(workspace.boards.length > 0
      ? [
          {
            id: 'board',
            label: 'Board',
            options: workspace.boards.map((board) => ({
              id: `board-${board.id}`,
              label: board.name,
              href: toggle('board', board.id, filters.boardId === board.id),
              active: filters.boardId === board.id,
              glyph: { type: 'square', color: board.color ?? 'gray' } as const,
            })),
          },
        ]
      : []),
    ...(workspace.cycles.length > 0
      ? [
          {
            id: 'cycle',
            label: 'Cycle',
            options: workspace.cycles.map((cycle) => ({
              id: `cycle-${cycle.id}`,
              label: cycle.name ? `Cycle ${cycle.number} — ${cycle.name}` : `Cycle ${cycle.number}`,
              href: toggle('cycle', cycle.id, filters.cycleId === cycle.id),
              active: filters.cycleId === cycle.id,
            })),
          },
        ]
      : []),
  ];

  // The active filters, as removable chips under the toolbar.
  const chips: Array<{ field: string; value: string; clear: string }> = [];
  const member = workspace.members.find((m) => m.id === filters.assigneeId);
  if (member) chips.push({ field: 'Assignee', value: member.name, clear: toggle('assignee', '', true) });
  if (filters.priority) {
    chips.push({ field: 'Priority', value: PRIORITY_LABEL[filters.priority], clear: toggle('priority', '', true) });
  }
  const label = workspace.labels.find((l) => l.id === filters.labelId);
  if (label) chips.push({ field: 'Label', value: label.name, clear: toggle('label', '', true) });
  const board = workspace.boards.find((b) => b.id === filters.boardId);
  if (board) chips.push({ field: 'Board', value: board.name, clear: toggle('board', '', true) });
  const cycle = workspace.cycles.find((c) => c.id === filters.cycleId);
  if (cycle) chips.push({ field: 'Cycle', value: `Cycle ${cycle.number}`, clear: toggle('cycle', '', true) });
  if (filters.query) chips.push({ field: 'Title', value: `“${filters.query}”`, clear: toggle('q', '', true) });

  return (
    <>
      <PageBar
        crumbs={[projectCrumb(ctx.org, ctx.project), { label: 'Issues' }]}
        actions={
          composeState ? (
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
          ) : null
        }
      />

      {/* Tabs. Plain links, so each one is a real URL you can send someone. */}
      <PageToolbar
        actions={
          <>
            {/* A native GET form. No JavaScript, no client state, and the
                resulting URL is the shareable thing the page is built around. */}
            <form method="get" action={base} role="search" className="group/search relative flex items-center">
              {filters.tab ? <input type="hidden" name="tab" value={filters.tab} /> : null}
              {filters.assigneeId ? <input type="hidden" name="assignee" value={filters.assigneeId} /> : null}
              {filters.labelId ? <input type="hidden" name="label" value={filters.labelId} /> : null}
              {filters.boardId ? <input type="hidden" name="board" value={filters.boardId} /> : null}
              {filters.cycleId ? <input type="hidden" name="cycle" value={filters.cycleId} /> : null}
              {filters.priority ? <input type="hidden" name="priority" value={filters.priority} /> : null}
              <IconSearch className="pointer-events-none absolute start-2 size-3.5 text-tertiary" />
              <input
                type="search"
                name="q"
                defaultValue={filters.query ?? ''}
                placeholder="Search…"
                maxLength={200}
                aria-label="Filter by title"
                className="h-7 w-32 rounded-md border border-transparent bg-transparent ps-7 pe-2 text-xs text-primary transition-[width,border-color] placeholder:text-tertiary hover:border-secondary focus:w-52 focus:border-primary focus:outline-none"
              />
            </form>
            <FilterMenu groups={filterGroups} activeCount={chips.length} />
            <span className="px-2 text-xs text-tertiary tabular-nums">
              {total} {total === 1 ? 'issue' : 'issues'}
            </span>
          </>
        }
      >
        <nav aria-label="Issue filter" className="flex items-center gap-1.5">
          {ISSUE_TABS.map((tab) => (
            <ViewTab
              key={tab}
              href={`${base}${withFilter(filters, { tab })}`}
              active={filters.tab === tab}
            >
              {TAB_LABEL[tab]}
            </ViewTab>
          ))}
        </nav>
      </PageToolbar>

      {chips.length > 0 ? (
        <div className="flex flex-wrap items-center gap-1.5 px-2.5 pb-2">
          {chips.map((chip) => (
            <span
              key={chip.field}
              className="flex h-6 items-center overflow-hidden rounded-md border border-secondary text-xs"
            >
              <span className="px-2 text-tertiary">{chip.field}</span>
              <span className="border-s border-secondary px-2 text-tertiary">is</span>
              <span className="border-s border-secondary px-2 font-medium text-primary">{chip.value}</span>
              <Link
                href={chip.clear}
                aria-label={`Remove ${chip.field} filter`}
                className="grid h-full w-6 place-items-center border-s border-secondary text-tertiary no-underline transition-colors hover:bg-secondary hover:text-primary"
              >
                <IconClose className="size-3" />
              </Link>
            </span>
          ))}
          <Link
            href={`${base}?tab=${filters.tab}`}
            className="h-6 rounded-md px-2 text-xs leading-6 text-tertiary no-underline transition-colors hover:bg-secondary hover:text-primary"
          >
            Clear
          </Link>
          <SaveViewForm
            projectId={ctx.project.id}
            query={withFilter(filters, {}).replace(/^\?/, '')}
          />
        </div>
      ) : null}

      <div className="flex flex-col gap-3 pb-6">
        <IssueListView
          groups={groups}
          renderAction={(row) => (
            <RowBoardMenu
              ticketId={row.id}
              issueLabel={row.label}
              boardId={row.board?.id ?? null}
              boards={workspace.boards}
            />
          )}
          renderGroupAction={(group) => (
            <ComposeInState stateId={group.state.id} stateName={group.state.name} />
          )}
          emptyMessage={
            hasActiveFilter(filters)
              ? 'No issues match those filters.'
              : filters.tab === 'backlog'
                ? 'The backlog is empty.'
                : 'No issues yet. Create one to get started.'
          }
        />

        {truncated ? (
          <p className="px-4.5 text-xs text-tertiary">
            Showing the first 500 issues. Narrow the filters to see the rest.
          </p>
        ) : null}
      </div>
    </>
  );
}
