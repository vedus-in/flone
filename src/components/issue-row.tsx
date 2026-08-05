import Link from 'next/link';
import { Priority, WorkflowStateType } from '@prisma/client';

import { colorClass, PRIORITY_LABEL } from '@/lib/model';
import type { IssueGroup, IssueRow } from '@/lib/issues';
import { cx } from '@/lib/utils/cx';

/**
 * One issue, as a row. The single rendering of an issue in the whole app.
 *
 * The issues list, a cycle's detail and a board-less view all use it, so a
 * label chip or a sub-issue count cannot appear on one screen and go missing on
 * another.
 *
 * Server-safe on purpose: no hooks, no handlers, no `'use client'`. Every piece
 * of state it shows was resolved by the server, including the dates, which are
 * pre-formatted with a fixed locale so the markup React sends and the markup it
 * hydrates against agree on every machine.
 */

/* -------------------------------------------------------------------------- */
/* Icons                                                                       */
/* -------------------------------------------------------------------------- */

/**
 * The status glyph, one per state type.
 *
 * Shape carries the meaning, not just colour: a dashed ring for backlog, an
 * open ring for todo, a half-filled ring for in-flight, a tick for done, a
 * cross for canceled. Someone who cannot separate the hues still reads the row.
 */
export function StateIcon({
  type,
  color,
  className,
}: {
  type: WorkflowStateType;
  color: string;
  className?: string;
}) {
  const tone = colorClass(color).text;
  const common = { viewBox: '0 0 14 14', fill: 'none', 'aria-hidden': true as const };
  const ring = 'currentColor';

  return (
    <svg {...common} className={cx('size-3.5 shrink-0', tone, className)}>
      {type === WorkflowStateType.BACKLOG ? (
        <circle cx="7" cy="7" r="5.5" stroke={ring} strokeWidth="1.5" strokeDasharray="2.2 2" />
      ) : null}

      {type === WorkflowStateType.UNSTARTED ? (
        <circle cx="7" cy="7" r="5.5" stroke={ring} strokeWidth="1.5" />
      ) : null}

      {type === WorkflowStateType.STARTED ? (
        <>
          <circle cx="7" cy="7" r="5.5" stroke={ring} strokeWidth="1.5" />
          {/* A half-filled ring, drawn as a fat dashed arc rather than a path so
              the fraction is trivially adjustable and never leaves a seam. */}
          <circle
            cx="7"
            cy="7"
            r="2.75"
            stroke={ring}
            strokeWidth="5.5"
            strokeDasharray="8.6 17.3"
            transform="rotate(-90 7 7)"
          />
        </>
      ) : null}

      {type === WorkflowStateType.COMPLETED ? (
        <>
          <circle cx="7" cy="7" r="6" fill={ring} />
          <path
            d="M4.4 7.2 6.2 9l3.4-3.6"
            stroke="var(--color-bg-primary, #fff)"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </>
      ) : null}

      {type === WorkflowStateType.CANCELED ? (
        <>
          <circle cx="7" cy="7" r="6" fill={ring} />
          <path
            d="M5 5l4 4M9 5l-4 4"
            stroke="var(--color-bg-primary, #fff)"
            strokeWidth="1.5"
            strokeLinecap="round"
          />
        </>
      ) : null}
    </svg>
  );
}

/**
 * Priority as ascending bars, the way Linear draws it: three bars, lit from the
 * left, so the glyph reads as a level rather than as a colour.
 *
 * Urgent breaks the pattern deliberately -- a filled block, because it is not
 * "one more than high", it is a different kind of thing.
 */
export function PriorityIcon({ priority, className }: { priority: Priority; className?: string }) {
  const label = PRIORITY_LABEL[priority];

  if (priority === Priority.URGENT) {
    return (
      <svg viewBox="0 0 14 14" fill="none" className={cx('size-3.5 shrink-0', className)} role="img" aria-label={label}>
        <rect x="1" y="1" width="12" height="12" rx="3" className="fill-error-solid" />
        <path d="M7 4v4" stroke="#fff" strokeWidth="1.6" strokeLinecap="round" />
        <circle cx="7" cy="10.2" r="0.9" fill="#fff" />
      </svg>
    );
  }

  const lit =
    priority === Priority.HIGH ? 3 : priority === Priority.MEDIUM ? 2 : priority === Priority.LOW ? 1 : 0;

  return (
    <svg viewBox="0 0 14 14" fill="none" className={cx('size-3.5 shrink-0', className)} role="img" aria-label={label}>
      {[0, 1, 2].map((index) => (
        <rect
          key={index}
          x={1.5 + index * 4}
          y={9.5 - index * 3}
          width="2.6"
          height={3 + index * 3}
          rx="0.8"
          className={index < lit ? 'fill-fg-secondary' : 'fill-fg-quaternary/35'}
        />
      ))}
    </svg>
  );
}

