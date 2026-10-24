import 'server-only';

import { Priority, Prisma, type WorkflowStateType } from '@prisma/client';

import { prisma } from '@/lib/db';
import { boardPath, ticketPath, visibleProject, type OrgRef, type ProjectRef } from '@/lib/authz';
import { isDone, sortStatesForList, STATE_GROUP_RANK, type IssueTab } from '@/lib/model';
import { TAB_STATE_TYPES, TICKET_ORDER } from '@/lib/validation';

/**
 * The one place an issue is read and shaped for display.
 *
 * The issues list, a cycle's detail, a board's page and the project overview all
 * render the same row, so they all come through here. Four hand-rolled selects
 * would drift, and the first symptom of the drift would be a label chip that
 * shows up on one screen and not another.
 *
 * Every query is rooted at a `projectId` that came from an authorized upward
 * walk, and repeats the membership predicate besides, so each is safe on its own
 * terms rather than on its caller's good behaviour.
 */

/* -------------------------------------------------------------------------- */
/* Filters                                                                     */
/* -------------------------------------------------------------------------- */

export type IssueFilters = {
  tab: IssueTab;
  assigneeId: string | null;
  labelId: string | null;
  boardId: string | null;
  cycleId: string | null;
  priority: Priority | null;
  query: string | null;
};

const TABS = new Set<string>(['active', 'backlog', 'all']);

/**
 * Read filters out of the URL.
 *
 * The query string IS the filter state -- that is what makes every view
 * shareable, bookmarkable and correct under back/forward with no client state
 * at all, and what lets a saved view be nothing more than a stored query string.
 *
 * Anything unrecognised is dropped rather than rejected. A filter is not a
 * command; a stale link with a deleted label id should show the unfiltered list,
 * not a 400.
 */
export function parseIssueFilters(
  params: Record<string, string | string[] | undefined>,
  fallbackTab: IssueTab = 'active',
): IssueFilters {
  const one = (key: string): string | null => {
    const value = params[key];
    const raw = Array.isArray(value) ? value[0] : value;
    return typeof raw === 'string' && raw.length > 0 && raw.length <= 200 ? raw : null;
  };

  const tab = one('tab');
  const priority = one('priority');

  return {
    tab: tab && TABS.has(tab) ? (tab as IssueTab) : fallbackTab,
    assigneeId: one('assignee'),
    labelId: one('label'),
    boardId: one('board'),
    cycleId: one('cycle'),
    priority:
      priority && priority in Priority ? Priority[priority as keyof typeof Priority] : null,
    query: one('q'),
  };
}

/** Rebuild a query string with one filter changed. Empty values drop the key. */
export function withFilter(
  current: IssueFilters,
  patch: Partial<Record<string, string | null>>,
): string {
  const params = new URLSearchParams();
  const base: Record<string, string | null> = {
    tab: current.tab,
    assignee: current.assigneeId,
    label: current.labelId,
    board: current.boardId,
    cycle: current.cycleId,
    priority: current.priority,
    q: current.query,
  };
  for (const [key, value] of Object.entries({ ...base, ...patch })) {
    if (value) params.set(key, value);
  }
  const query = params.toString();
  return query.length > 0 ? `?${query}` : '';
}

export function hasActiveFilter(filters: IssueFilters): boolean {
  return Boolean(
    filters.assigneeId ||
      filters.labelId ||
      filters.boardId ||
      filters.cycleId ||
      filters.priority ||
      filters.query,
  );
}

/* -------------------------------------------------------------------------- */
/* Row shape                                                                   */
/* -------------------------------------------------------------------------- */

export type IssueChip = { id: string; name: string; color: string };

export type IssueRow = {
  id: string;
  number: number;
  label: string;
  title: string;
  href: string;
  priority: Priority;
  state: { id: string; name: string; type: WorkflowStateType; color: string };
  board: (IssueChip & { href: string }) | null;
  cycleNumber: number | null;
  labels: IssueChip[];
  assigneeName: string | null;
  parent: { number: number; title: string; href: string } | null;
  /** Null unless the issue actually has sub-issues. */
  childProgress: { done: number; total: number } | null;
  commentCount: number;
  dueDateLabel: string | null;
  overdue: boolean;
  updatedLabel: string;
  /** Author-or-privileged, computed on the SERVER. Presentation only. */
  canDelete: boolean;
};

export type IssueGroup = {
  state: { id: string; name: string; type: WorkflowStateType; color: string };
  issues: IssueRow[];
};

