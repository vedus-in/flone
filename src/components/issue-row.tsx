import Link from 'next/link';
import { Priority, WorkflowStateType } from '@prisma/client';

import { IconCalendar, IconChevronRight, IconComment, IconCycle } from '@/components/icons';
import { colorClass, isColorToken, PRIORITY_LABEL } from '@/lib/model';
import type { IssueGroup, IssueRow } from '@/lib/issues';
import { cx } from '@/lib/utils/cx';

import { IssueListKeys } from './issue-list-keys';

/**
 * One issue, as a row. The single rendering of an issue in the whole app.
 *
 * The issues list, a cycle's detail and a board-less view all use it, so a
 * label chip or a sub-issue count cannot appear on one screen and go missing on
 * another.
 *
 * Laid out the way Linear's list is: priority, key and status on a fixed grid
 * at the left so every column lines up down the page, the title taking the
 * slack, and the property chips, assignee and date pinned right. The whole row
 * is the link -- the title's `::after` covers it -- and anything interactive on
 * top of it sits on `z-10`.
 *
 * Server-safe on purpose: no hooks, no handlers, no `'use client'`. Every piece
 * of state it shows was resolved by the server, including the dates, which are
 * pre-formatted with a fixed locale so the markup React sends and the markup it
 * hydrates against agree on every machine.
 */

/* -------------------------------------------------------------------------- */
/* Icons                                                                       */
/* -------------------------------------------------------------------------- */

/** A pie wedge from 12 o'clock, clockwise, as a path -- no seams at any angle. */
function wedge(fraction: number, r: number): string {
  if (fraction >= 1) return `M7 ${7 - r}a${r} ${r} 0 1 1 0 ${2 * r}a${r} ${r} 0 1 1 0 ${-2 * r}Z`;
  const angle = 2 * Math.PI * fraction;
  const x = 7 + r * Math.sin(angle);
  const y = 7 - r * Math.cos(angle);
  const large = fraction > 0.5 ? 1 : 0;
  return `M7 7V${7 - r}A${r} ${r} 0 ${large} 1 ${x.toFixed(3)} ${y.toFixed(3)}Z`;
}

/**
 * The status glyph, one per state type.
 *
 * Shape carries the meaning, not just colour: a dotted ring for backlog, an
 * open ring for todo, a ring filling up for in-flight work, a tick for done, a
 * cross for canceled. Someone who cannot separate the hues still reads the row.
 *
 * `fraction` is how full an in-flight ring is drawn; Linear fills it further
 * for states later in the workflow (half for In Progress, three quarters for
 * In Review).
 */
