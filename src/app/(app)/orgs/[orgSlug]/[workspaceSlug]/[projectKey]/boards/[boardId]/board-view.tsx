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
 *
 * The card itself is Linear-shaped: key and parent breadcrumb up top, status
 * icon beside the title, property chips below. Status, priority and assignee
 * are edited in place through `PropertyPicker` popups on the card -- the same
 * Server Actions the context menu calls, with failures landing in the board's
 * one error slot. The cards keep no property state of their own: revalidation
 * delivers each edit back down as props. On the drag overlay the same layout
 * renders as plain spans, because the overlay is a picture, not a control.
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
import { IconCalendar, IconChevronRight, IconComment, IconPlus } from '@/components/icons';
import { Assignee, CHIP, Chip, PriorityIcon, StateIcon } from '@/components/issue-row';
import {
  PropertyPicker,
  assigneeOptions,
  priorityOptions,
  stateOptions,
} from '@/components/property-picker';
import { FormError } from '@/components/ui';
import { requestCompose } from '@/lib/shell-events';
import { cx } from '@/lib/utils/cx';

import { placeIssue, setIssueAssignee, setIssuePriority } from '../../issue-actions';
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
  assigneeId: string | null;
  assigneeName: string | null;
  /** The parent issue's title, shown as breadcrumb context beside the key. */
  parentTitle: string | null;
  commentCount: number;
  priority: Priority;
  labels: MenuLabel[];
  cycleId: string | null;
  /** Pre-formatted on the server so the client never re-derives a locale. */
  dueDateLabel: string | null;
  /** True when the due date is in the past. */
  overdue: boolean;
  createdAtLabel: string;
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
};

function toRecords(columns: BoardStateColumn[]): Record<string, BoardIssue[]> {
  return Object.fromEntries(columns.map((column) => [column.id, column.issues]));
}

/* -------------------------------------------------------------------------- */
/* Card                                                                        */
/* -------------------------------------------------------------------------- */

/** What a card needs to know about the state it currently sits in. */
type CardColumn = Pick<BoardStateColumn, 'id' | 'name' | 'type' | 'color'>;

/** Runs one Server Action; failures land in the board's error slot. */
type RunAction = (action: () => Promise<{ ok: boolean; error?: string }>) => void;

/** The square chip priority sits in, next to the round property chips. */
const PRIORITY_CHIP =
  'flex h-[22px] w-[26px] shrink-0 items-center justify-center rounded-md border border-secondary text-tertiary';

function IssueCard({
  issue,
  projectKey,
  column,
  columns,
  members,
  run,
  overlay = false,
  action,
}: {
  issue: BoardIssue;
  projectKey: string;
  /** The state this card is in right now; drives the status trigger icon. */
  column: CardColumn;
  /** Live columns in board order. Omitted on the drag overlay. */
  columns?: BoardStateColumn[];
  members?: BoardMember[];
  run?: RunAction;
  overlay?: boolean;
  /** The `...` trigger. Omitted on the drag overlay, where it is inert. */
  action?: ReactNode;
}) {
  const issueKey = `${projectKey}-${issue.number}`;
  // The overlay is a picture of the card mid-flight, not a control surface, so
  // it gets the same layout with plain spans where the pickers would be.
  const pickers = !overlay && columns && members && run ? { columns, members, run } : null;

  return (
    <div
      className={cx(
        'group/card no-native-drag flex flex-col gap-2 rounded-lg border bg-raised px-3 pt-2.5 pb-3 transition-colors',
        overlay
          ? 'rotate-[1.5deg] border-primary shadow-xl'
          : 'border-secondary shadow-xs hover:border-primary',
      )}
    >
      <div className="flex h-5 items-center gap-1">
        <span className="shrink-0 text-xs text-tertiary tabular-nums">{issueKey}</span>

        {issue.parentTitle ? (
          <>
            <IconChevronRight className="size-3 shrink-0 text-quaternary" />
            <span className="min-w-0 truncate text-xs text-tertiary">{issue.parentTitle}</span>
          </>
        ) : null}

        <span className="ms-auto flex shrink-0 items-center gap-0.5">
          {action ? (
            // Hidden until hover where there IS hover; always there on touch,
            // where it is the only way into the menu.
            <span className="flex [@media(hover:hover)]:opacity-0 [@media(hover:hover)]:group-hover/card:opacity-100 [@media(hover:hover)]:has-[[data-popup-open]]:opacity-100 [@media(hover:hover)]:focus-within:opacity-100">
              {action}
            </span>
          ) : null}
          {pickers ? (
            <PropertyPicker
              options={assigneeOptions(pickers.members)}
              currentId={issue.assigneeId ?? ''}
              placeholder="Assign to..."
              shortcutHint="A"
              onSelect={(id) =>
                pickers.run(() => setIssueAssignee({ ticketId: issue.id, assigneeId: id }))
              }
              ariaLabel={`Set assignee for ${issueKey}`}
              triggerClassName="shrink-0 rounded-full"
            >
              <Assignee name={issue.assigneeName} />
            </PropertyPicker>
          ) : (
            <span className="shrink-0">
              <Assignee name={issue.assigneeName} />
            </span>
          )}
        </span>
      </div>

      <div className="flex items-start gap-2">
        {pickers ? (
          <PropertyPicker
            options={stateOptions(pickers.columns)}
            currentId={column.id}
            placeholder="Change status..."
            shortcutHint="S"
            onSelect={(stateId) => {
              const target = pickers.columns.find((c) => c.id === stateId);
              if (!target) return;
              pickers.run(() =>
                placeIssue({
                  ticketId: issue.id,
                  toStateId: stateId,
                  // Append; a precise index is what dragging is for.
                  toIndex: target.issues.length,
                  visibleIds: target.issues.map((i) => i.id).filter((id) => id !== issue.id),
                }),
              );
            }}
            ariaLabel={`Set status for ${issueKey}`}
            triggerClassName="mt-[3px] shrink-0 rounded-full"
          >
            <StateIcon type={column.type} color={column.color} />
          </PropertyPicker>
        ) : (
          <span className="mt-[3px] shrink-0">
            <StateIcon type={column.type} color={column.color} />
          </span>
        )}

        <Link
          href={issue.href}
          // Keep the title clickable: without this the drag sensor claims the
          // press. `draggable={false}` + cancelling dragstart stops the BROWSER
          // starting its own link-drag (its ghost image of the text) instead.
          onPointerDown={(event) => event.stopPropagation()}
          draggable={false}
          onDragStart={(event) => event.preventDefault()}
          className="line-clamp-2 min-w-0 flex-1 text-sm font-medium text-primary no-underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring"
        >
          {issue.title}
        </Link>
      </div>

      <div className="flex flex-wrap items-center gap-1">
        {pickers ? (
          <PropertyPicker
            options={priorityOptions()}
            currentId={issue.priority}
            placeholder="Change priority to..."
            shortcutHint="P"
            onSelect={(id) =>
              pickers.run(() => setIssuePriority({ ticketId: issue.id, priority: id as Priority }))
            }
            ariaLabel={`Set priority for ${issueKey}`}
            triggerClassName={cx(PRIORITY_CHIP, 'transition-colors hover:bg-quaternary')}
          >
            <PriorityIcon priority={issue.priority} className="size-3.5" />
          </PropertyPicker>
        ) : (
          <span className={PRIORITY_CHIP}>
            <PriorityIcon priority={issue.priority} className="size-3.5" />
          </span>
        )}

        {issue.labels.slice(0, 3).map((label) => (
          <Chip key={label.id} color={label.color}>
            {label.name}
          </Chip>
        ))}

        {issue.dueDateLabel ? (
          <span
            title={issue.overdue ? 'Overdue' : 'Due date'}
            className={cx(CHIP, 'whitespace-nowrap tabular-nums', issue.overdue && 'border-error_subtle text-error-primary')}
          >
            <IconCalendar className="size-3.5" />
            {issue.dueDateLabel}
          </span>
        ) : null}

        {issue.commentCount > 0 ? (
          <span className={cx(CHIP, 'tabular-nums')}>
            <IconComment className="size-3.5" />
            {issue.commentCount}
          </span>
        ) : null}
      </div>

      <p className="text-xs text-tertiary">Created {issue.createdAtLabel}</p>
    </div>
  );
}