/* -------------------------------------------------------------------------- */
/* Formatting                                                                  */
/*                                                                             */
/* Fixed locale and UTC, on the server, so the markup React sends and the       */
/* markup it hydrates against agree on every machine.                           */
/* -------------------------------------------------------------------------- */

const DAY = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });

export function formatDay(value: Date): string {
  return DAY.format(value);
}

/* -------------------------------------------------------------------------- */
/* Query                                                                       */
/* -------------------------------------------------------------------------- */

type LoadOptions = {
  filters: IssueFilters;
  /** Extra constraint from the route itself -- a cycle page, a board page. */
  scope?: Prisma.TicketWhereInput;
  /** Hard cap. A list that renders 20 000 rows is not a list. */
  take?: number;
};

export type LoadedIssues = {
  groups: IssueGroup[];
  total: number;
  /** True when the cap trimmed the result, so the UI can say so. */
  truncated: boolean;
};

const DEFAULT_TAKE = 500;

/**
 * Load a project's issues, grouped by workflow state in LIST order.
 *
 * The tab is applied as a state-type constraint rather than a post-filter, so
 * the database does the work and the `take` cap counts rows the user will
 * actually see.
 */
export async function loadIssues(
  ctx: { user: { id: string }; org: OrgRef; project: ProjectRef; role: string },
  options: LoadOptions,
): Promise<LoadedIssues> {
  const { filters, scope, take = DEFAULT_TAKE } = options;
  const projectId = ctx.project.id;

  const states = await prisma.workflowState.findMany({
    where: {
      projectId,
      type: { in: [...TAB_STATE_TYPES[filters.tab]] },
      project: visibleProject(ctx.user.id),
    },
    select: { id: true, name: true, type: true, color: true, position: true },
  });
  if (states.length === 0) return { groups: [], total: 0, truncated: false };

  const stateIds = states.map((state) => state.id);

  const where: Prisma.TicketWhereInput = {
    projectId,
    stateId: { in: stateIds },
    // Repeated even though `projectId` came from an authorized walk: this query
    // is safe on its own terms, not on its caller's.
    project: visibleProject(ctx.user.id),
    ...(filters.assigneeId ? { assigneeId: filters.assigneeId } : {}),
    ...(filters.labelId ? { labels: { some: { id: filters.labelId } } } : {}),
    ...(filters.boardId ? { boardId: filters.boardId } : {}),
    ...(filters.cycleId ? { cycleId: filters.cycleId } : {}),
    ...(filters.priority ? { priority: filters.priority } : {}),
    ...(filters.query
      ? // `mode: 'insensitive'` on a plain contains: this is a filter box, not
        // full-text search, and a trigram index is not worth carrying for it.
        { title: { contains: filters.query, mode: Prisma.QueryMode.insensitive } }
      : {}),
    ...scope,
  };

  const [rows, total] = await Promise.all([
    prisma.ticket.findMany({
      where,
      orderBy: TICKET_ORDER,
      take: take + 1,
      select: {
        id: true,
        number: true,
        title: true,
        priority: true,
        dueDate: true,
        updatedAt: true,
        createdById: true,
        stateId: true,
        cycleId: true,
        assignee: { select: { name: true } },
        board: { select: { id: true, name: true, color: true } },
        cycle: { select: { number: true } },
        labels: {
          orderBy: [{ name: 'asc' }],
          select: { id: true, name: true, color: true },
        },
        parent: { select: { number: true, title: true } },
        _count: { select: { comments: true, children: true } },
      },
    }),
    prisma.ticket.count({ where }),
  ]);

  const truncated = rows.length > take;
  const visible = truncated ? rows.slice(0, take) : rows;

  const childProgress = await loadChildProgress(
    projectId,
    visible.filter((row) => row._count.children > 0).map((row) => row.id),
  );

  const startOfToday = new Date();
  startOfToday.setUTCHours(0, 0, 0, 0);
  const privileged = ctx.role === 'ADMIN' || ctx.role === 'OWNER';

  const byState = new Map<string, IssueRow[]>();
  for (const row of visible) {
    const list = byState.get(row.stateId) ?? [];
    list.push({
      id: row.id,
      number: row.number,
      label: `${ctx.project.key}-${row.number}`,
      title: row.title,
      href: ticketPath(ctx.org, ctx.project, row.number),
      priority: row.priority,
      state: pickState(states, row.stateId),
      board: row.board
        ? {
            id: row.board.id,
            name: row.board.name,
            color: row.board.color,
            href: boardPath(ctx.org, ctx.project, row.board),
          }
        : null,
      cycleNumber: row.cycle?.number ?? null,
      labels: row.labels,
      assigneeName: row.assignee?.name ?? null,
      parent: row.parent
        ? {
            number: row.parent.number,
            title: row.parent.title,
            href: ticketPath(ctx.org, ctx.project, row.parent.number),
          }
        : null,
      childProgress: childProgress.get(row.id) ?? null,
      commentCount: row._count.comments,
      dueDateLabel: row.dueDate ? formatDay(row.dueDate) : null,
      overdue: row.dueDate ? row.dueDate < startOfToday : false,
      updatedLabel: formatDay(row.updatedAt),
      canDelete: privileged || row.createdById === ctx.user.id,
    });
    byState.set(row.stateId, list);
  }

  const groups = sortStatesForList(states)
    .map((state) => ({
      state: { id: state.id, name: state.name, type: state.type, color: state.color },
      issues: byState.get(state.id) ?? [],
    }))
    // An empty state is noise in a filtered list but useful as a drop target on
    // a board, so the board builds its own columns rather than reusing this.
    .filter((group) => group.issues.length > 0);

  return { groups, total, truncated };
}