/** Sub-issue completion, as a pie plus a count. */
function ProgressPie({ done, total }: { done: number; total: number }) {
  const fraction = total === 0 ? 0 : done / total;
  const circumference = 2 * Math.PI * 2.75;

  return (
    <span
      className="flex shrink-0 items-center gap-1 rounded border border-secondary px-1.5 py-px text-[0.6875rem] text-tertiary tabular-nums"
      title={`${done} of ${total} sub-issues done`}
    >
      <svg viewBox="0 0 14 14" fill="none" aria-hidden="true" className="size-3">
        <circle cx="7" cy="7" r="5.5" stroke="currentColor" strokeWidth="1.5" opacity="0.4" />
        <circle
          cx="7"
          cy="7"
          r="2.75"
          stroke="currentColor"
          strokeWidth="5.5"
          strokeDasharray={`${circumference * fraction} ${circumference}`}
          transform="rotate(-90 7 7)"
        />
      </svg>
      {done}/{total}
    </span>
  );
}

/* -------------------------------------------------------------------------- */
/* Chips                                                                       */
/* -------------------------------------------------------------------------- */

function Chip({
  color,
  children,
  title,
}: {
  color: string;
  children: React.ReactNode;
  title?: string;
}) {
  return (
    <span
      title={title}
      className="flex shrink-0 items-center gap-1.5 rounded-full border border-secondary px-2 py-px text-[0.6875rem] text-tertiary"
    >
      <span aria-hidden="true" className={cx('size-1.5 rounded-full', colorClass(color).dot)} />
      <span className="max-w-32 truncate">{children}</span>
    </span>
  );
}

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  // Array.from, not indexing: a name may begin with an astral character and
  // name[0] would slice a surrogate pair in half.
  const first = Array.from(parts[0])[0] ?? '';
  const last = parts.length > 1 ? (Array.from(parts[parts.length - 1])[0] ?? '') : '';
  return (first + last).toLocaleUpperCase();
}

export function Assignee({ name }: { name: string | null }) {
  if (!name) {
    return (
      <span
        aria-label="Unassigned"
        title="Unassigned"
        className="grid size-5 shrink-0 place-items-center rounded-full border border-dashed border-secondary text-[0.5625rem] text-tertiary"
      >
        &ndash;
      </span>
    );
  }
  return (
    <span
      title={name}
      aria-label={`Assigned to ${name}`}
      className="grid size-5 shrink-0 place-items-center rounded-full bg-secondary text-[0.5625rem] font-medium text-tertiary"
    >
      {initials(name)}
    </span>
  );
}

/* -------------------------------------------------------------------------- */
/* Row                                                                         */
/* -------------------------------------------------------------------------- */

/**
 * The row is a grid, not a flex line: the id column is fixed-width so every
 * identifier lines up down the page, and only the title track is allowed to
 * shrink. A flex row lets a long title push the metadata around and the eye
 * loses the column.
 */
