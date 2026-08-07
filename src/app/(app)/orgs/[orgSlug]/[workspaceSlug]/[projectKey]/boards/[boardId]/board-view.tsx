'use client';

/**
 * The Kanban board, built on the ReUI `Kanban` primitives.
 *
 * The columns are the PROJECT's workflow states, not the board's own -- a board
 * no longer owns any. That is the point of the Linear rework: an issue has
 * exactly one status, so a card dragged here and the same issue in the issues
 * list can never disagree.
 *
 * A board shows a FILTERED slice of each state: only the issues filed under this
 * board. The drop index is therefore an index into what the user can SEE, which
 * is why `placeIssue` is told which ids were visible -- see `resolveIndex` there.
 * Without that, dropping a card at the top of a column would silently reorder
 * issues from three other boards that share the state and are not on screen.
 *
 * `onValueChange` fires continuously during a drag to paint the live preview, so
 * it must not persist anything. `onValueCommit` fires once per completed drag
 * with the final board plus a `previousValue` snapshot, which is where the
 * Server Action is called. A rejected move restores that snapshot and shows the
 * reason, so a failed drag can never look like it succeeded.
 *
 * Keyboard dragging comes from dnd-kit underneath: Space lifts a card, arrows
 * move it, Space drops, Escape cancels.
 */

import { useEffect, useMemo, useState, useTransition, type ReactNode } from 'react';
import Link from 'next/link';
import type { Priority, WorkflowStateType } from '@prisma/client';

import {
  Kanban,
  KanbanBoard,
  KanbanColumn,
  KanbanColumnContent,
  KanbanItem,
  KanbanItemHandle,
  KanbanOverlay,
} from '@/components/reui/kanban';
import { PriorityIcon, StateIcon } from '@/components/issue-row';
import { FormError } from '@/components/ui';
import { colorClass } from '@/lib/model';
import { cx } from '@/lib/utils/cx';

import { placeIssue } from '../../issue-actions';
import {
  IssueContextMenu,
  IssueMenuButton,
  type BoardMember,
  type BoardOption,
  type MenuCycle,
  type MenuLabel,
} from './issue-menu';

/* -------------------------------------------------------------------------- */
/* Props                                                                       */
/* -------------------------------------------------------------------------- */

export type BoardIssue = {
  id: string;
  number: number;
  title: string;
  href: string;
  assigneeName: string | null;
  commentCount: number;
  priority: Priority;
  labels: MenuLabel[];
  cycleId: string | null;
  /** Pre-formatted on the server so the client never re-derives a locale. */
  dueDateLabel: string | null;
  /** True when the due date is in the past. */
  overdue: boolean;
  updatedAtLabel: string;
  /**
   * Author-or-privileged, computed on the SERVER exactly as the issue page
   * computes it. Presentation only -- `deleteIssue` re-derives it.
   */
  canDelete: boolean;
};

export type BoardStateColumn = {
  id: string;
  name: string;
  type: WorkflowStateType;
  color: string;
  issues: BoardIssue[];
};

type BoardViewProps = {
  projectKey: string;
  columns: BoardStateColumn[];
  members: BoardMember[];
  boards: BoardOption[];
  labels: MenuLabel[];
  cycles: MenuCycle[];
  boardId: string;
  /** Rendered above the board; the compose dialog is passed in from the page. */
  compose?: ReactNode;
};

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  // Array.from, not indexing: a name may begin with an astral character and
  // name[0] would slice a surrogate pair in half.
  const first = Array.from(parts[0])[0] ?? '';
  const last = parts.length > 1 ? (Array.from(parts[parts.length - 1])[0] ?? '') : '';
  return (first + last).toLocaleUpperCase();
}

function toRecords(columns: BoardStateColumn[]): Record<string, BoardIssue[]> {
  return Object.fromEntries(columns.map((column) => [column.id, column.issues]));
}

/* -------------------------------------------------------------------------- */
/* Card                                                                        */
/* -------------------------------------------------------------------------- */