function pickState(
  states: Array<{ id: string; name: string; type: WorkflowStateType; color: string }>,
  stateId: string,
) {
  const found = states.find((state) => state.id === stateId);
  // Unreachable: the query constrained `stateId` to exactly this set.
  if (!found) throw new Error('state missing from its own constraint');
  return { id: found.id, name: found.name, type: found.type, color: found.color };
}

/**
 * Done / total sub-issue counts for the parents in view.
 *
 * Two grouped counts rather than fetching every child of every row: a list of
 * 500 epics would otherwise pull thousands of children in just to render
 * "13/19".
 */
async function loadChildProgress(
  projectId: string,
  parentIds: string[],
): Promise<Map<string, { done: number; total: number }>> {
  const out = new Map<string, { done: number; total: number }>();
  if (parentIds.length === 0) return out;

  const doneStates = await prisma.workflowState.findMany({
    where: { projectId },
    select: { id: true, type: true },
  });
  const doneIds = doneStates.filter((state) => isDone(state.type)).map((state) => state.id);

  const [totals, dones] = await Promise.all([
    prisma.ticket.groupBy({
      by: ['parentId'],
      where: { projectId, parentId: { in: parentIds } },
      _count: { _all: true },
    }),
    doneIds.length > 0
      ? prisma.ticket.groupBy({
          by: ['parentId'],
          where: { projectId, parentId: { in: parentIds }, stateId: { in: doneIds } },
          _count: { _all: true },
        })
      : Promise.resolve([]),
  ]);

  for (const row of totals) {
    if (row.parentId) out.set(row.parentId, { done: 0, total: row._count._all });
  }
  for (const row of dones) {
    if (!row.parentId) continue;
    const entry = out.get(row.parentId);
    if (entry) entry.done = row._count._all;
  }
  return out;
}

/* -------------------------------------------------------------------------- */
/* Cycle progress                                                              */
/* -------------------------------------------------------------------------- */

export type CycleProgress = {
  scope: number;
  completed: number;
  /** Completion instants inside the cycle, ascending. Drives the burndown. */
  completions: Date[];
};

/**
 * Scope and completions for one cycle.
 *
 * Scope is an ISSUE COUNT, not story points: that is what the screenshots show
 * and estimates are explicitly out of scope. Canceled issues are excluded from
 * both numbers -- they left the scope rather than completing it, so counting
 * them either way would misdraw the chart.
 */
export async function loadCycleProgress(
  projectId: string,
  cycleId: string,
): Promise<CycleProgress> {
  const states = await prisma.workflowState.findMany({
    where: { projectId },
    select: { id: true, type: true },
  });
  const canceledIds = states
    .filter((state) => state.type === 'CANCELED')
    .map((state) => state.id);
  const doneIds = states.filter((state) => isDone(state.type)).map((state) => state.id);

  const inScope: Prisma.TicketWhereInput = {
    projectId,
    cycleId,
    ...(canceledIds.length > 0 ? { stateId: { notIn: canceledIds } } : {}),
  };

  const [scope, completedRows] = await Promise.all([
    prisma.ticket.count({ where: inScope }),
    doneIds.length > 0
      ? prisma.ticket.findMany({
          where: { projectId, cycleId, stateId: { in: doneIds } },
          orderBy: { completedAt: 'asc' },
          select: { completedAt: true, updatedAt: true },
        })
      : Promise.resolve([]),
  ]);

  const completions = completedRows.map((row) => row.completedAt ?? row.updatedAt);

  return { scope, completed: completions.length, completions };
}

/** Group rank, re-exported so a page can order state chips without a second import. */
export { STATE_GROUP_RANK };