export function IssueRowView({ row, action }: { row: IssueRow; action?: React.ReactNode }) {
  return (
    <div className="group flex items-center gap-2 border-b border-secondary px-3 py-2 last:border-b-0 hover:bg-secondary/60">
      <PriorityIcon priority={row.priority} />

      <span className="w-20 shrink-0 truncate font-mono text-[0.6875rem] text-tertiary tabular-nums">
        {row.label}
      </span>

      <StateIcon type={row.state.type} color={row.state.color} />

      <Link
        href={row.href}
        className="min-w-0 flex-1 truncate text-[0.8125rem] text-primary no-underline hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring"
      >
        {row.title}
      </Link>

      {row.parent ? (
        <Link
          href={row.parent.href}
          title={row.parent.title}
          className="hidden max-w-56 shrink-0 items-center gap-1 truncate text-[0.6875rem] text-tertiary no-underline hover:text-primary hover:underline lg:flex"
        >
          <svg viewBox="0 0 16 16" fill="none" aria-hidden="true" className="size-3 opacity-60">
            <path d="M6 3.5 10.5 8 6 12.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
          </svg>
          <span className="truncate">{row.parent.title}</span>
        </Link>
      ) : null}

      {row.childProgress ? (
        <ProgressPie done={row.childProgress.done} total={row.childProgress.total} />
      ) : null}

      <div className="hidden shrink-0 items-center gap-1 md:flex">
        {row.labels.slice(0, 3).map((label) => (
          <Chip key={label.id} color={label.color}>
            {label.name}
          </Chip>
        ))}
        {row.labels.length > 3 ? (
          <span className="text-[0.6875rem] text-tertiary">+{row.labels.length - 3}</span>
        ) : null}
      </div>

      {row.board ? (
        <Link href={row.board.href} className="hidden no-underline md:block">
          <Chip color={row.board.color} title={row.board.name}>
            {row.board.name}
          </Chip>
        </Link>
      ) : null}

      {row.cycleNumber !== null ? (
        <span
          title={`Cycle ${row.cycleNumber}`}
          className="hidden shrink-0 items-center gap-1 text-[0.6875rem] text-tertiary tabular-nums lg:flex"
        >
          <svg viewBox="0 0 14 14" fill="none" aria-hidden="true" className="size-3">
            <circle cx="7" cy="7" r="5.5" stroke="currentColor" strokeWidth="1.5" />
            <path d="M7 4v3.2L9 8.6" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
          </svg>
          {row.cycleNumber}
        </span>
      ) : null}

      {row.commentCount > 0 ? (
        <span className="hidden shrink-0 items-center gap-1 text-[0.6875rem] text-tertiary tabular-nums sm:flex">
          <svg viewBox="0 0 16 16" fill="none" aria-hidden="true" className="size-3">
            <path
              d="M14 9.5a2 2 0 0 1-2 2H5.5L2 14V4a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2z"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinejoin="round"
            />
          </svg>
          {row.commentCount}
        </span>
      ) : null}

      {row.dueDateLabel ? (
        <span
          className={cx(
            'hidden shrink-0 text-[0.6875rem] tabular-nums sm:block',
            row.overdue ? 'font-medium text-error-primary' : 'text-tertiary',
          )}
          title={row.overdue ? 'Overdue' : 'Due date'}
        >
          {row.dueDateLabel}
        </span>
      ) : null}

      <span className="hidden w-12 shrink-0 text-right text-[0.6875rem] text-tertiary tabular-nums sm:block">
        {row.updatedLabel}
      </span>

      <Assignee name={row.assigneeName} />

      {action}
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Grouped list                                                                */
/* -------------------------------------------------------------------------- */

/**
 * A state group. `<details>` rather than React state: collapsing a group is
 * exactly what the element is for, it works before hydration, and it keeps this
 * whole file a Server Component.
 */
export function IssueGroupView({
  group,
  action,
  renderAction,
}: {
  group: IssueGroup;
  /** Rendered in the group header, e.g. a "new issue in this state" button. */
  action?: React.ReactNode;
  renderAction?: (row: IssueRow) => React.ReactNode;
}) {
  return (
    <details open className="group/details">
      <summary className="flex cursor-pointer list-none items-center gap-2 border-b border-secondary bg-secondary/40 px-3 py-1.5">
        <svg
          viewBox="0 0 16 16"
          fill="none"
          aria-hidden="true"
          className="size-3 text-tertiary transition-transform group-open/details:rotate-90"
        >
          <path d="M6 3.5 10.5 8 6 12.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
        </svg>
        <StateIcon type={group.state.type} color={group.state.color} />
        <span className="text-[0.8125rem] font-medium text-primary">{group.state.name}</span>
        <span className="text-[0.6875rem] text-tertiary tabular-nums">{group.issues.length}</span>
        <span className="ms-auto">{action}</span>
      </summary>
      <div>
        {group.issues.map((row) => (
          <IssueRowView key={row.id} row={row} action={renderAction?.(row)} />
        ))}
      </div>
    </details>
  );
}

export function IssueListView({
  groups,
  emptyMessage = 'Nothing here.',
  renderAction,
}: {
  groups: IssueGroup[];
  emptyMessage?: string;
  renderAction?: (row: IssueRow) => React.ReactNode;
}) {
  if (groups.length === 0) {
    return (
      <div className="rounded-xl border border-secondary px-4 py-10 text-center text-sm text-tertiary">
        {emptyMessage}
      </div>
    );
  }

  return (
    <div className="overflow-hidden rounded-xl border border-secondary">
      {groups.map((group) => (
        <IssueGroupView key={group.state.id} group={group} renderAction={renderAction} />
      ))}
    </div>
  );
}
