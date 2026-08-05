import { Priority, WorkflowStateType } from '@prisma/client';

/**
 * The vocabulary of the issue model: what a state type MEANS, how states are
 * ordered, what each tab admits, and the closed colour palette.
 *
 * Deliberately NOT `server-only` and deliberately free of path aliases: the
 * board and the issue list are client modules that need the same ordering the
 * server queried with, and `scripts/check-model.ts` imports it straight from
 * Node. `@prisma/client` is the only import, and only for the enums.
 *
 * `validation.ts` re-exports everything here, so server call sites keep their
 * single import site.
 */

/* -------------------------------------------------------------------------- */
/* Workflow states                                                             */
/* -------------------------------------------------------------------------- */

/**
 * The workflow states a new project is seeded with.
 *
 * `position` is the BOARD order: backlog on the left, canceled on the right.
 * The issue list groups in a different order -- see `STATE_GROUP_RANK` -- so a
 * kanban and a list each read naturally from one stored order.
 */
export const DEFAULT_STATES = [
  { name: 'Backlog', type: WorkflowStateType.BACKLOG, color: 'gray', position: 0 },
  { name: 'Todo', type: WorkflowStateType.UNSTARTED, color: 'gray', position: 1 },
  { name: 'In Progress', type: WorkflowStateType.STARTED, color: 'warning', position: 2 },
  { name: 'In Review', type: WorkflowStateType.STARTED, color: 'brand', position: 3 },
  { name: 'Done', type: WorkflowStateType.COMPLETED, color: 'success', position: 4 },
  { name: 'Canceled', type: WorkflowStateType.CANCELED, color: 'gray', position: 5 },
] as const;

/**
 * Group order for the ISSUE LIST, which is not the board order.
 *
 * Work in flight goes at the top and the backlog at the bottom, so a list you
 * open every morning starts with what is moving. Lower sorts first.
 */
export const STATE_GROUP_RANK: Record<WorkflowStateType, number> = {
  [WorkflowStateType.STARTED]: 0,
  [WorkflowStateType.UNSTARTED]: 1,
  [WorkflowStateType.BACKLOG]: 2,
  [WorkflowStateType.COMPLETED]: 3,
  [WorkflowStateType.CANCELED]: 4,
};

/**
 * Which state types each tab of the issues list admits.
 *
 * This is the ONLY definition of what "active" means. Anything that needs to
 * ask reads it from here rather than re-listing the enum, so a sixth state type
 * can never quietly fall out of every tab.
 */
export const ISSUE_TABS = ['active', 'backlog', 'all'] as const;
export type IssueTab = (typeof ISSUE_TABS)[number];

export const TAB_STATE_TYPES: Record<IssueTab, readonly WorkflowStateType[]> = {
  active: [WorkflowStateType.UNSTARTED, WorkflowStateType.STARTED],
  backlog: [WorkflowStateType.BACKLOG],
  all: Object.values(WorkflowStateType),
};

export const TAB_LABEL: Record<IssueTab, string> = {
  active: 'Active',
  backlog: 'Backlog',
  all: 'All issues',
};

/**
 * A state of this type means the work is FINISHED.
 *
 * CANCELED is deliberately absent: a canceled issue leaves the scope rather
 * than completing it, so it must not inflate a burndown or a sub-issue count.
 */
export function isDone(type: WorkflowStateType): boolean {
  return type === WorkflowStateType.COMPLETED;
}

/** Neither open nor completed -- it left the scope. */
export function isAbandoned(type: WorkflowStateType): boolean {
  return type === WorkflowStateType.CANCELED;
}

/** Still counts as outstanding work: what a cycle rolls forward when it ends. */
export function isOpen(type: WorkflowStateType): boolean {
  return !isDone(type) && !isAbandoned(type);
}

/**
 * The migration's name -> type inference, in TypeScript.
 *
 * The SQL in `20260805000000_linear_project_workspace` has to duplicate this
 * because it runs before any application code exists. `check-model` asserts the
 * two agree on a table of names, which is the only thing that stops them
 * drifting the next time someone adds a synonym here.
 *
 * Anything unrecognised is STARTED, which is the safe guess: it keeps the issue
 * under the Active tab rather than hiding it in a backlog nobody reads.
 */
export function inferStateType(name: string): WorkflowStateType {
  const value = name.toLowerCase().trim();
  if (value.includes('backlog')) return WorkflowStateType.BACKLOG;
  if (value.startsWith('cancel') || value.includes('duplicate') || /^won.*t\s/.test(value)) {
    return WorkflowStateType.CANCELED;
  }
  if (
    value.includes('done') ||
    value.includes('complete') ||
    value.includes('closed') ||
    value.includes('shipped')
  ) {
    return WorkflowStateType.COMPLETED;
  }
  if (['to do', 'todo', 'open', 'new', 'triage', 'unstarted'].includes(value)) {
    return WorkflowStateType.UNSTARTED;
  }
  return WorkflowStateType.STARTED;
}