/** A `+` that starts an issue already in a column's state. */
function ComposeHere({ column, block = false }: { column: CardColumn; block?: boolean }) {
  return (
    <button
      type="button"
      onClick={() => requestCompose({ stateId: column.id })}
      aria-label={`New issue in ${column.name}`}
      title={`New issue in ${column.name}`}
      className={cx(
        'place-items-center text-tertiary transition-colors hover:text-primary',
        block
          ? 'grid h-7 w-full rounded-md bg-tertiary/60 hover:bg-tertiary'
          : 'grid size-6 rounded-md hover:bg-tertiary',
      )}
    >
      <IconPlus className="size-3.5" />
    </button>
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

  /**
   * One funnel for every on-card property edit, feeding the same error slot as
   * a rejected drag. No optimistic patching: revalidation delivers the new
   * value as props, and the `useEffect` above folds it into `records`.
   */
  function run(action: () => Promise<{ ok: boolean; error?: string }>) {
    startTransition(async () => {
      const result = await action();
      setError(result.ok ? null : (result.error ?? 'Something went wrong.'));
    });
  }

  return (
    <div className="flex flex-col">
      {error ? <FormError className="mx-2.5 mb-2">{error}</FormError> : null}

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
        <KanbanBoard className="flex flex-col gap-2 px-2 pb-2 md:min-h-[calc(100dvh-106px)] md:flex-row md:overflow-x-auto">
          {columns.map((column) => {
            const issues = records[column.id] ?? [];
            return (
              <KanbanColumn
                key={column.id}
                value={column.id}
                className="flex w-full flex-col rounded-lg bg-sunken md:w-[336px] md:shrink-0"
              >
                <header className="flex h-11 shrink-0 items-center gap-2 ps-3.5 pe-2">
                  <StateIcon type={column.type} color={column.color} />
                  <h2 className="text-sm font-medium text-primary">{column.name}</h2>
                  <span className="text-sm text-tertiary tabular-nums">{issues.length}</span>
                  <span className="ms-auto flex">
                    <ComposeHere column={column} />
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
                              column={column}
                              columns={liveColumns}
                              members={members}
                              run={run}
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

                  {issues.length === 0 ? <ComposeHere column={column} block /> : null}
                </KanbanColumnContent>
              </KanbanColumn>
            );
          })}
        </KanbanBoard>

        <KanbanOverlay>
          {({ value }) => {
            const issue = byId.get(String(value));
            if (!issue) return null;
            // Mid-drag the live records still hold the card somewhere; that
            // column's icon is what the overlay shows.
            const column = liveColumns.find((c) => c.issues.some((i) => i.id === issue.id));
            if (!column) return null;
            return (
              <div className="w-[320px]">
                <IssueCard issue={issue} projectKey={projectKey} column={column} overlay />
              </div>
            );
          }}
        </KanbanOverlay>
      </Kanban>

      {total === 0 ? (
        <p className="px-4.5 py-3 text-sm text-tertiary">
          Nothing filed under this board yet. Create an issue, or set the board on an existing one
          from its menu.
        </p>
      ) : null}
    </div>
  );
}