export function StateIcon({
  type,
  color,
  fraction = 0.5,
  className,
}: {
  type: WorkflowStateType;
  color: string;
  fraction?: number;
  className?: string;
}) {
  // Todo reads as a light ring in Linear rather than the backlog grey.
  const tone =
    type === WorkflowStateType.UNSTARTED && (color === 'gray' || !isColorToken(color))
      ? 'text-status-todo'
      : colorClass(color).text;
  const common = { viewBox: '0 0 14 14', fill: 'none', 'aria-hidden': true as const };

  return (
    <svg {...common} className={cx('size-3.5 shrink-0', tone, className)}>
      {type === WorkflowStateType.BACKLOG ? (
        <circle
          cx="7"
          cy="7"
          r="6"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeDasharray="1.4 1.74"
          strokeDashoffset="0.7"
        />
      ) : null}

      {type === WorkflowStateType.UNSTARTED ? (
        <circle cx="7" cy="7" r="6" stroke="currentColor" strokeWidth="1.5" />
      ) : null}

      {type === WorkflowStateType.STARTED ? (
        <>
          <circle cx="7" cy="7" r="6" stroke="currentColor" strokeWidth="1.5" />
          <path d={wedge(Math.min(Math.max(fraction, 0.05), 1), 3.25)} fill="currentColor" />
        </>
      ) : null}

      {type === WorkflowStateType.COMPLETED ? (
        <>
          <circle cx="7" cy="7" r="7" fill="currentColor" />
          <path
            d="M4.25 7.25 6.1 9.1 9.75 5.25"
            stroke="var(--color-bg-primary, #fff)"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </>
      ) : null}

      {type === WorkflowStateType.CANCELED ? (
        <>
          <circle cx="7" cy="7" r="7" fill="currentColor" />
          <path
            d="m4.9 4.9 4.2 4.2M9.1 4.9 4.9 9.1"
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
 * left, so the glyph reads as a level rather than as a colour. No priority is
 * three flat dashes.
 *
 * Urgent breaks the pattern deliberately -- a filled orange tile, because it is
 * not "one more than high", it is a different kind of thing.
 */
export function PriorityIcon({ priority, className }: { priority: Priority; className?: string }) {
  const label = PRIORITY_LABEL[priority];

  if (priority === Priority.URGENT) {
    return (
      <svg viewBox="0 0 16 16" fill="none" className={cx('size-4 shrink-0', className)} role="img" aria-label={label}>
        <rect x="1.5" y="1.5" width="13" height="13" rx="3" className="fill-status-urgent" />
        <path d="M8 4.5v4.25" stroke="#fff" strokeWidth="1.75" strokeLinecap="round" />
        <circle cx="8" cy="11.25" r="1" fill="#fff" />
      </svg>
    );
  }

  if (priority === Priority.NONE) {
    return (
      <svg viewBox="0 0 16 16" fill="none" className={cx('size-4 shrink-0 text-fg-quaternary', className)} role="img" aria-label={label}>
        {[2.5, 6.75, 11].map((x) => (
          <rect key={x} x={x} y="7.25" width="2.5" height="1.5" rx="0.75" fill="currentColor" />
        ))}
      </svg>
    );
  }

  const lit = priority === Priority.HIGH ? 3 : priority === Priority.MEDIUM ? 2 : 1;

  return (
    <svg viewBox="0 0 16 16" fill="none" className={cx('size-4 shrink-0', className)} role="img" aria-label={label}>
      {[0, 1, 2].map((index) => (
        <rect
          key={index}
          x={2 + index * 4.5}
          y={10 - index * 3.5}
          width="3"
          height={4 + index * 3.5}
          rx="1"
          className={index < lit ? 'fill-fg-secondary' : 'fill-fg-quaternary/40'}
        />
      ))}
    </svg>
  );
}

/** Sub-issue completion, as a ring filling up plus a count. */
function ProgressPie({ done, total }: { done: number; total: number }) {
  const fraction = total === 0 ? 0 : done / total;

  return (
    <span className={CHIP} title={`${done} of ${total} sub-issues done`}>
      <svg viewBox="0 0 14 14" fill="none" aria-hidden="true" className="size-3.5 text-tertiary">
        <circle cx="7" cy="7" r="6" stroke="currentColor" strokeWidth="1.5" opacity="0.5" />
        {fraction > 0 ? <path d={wedge(fraction, 3.25)} fill="currentColor" /> : null}
      </svg>
      <span className="tabular-nums">
        {done}/{total}
      </span>
    </span>
  );
}

/* -------------------------------------------------------------------------- */
/* Chips                                                                       */
/* -------------------------------------------------------------------------- */

/** The pill every property on a row or a card is drawn as. */
export const CHIP =
  'relative z-10 flex h-[22px] max-w-40 shrink-0 items-center gap-1.5 rounded-full border border-secondary px-2 text-xs text-tertiary';

export function Chip({
  color,
  children,
  title,
}: {
  color: string;
  children: React.ReactNode;
  title?: string;
}) {
  return (
    <span title={title} className={CHIP}>
      <span aria-hidden="true" className={cx('size-2 shrink-0 rounded-full', colorClass(color).dot)} />
      <span className="truncate">{children}</span>
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

/** Fixed avatar hues, picked by name so a person keeps their colour. */
const AVATAR_COLORS = ['#5e6ad2', '#26b5ce', '#4cb782', '#f2994a', '#eb5757', '#bb87fc', '#e2a03f', '#4ea7fc'];

function avatarColor(name: string): string {
  let hash = 0;
  for (const char of name) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return AVATAR_COLORS[hash % AVATAR_COLORS.length];
}

/**
 * A person, as Linear draws one: a small coloured disc with initials, or a
 * dashed ring with a figure in it when nobody is assigned.
 */
export function Assignee({
  name,
  size = 'sm',
}: {
  name: string | null;
  size?: 'xs' | 'sm' | 'md';
}) {
  const box = size === 'xs' ? 'size-4 text-[0.4375rem]' : size === 'md' ? 'size-6 text-[0.625rem]' : 'size-[18px] text-[0.5rem]';

  if (!name) {
    return (
      <span
        aria-label="Unassigned"
        title="Unassigned"
        className={cx('grid shrink-0 place-items-center rounded-full border border-dashed border-fg-quaternary text-fg-quaternary', box)}
      >
        <svg viewBox="0 0 16 16" fill="none" aria-hidden="true" className="size-[70%]">
          <path d="M8 7.5a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5ZM3.5 13.5a4.5 4.5 0 0 1 9 0" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
        </svg>
      </span>
    );
  }
  return (
    <span
      title={name}
      aria-label={`Assigned to ${name}`}
      style={{ backgroundColor: avatarColor(name) }}
      className={cx('grid shrink-0 place-items-center rounded-full font-semibold text-white', box)}
    >
      {initials(name)}
    </span>
  );
}

/* -------------------------------------------------------------------------- */
/* Row                                                                         */
/* -------------------------------------------------------------------------- */

/**
 * Columns, left to right, at Linear's offsets: priority, a fixed-width key so
 * every identifier lines up down the page, status, then the title. Only the
 * title track is allowed to shrink.
 */
export function IssueRowView({ row, action }: { row: IssueRow; action?: React.ReactNode }) {
  return (
    <div
      className={cx(
        'group/row relative mx-2 flex h-11 items-center gap-2 rounded-md ps-[31px] pe-[19px] transition-colors hover:bg-secondary',
        // The keyboard position in the list: the row lights up, and an inset
        // ring makes it unmistakable for anyone who cannot see the wash.
        'has-[[data-row-link]:focus-visible]:bg-secondary has-[[data-row-link]:focus-visible]:ring-1 has-[[data-row-link]:focus-visible]:ring-focus-ring/60 has-[[data-row-link]:focus-visible]:ring-inset',
      )}
    >
      <PriorityIcon priority={row.priority} />

      <span className="w-[62px] shrink-0 truncate text-sm text-tertiary tabular-nums">{row.label}</span>

      <StateIcon type={row.state.type} color={row.state.color} />

      <span className="flex min-w-0 flex-1 items-center gap-1.5 ps-1">
        <Link
          href={row.href}
          data-row-link
          className="min-w-0 truncate text-sm font-medium text-primary no-underline outline-none after:absolute after:inset-0 after:rounded-md"
        >
          {row.title}
        </Link>

        {row.parent ? (
          <Link
            href={row.parent.href}
            title={row.parent.title}
            className="relative z-10 hidden min-w-0 items-center gap-1 text-sm text-tertiary no-underline hover:text-secondary lg:flex"
          >
            <IconChevronRight className="size-3 shrink-0 text-quaternary" />
            <span className="truncate">{row.parent.title}</span>
          </Link>
        ) : null}
      </span>

      <div className="hidden shrink-0 items-center gap-1.5 md:flex">
        {row.childProgress ? (
          <ProgressPie done={row.childProgress.done} total={row.childProgress.total} />
        ) : null}

        {row.labels.slice(0, 3).map((label) => (
          <Chip key={label.id} color={label.color}>
            {label.name}
          </Chip>
        ))}
        {row.labels.length > 3 ? (
          <span className={CHIP}>+{row.labels.length - 3}</span>
        ) : null}

        {row.board ? (
          <Link href={row.board.href} title={row.board.name} className={cx(CHIP, 'no-underline hover:text-secondary')}>
            <span aria-hidden="true" className={cx('size-2 shrink-0 rounded-[2px]', colorClass(row.board.color).dot)} />
            <span className="truncate">{row.board.name}</span>
          </Link>
        ) : null}

        {row.cycleNumber !== null ? (
          <span title={`Cycle ${row.cycleNumber}`} className={cx(CHIP, 'tabular-nums')}>
            <IconCycle className="size-3.5" />
            {row.cycleNumber}
          </span>
        ) : null}

        {row.commentCount > 0 ? (
          <span title={`${row.commentCount} comments`} className={cx(CHIP, 'tabular-nums')}>
            <IconComment className="size-3.5" />
            {row.commentCount}
          </span>
        ) : null}

        {row.dueDateLabel ? (
          <span
            className={cx(CHIP, 'tabular-nums', row.overdue && 'border-error_subtle text-error-primary')}
            title={row.overdue ? 'Overdue' : 'Due date'}
          >
            <IconCalendar className="size-3.5" />
            {row.dueDateLabel}
          </span>
        ) : null}
      </div>

      <span className="ms-1.5 flex shrink-0">
        <Assignee name={row.assigneeName} />
      </span>

      <span className="hidden w-12 shrink-0 text-right text-xs text-tertiary tabular-nums sm:block">
        {row.updatedLabel}
      </span>

      {action ? (
        <span className="relative z-10 -me-2 flex shrink-0 opacity-0 transition-opacity group-hover/row:opacity-100 focus-within:opacity-100">
          {action}
        </span>
      ) : null}
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Grouped list                                                                */
/* -------------------------------------------------------------------------- */

/** The group header's wash, tinted a few percent toward the state's own hue. */
function groupTint(color: string): string {
  const token = isColorToken(color) ? color : 'gray';
  return `color-mix(in srgb, var(--color-status-${token}) 3%, var(--color-bg-tertiary))`;
}

/**
 * A state group. `<details>` rather than React state: collapsing a group is
 * exactly what the element is for, it works before hydration, and it keeps this
 * whole file a Server Component. The header sticks under the page bar while
 * its rows scroll past, as Linear's does.
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
      <summary
        style={{ backgroundColor: groupTint(group.state.color) }}
        className="sticky top-11 z-20 mx-2 flex h-9 cursor-pointer list-none items-center gap-2 rounded-md ps-3.5 pe-2 outline-focus-ring focus-visible:outline-2 focus-visible:-outline-offset-2"
      >
        <svg viewBox="0 0 16 16" aria-hidden="true" className="size-3 text-quaternary transition-transform -rotate-90 group-open/details:rotate-0">
          <path d="M4.5 6.25h7L8 10.25z" fill="currentColor" />
        </svg>
        <StateIcon type={group.state.type} color={group.state.color} />
        <span className="text-sm font-medium text-primary">{group.state.name}</span>
        <span className="text-sm text-tertiary tabular-nums">{group.issues.length}</span>
        {action ? <span className="ms-auto flex">{action}</span> : null}
      </summary>
      <div className="flex flex-col gap-px py-px">
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
  renderGroupAction,
}: {
  groups: IssueGroup[];
  emptyMessage?: string;
  renderAction?: (row: IssueRow) => React.ReactNode;
  renderGroupAction?: (group: IssueGroup) => React.ReactNode;
}) {
  if (groups.length === 0) {
    return <p className="px-4.5 py-12 text-center text-sm text-tertiary">{emptyMessage}</p>;
  }

  return (
    <IssueListKeys className="flex flex-col gap-px">
      {groups.map((group) => (
        <IssueGroupView
          key={group.state.id}
          group={group}
          renderAction={renderAction}
          action={renderGroupAction?.(group)}
        />
      ))}
    </IssueListKeys>
  );
}