/**
 * What a transition into `type` does to an issue's lifecycle stamps.
 *
 * Depends only on the NEW type and the stamps already on the row, so it never
 * needs to know where the issue came from:
 *   - COMPLETED  stamps `completedAt` once. Re-entering Done does not reset it,
 *     so a cycle burndown does not jump when somebody toggles a state twice.
 *   - STARTED    stamps `startedAt` once and clears `completedAt` -- reopened
 *     work is genuinely not complete any more.
 *   - CANCELED   keeps `startedAt` (it really was started) and clears
 *     `completedAt`, because cancelling is not completing.
 *   - BACKLOG / UNSTARTED clear both: the work is back to not having begun.
 *
 * Lives here rather than beside the actions that call it because every export
 * of a `'use server'` module must be an async Server Action, and this is a pure
 * function -- which also makes it something `check-model` can actually test.
 */
export function stampsFor(
  type: WorkflowStateType,
  current: { startedAt: Date | null; completedAt: Date | null },
  now: Date = new Date(),
): { startedAt: Date | null; completedAt: Date | null } {
  if (isDone(type)) {
    return { startedAt: current.startedAt ?? now, completedAt: current.completedAt ?? now };
  }
  if (type === WorkflowStateType.STARTED) {
    return { startedAt: current.startedAt ?? now, completedAt: null };
  }
  if (type === WorkflowStateType.CANCELED) {
    return { startedAt: current.startedAt, completedAt: null };
  }
  return { startedAt: null, completedAt: null };
}

/* -------------------------------------------------------------------------- */
/* Priority                                                                    */
/* -------------------------------------------------------------------------- */

/** Most urgent first, which is the order every list sorts and every menu shows. */
export const PRIORITY_ORDER = [
  Priority.URGENT,
  Priority.HIGH,
  Priority.MEDIUM,
  Priority.LOW,
  Priority.NONE,
] as const;

export const PRIORITY_LABEL: Record<Priority, string> = {
  [Priority.URGENT]: 'Urgent',
  [Priority.HIGH]: 'High',
  [Priority.MEDIUM]: 'Medium',
  [Priority.LOW]: 'Low',
  [Priority.NONE]: 'No priority',
};

/* -------------------------------------------------------------------------- */
/* Colour                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * A closed palette of TOKEN names, never raw hex. A rebrand retints every badge
 * by editing one map in the UI instead of rewriting rows.
 */
export const COLOR_TOKENS = ['gray', 'brand', 'success', 'warning', 'error', 'purple', 'pink'] as const;
export type ColorToken = (typeof COLOR_TOKENS)[number];

export function isColorToken(value: string): value is ColorToken {
  return (COLOR_TOKENS as readonly string[]).includes(value);
}

/**
 * Token -> Tailwind classes. Written as whole class strings rather than
 * interpolated fragments because Tailwind scans source text: `bg-${token}-500`
 * would be compiled away to nothing.
 */
export const COLOR_CLASS: Record<ColorToken, { dot: string; text: string; chip: string }> = {
  gray: { dot: 'bg-fg-quaternary', text: 'text-tertiary', chip: 'bg-secondary text-tertiary' },
  brand: { dot: 'bg-brand-solid', text: 'text-brand-secondary', chip: 'bg-brand-primary text-brand-secondary' },
  success: { dot: 'bg-success-solid', text: 'text-success-primary', chip: 'bg-success-primary text-success-primary' },
  warning: { dot: 'bg-warning-solid', text: 'text-warning-primary', chip: 'bg-warning-primary text-warning-primary' },
  error: { dot: 'bg-error-solid', text: 'text-error-primary', chip: 'bg-error-primary text-error-primary' },
  purple: { dot: 'bg-utility-purple-500', text: 'text-utility-purple-700', chip: 'bg-utility-purple-50 text-utility-purple-700' },
  pink: { dot: 'bg-utility-pink-500', text: 'text-utility-pink-700', chip: 'bg-utility-pink-50 text-utility-pink-700' },
};

export function colorClass(token: string): { dot: string; text: string; chip: string } {
  return COLOR_CLASS[isColorToken(token) ? token : 'gray'];
}

/* -------------------------------------------------------------------------- */
/* Sorting                                                                     */
/* -------------------------------------------------------------------------- */

export type GroupableState = { id: string; name: string; type: WorkflowStateType; position: number };

/**
 * Sort states into the order the ISSUE LIST groups them: by type rank, then by
 * the project's own position within a rank, then by id so the result is total.
 */
export function sortStatesForList<T extends GroupableState>(states: readonly T[]): T[] {
  return [...states].sort(
    (a, b) =>
      STATE_GROUP_RANK[a.type] - STATE_GROUP_RANK[b.type] ||
      a.position - b.position ||
      (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  );
}

/** Sort states into BOARD order: the project's stored position, left to right. */
export function sortStatesForBoard<T extends GroupableState>(states: readonly T[]): T[] {
  return [...states].sort(
    (a, b) => a.position - b.position || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  );
}