function IssueCard({
  issue,
  projectKey,
  overlay = false,
  action,
}: {
  issue: BoardIssue;
  projectKey: string;
  overlay?: boolean;
  /** The `⋮` trigger. Omitted on the drag overlay, where it is inert. */
  action?: ReactNode;
}) {
  return (
    <div
      className={cx(
        'no-native-drag flex flex-col gap-2.5 rounded-lg border bg-primary p-3 transition-colors',
        overlay
          ? 'rotate-2 border-brand shadow-lg'
          : 'border-secondary shadow-xs hover:border-tertiary',
      )}
    >
      <div className="flex items-start gap-1">
        <Link
          href={issue.href}
          // Keep the title clickable: without this the drag sensor claims the
          // press. `draggable={false}` + cancelling dragstart stops the BROWSER
          // starting its own link-drag (its ghost image of the text) instead.
          onPointerDown={(event) => event.stopPropagation()}
          draggable={false}
          onDragStart={(event) => event.preventDefault()}
          className="min-w-0 flex-1 text-sm leading-snug font-medium text-primary no-underline hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring"
        >
          {issue.title}
        </Link>
        {action}
      </div>

      {issue.labels.length > 0 ? (
        <div className="flex flex-wrap gap-1">
          {issue.labels.slice(0, 3).map((label) => (
            <span
              key={label.id}
              className="flex items-center gap-1 rounded-full border border-secondary px-1.5 py-px text-[0.625rem] text-tertiary"
            >
              <span
                aria-hidden="true"
                className={cx('size-1.5 rounded-full', colorClass(label.color).dot)}
              />
              {label.name}
            </span>
          ))}
        </div>
      ) : null}

      <div className="flex items-center gap-2 text-xs text-tertiary">
        <PriorityIcon priority={issue.priority} className="size-3" />

        <span className="font-mono tabular-nums">
          {projectKey}-{issue.number}
        </span>

        {issue.dueDateLabel ? (
          <span
            className={cx('whitespace-nowrap', issue.overdue && 'font-medium text-error-primary')}
            title={issue.overdue ? 'Overdue' : 'Due date'}
          >
            {issue.dueDateLabel}
          </span>
        ) : null}

        {issue.commentCount > 0 ? (
          <span className="flex items-center gap-1 tabular-nums">
            <svg viewBox="0 0 16 16" fill="none" aria-hidden="true" className="size-3.5">
              <path
                d="M14 9.5a2 2 0 0 1-2 2H5.5L2 14V4a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2z"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinejoin="round"
              />
            </svg>
            {issue.commentCount}
          </span>
        ) : null}

        <span className="ms-auto">
          {issue.assigneeName ? (
            <span
              title={issue.assigneeName}
              aria-label={`Assigned to ${issue.assigneeName}`}
              className="grid size-6 place-items-center rounded-full bg-secondary text-[0.625rem] font-medium text-tertiary"
            >
              {initials(issue.assigneeName)}
            </span>
          ) : (
            <span
              aria-label="Unassigned"
              className="grid size-6 place-items-center rounded-full border border-dashed border-secondary text-[0.625rem] text-tertiary"
            >
              &ndash;
            </span>
          )}
        </span>
      </div>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Board                                                                       */
/* -------------------------------------------------------------------------- */

export function BoardView({
  projectKey,
  columns,
  members,
  boards,
  labels,
  cycles,
  boardId,
  compose,
}: BoardViewProps) {
  const [records, setRecords] = useState<Record<string, BoardIssue[]>>(() => toRecords(columns));
  const [error, setError] = useState<string | null>(null);
  const [, startTransition] = useTransition();

  // The server is the source of truth. When revalidation delivers new props the
  // optimistic copy is dropped -- which is also what makes a rejected move snap
  // back rather than linger.
  useEffect(() => {
    setRecords(toRecords(columns));
  }, [columns]);

  const byId = useMemo(() => {
    const map = new Map<string, BoardIssue>();
    for (const list of Object.values(records)) {
      for (const issue of list) map.set(issue.id, issue);
    }
    return map;
  }, [records]);

  const total = useMemo(
    () => Object.values(records).reduce((sum, list) => sum + list.length, 0),
    [records],
  );

  /**
   * Column order and names from props, contents from live state, so the menu's
   * "Status" ticks the state a card is actually in mid-drag rather than the one
   * the server last rendered.
   */
  const liveColumns = useMemo(
    () => columns.map((column) => ({ ...column, issues: records[column.id] ?? [] })),
    [columns, records],
  );

  return (
    <div className="flex flex-col gap-3">
      <FormError>{error}</FormError>
      {compose}

      <Kanban
        value={records}
        onValueChange={setRecords}
        getItemValue={(issue) => issue.id}
        restoreOnCancel
        onValueCommit={(next, meta) => {
          // Columns are the project's states; only card moves are persisted.
          if (meta.kind !== 'item') return;

          const ticketId = String(meta.event.active.id);
          // What the user could see in the destination, in order, minus the card
          // being dropped. The server uses it to land the card among issues from
          // OTHER boards that share this state and are not on screen.
          const visibleIds = (next[meta.overContainer] ?? [])
            .map((issue) => issue.id)
            .filter((id) => id !== ticketId);

          startTransition(async () => {
            const result = await placeIssue({
              ticketId,
              toStateId: meta.overContainer,
              toIndex: meta.overIndex,
              visibleIds,
            });
            if (!result.ok) {
              // Roll back to exactly the arrangement before this drag rather
              // than waiting for a revalidation that may never come.
              setRecords(meta.previousValue);
              setError(result.error);
            } else {
              setError(null);
            }
          });
        }}
      >
        <KanbanBoard className="flex flex-col gap-3 pb-4 md:-mx-6 md:flex-row md:overflow-x-auto md:px-6">
          {columns.map((column) => {
            const issues = records[column.id] ?? [];
            return (
              <KanbanColumn
                key={column.id}
                value={column.id}
                className="flex w-full flex-col rounded-xl border border-secondary bg-secondary/40 md:w-72 md:shrink-0"
              >
                <header className="flex items-center gap-2 px-3 py-2.5">
                  <StateIcon type={column.type} color={column.color} />
                  <h2 className="text-xs font-semibold tracking-wide text-tertiary uppercase">
                    {column.name}
                  </h2>
                  <span className="rounded-full bg-secondary px-1.5 text-xs text-tertiary tabular-nums">
                    {issues.length}
                  </span>
                </header>

                <KanbanColumnContent
                  value={column.id}
                  className="flex min-h-24 flex-1 flex-col gap-2 px-2 pb-2"
                >
                  {issues.map((issue) => {
                    const menuData = {
                      issue,
                      columns: liveColumns,
                      members,
                      boards,
                      labels,
                      cycles,
                      boardId,
                      projectKey,
                      onError: setError,
                    };
                    return (
                      <KanbanItem key={issue.id} value={issue.id}>
                        <KanbanItemHandle className="no-native-drag cursor-grab active:cursor-grabbing">
                          <IssueContextMenu {...menuData}>
                            <IssueCard
                              issue={issue}
                              projectKey={projectKey}
                              // Touch has no right-click, and long-press is
                              // already the drag gesture, so the button is the
                              // only way in on a phone.
                              action={<IssueMenuButton {...menuData} />}
                            />
                          </IssueContextMenu>
                        </KanbanItemHandle>
                      </KanbanItem>
                    );
                  })}

                  {issues.length === 0 ? (
                    <p className="grid flex-1 place-items-center px-2 py-6 text-center text-xs text-tertiary">
                      Drop a card here
                    </p>
                  ) : null}
                </KanbanColumnContent>
              </KanbanColumn>
            );
          })}
        </KanbanBoard>

        <KanbanOverlay>
          {({ value }) => {
            const issue = byId.get(String(value));
            if (!issue) return null;
            return (
              <div className="w-72">
                <IssueCard issue={issue} projectKey={projectKey} overlay />
              </div>
            );
          }}
        </KanbanOverlay>
      </Kanban>

      {total === 0 ? (
        <p className="text-sm text-tertiary">
          Nothing filed under this board yet. Create an issue, or set the board on an existing one
          from its menu.
        </p>
      ) : null}
    </div>
  );
}
