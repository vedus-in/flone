'use client';

/**
 * The Kanban board, built on the ReUI `Kanban` primitives.
 *
 * The board's shape on the wire is an ORDERED array of columns, but `Kanban`
 * models the board as `Record<columnId, items>`. Both are kept: `records` is the
 * draggable state, `columns` supplies column order and names, so object key
 * ordering is never load-bearing.
 *
 * `onValueChange` fires continuously during a drag to paint the live preview,
 * so it must not persist anything. `onValueCommit` fires once per completed
 * drag with the final board plus a `previousValue` snapshot, which is where the
 * Server Action is called. A rejected move restores that snapshot and shows the
 * reason, so a failed drag can never look like it succeeded.
 *
 * Keyboard dragging comes from dnd-kit underneath: Space lifts a card, arrows
 * move it, Space drops, Escape cancels -- so there is no need for the arrow
 * buttons this board used to carry.
 *
 * All user text is rendered as an escaped React child; React's raw-HTML escape
 * hatch is banned project-wide and is not used here.
 */

import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  useTransition,
  type ReactNode,
} from 'react';
import Link from 'next/link';
import type { Priority } from '@prisma/client';
import { Modal } from '@heroui/react/modal';

import {
  Kanban,
  KanbanBoard,
  KanbanColumn,
  KanbanColumnContent,
  KanbanItem,
  KanbanItemHandle,
  KanbanOverlay,
} from '@/components/reui/kanban';
import { FormError } from '@/components/ui';
import { createTicket, placeTicket } from './actions';
import {
  TicketContextMenu,
  TicketMenuButton,
  type BoardMember,
  type SiblingBoard,
} from './ticket-menu';

/* -------------------------------------------------------------------------- */
/* Props                                                                       */
/* -------------------------------------------------------------------------- */

export type BoardTicket = {
  id: string;
  number: number;
  title: string;
  assigneeName: string | null;
  commentCount: number;
  priority: Priority;
  /** Pre-formatted on the server so the client never re-derives a locale. */
  dueDateLabel: string | null;
  /** True when the due date is in the past and the card is still open. */
  overdue: boolean;
  updatedAtLabel: string;
  /**
   * Author-or-privileged, computed on the SERVER exactly as the ticket page
   * computes it. Presentation only -- `deleteTicketFromBoard` re-derives it.
   */
  canDelete: boolean;
};

export type BoardColumnData = {
  id: string;
  name: string;
  tickets: BoardTicket[];
};

type BoardViewProps = {
  boardId: string;
  /** Concrete board path, built server-side by `boardPath()`. */
  boardHref: string;
  projectKey: string;
  columns: BoardColumnData[];
  /** Assignee candidates: members of this organization only. */
  members: BoardMember[];
  /** Sibling boards in the same project, for "Move to board". */
  boards: SiblingBoard[];
};

const PRIORITY_DOT: Record<Priority, string | null> = {
  URGENT: 'bg-danger',
  HIGH: 'bg-warning',
  MEDIUM: 'bg-accent',
  LOW: 'bg-muted',
  NONE: null,
};

const PRIORITY_LABEL: Record<Priority, string> = {
  URGENT: 'Urgent',
  HIGH: 'High',
  MEDIUM: 'Medium',
  LOW: 'Low',
  NONE: 'No priority',
};

function cx(...values: Array<string | false | null | undefined>): string {
  return values.filter(Boolean).join(' ');
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

function toRecords(columns: BoardColumnData[]): Record<string, BoardTicket[]> {
  return Object.fromEntries(columns.map((column) => [column.id, column.tickets]));
}

/* -------------------------------------------------------------------------- */
/* Card                                                                        */
/* -------------------------------------------------------------------------- */

function TicketCard({
  ticket,
  projectKey,
  boardHref,
  overlay = false,
  action,
}: {
  ticket: BoardTicket;
  projectKey: string;
  boardHref: string;
  overlay?: boolean;
  /** The `⋮` trigger. Omitted on the drag overlay, where it is inert. */
  action?: ReactNode;
}) {
  return (
    <div
      className={cx(
        'no-native-drag flex flex-col gap-2.5 rounded-lg border bg-surface p-3 transition-colors',
        overlay
          ? 'rotate-2 border-accent shadow-lg'
          : 'border-border shadow-xs hover:border-border-secondary',
      )}
    >
      <div className="flex items-start gap-1">
        <Link
          href={`${boardHref}/${ticket.number}`}
          // Keep the title clickable: without this the drag sensor claims the
          // press. `draggable={false}` + cancelling dragstart stops the BROWSER
          // starting its own link-drag (its ghost image of the text) instead.
          onPointerDown={(event) => event.stopPropagation()}
          draggable={false}
          onDragStart={(event) => event.preventDefault()}
          className="min-w-0 flex-1 text-sm leading-snug font-medium text-foreground no-underline hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
        >
          {ticket.title}
        </Link>
        {action}
      </div>

      <div className="flex items-center gap-2 text-xs text-muted">
        {PRIORITY_DOT[ticket.priority] ? (
          <span
            aria-label={PRIORITY_LABEL[ticket.priority]}
            title={PRIORITY_LABEL[ticket.priority]}
            className={cx('size-2 shrink-0 rounded-full', PRIORITY_DOT[ticket.priority])}
          />
        ) : null}

        <span className="font-mono tabular-nums">
          {projectKey}-{ticket.number}
        </span>

        {ticket.dueDateLabel ? (
          <span
            className={cx('whitespace-nowrap', ticket.overdue && 'font-medium text-danger')}
            title={ticket.overdue ? 'Overdue' : 'Due date'}
          >
            {ticket.dueDateLabel}
          </span>
        ) : null}

        {ticket.commentCount > 0 ? (
          <span className="flex items-center gap-1 tabular-nums">
            <svg viewBox="0 0 16 16" fill="none" aria-hidden="true" className="size-3.5">
              <path
                d="M14 9.5a2 2 0 0 1-2 2H5.5L2 14V4a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2z"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
            {ticket.commentCount}
          </span>
        ) : null}

        <span className="ms-auto">
          {ticket.assigneeName ? (
            <span
              title={ticket.assigneeName}
              aria-label={`Assigned to ${ticket.assigneeName}`}
              className="grid size-6 place-items-center rounded-full bg-surface-secondary text-[0.625rem] font-medium text-muted"
            >
              {initials(ticket.assigneeName)}
            </span>
          ) : (
            <span
              aria-label="Unassigned"
              className="grid size-6 place-items-center rounded-full border border-dashed border-border text-[0.625rem] text-muted"
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
/* Add card                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * A pill wearing a native `<select>`.
 *
 * Deliberately native: these are 3-5 option enums, and a real select brings its
 * own keyboard handling, typeahead and -- the reason that matters -- the OS
 * picker on a phone. A custom listbox would be more markup for less behaviour.
 */
function Pill({
  label,
  value,
  onChange,
  children,
  dot,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  children: ReactNode;
  dot?: ReactNode;
}) {
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full border border-border px-2.5 py-1 text-xs text-foreground transition-colors hover:bg-surface-secondary has-[select:focus-visible]:outline-2 has-[select:focus-visible]:outline-offset-1 has-[select:focus-visible]:outline-focus">
      {dot}
      <select
        aria-label={label}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className="cursor-pointer appearance-none bg-transparent text-xs text-foreground outline-none"
      >
        {children}
      </select>
    </span>
  );
}

/**
 * The compose dialog.
 *
 * Title and description are the whole point, so they are borderless and large;
 * the metadata sits under them as pills, and the dialog's own chrome stays out
 * of the way. Escape and the backdrop close it -- HeroUI's Modal owns the focus
 * trap and the scroll lock.
 */
function AddCard({
  boardId,
  column,
  columns,
  projectKey,
  members,
}: {
  boardId: string;
  column: BoardColumnData;
  columns: BoardColumnData[];
  projectKey: string;
  members: BoardMember[];
}) {
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  // Controlled: React 19 resets a form bound to an action once it settles,
  // regardless of the result, which would discard a rejected title.
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [columnId, setColumnId] = useState(column.id);
  const [priority, setPriority] = useState<Priority>('NONE');
  /** The empty string is "unassigned"; the action treats it as null. */
  const [assigneeId, setAssigneeId] = useState('');
  // Off by default: the common case is one card, and a dialog that refuses to
  // close is worse than one extra click.
  const [createMore, setCreateMore] = useState(false);
  const titleRef = useRef<HTMLTextAreaElement>(null);
  const headingId = useId();

  function submit() {
    const value = title.trim();
    if (!value) return;
    const data = new FormData();
    data.set('boardId', boardId);
    data.set('columnId', columnId);
    data.set('title', value);
    data.set('description', description.trim());
    data.set('priority', priority);
    data.set('assigneeId', assigneeId);

    startTransition(async () => {
      const result = await createTicket(null, data);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setTitle('');
      setDescription('');
      setPriority('NONE');
      setAssigneeId('');
      setError(null);
      if (createMore) titleRef.current?.focus();
      else setOpen(false);
    });
  }

  const targetColumn = columns.find((candidate) => candidate.id === columnId) ?? column;
  const assignee = members.find((member) => member.id === assigneeId) ?? null;

  return (
    <>
      <button
        type="button"
        onClick={() => {
          // The dialog is per-column, so it always opens pointed at the column
          // whose button was pressed -- even if it was left on another one.
          setColumnId(column.id);
          setError(null);
          setOpen(true);
        }}
        className="mt-1 flex items-center gap-1.5 rounded-lg px-2 py-1.5 text-start text-sm text-muted transition-colors hover:bg-surface-secondary hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
      >
        <svg viewBox="0 0 16 16" fill="none" aria-hidden="true" className="size-4">
          <path d="M8 3.5v9M3.5 8h9" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
        </svg>
        Add a card
      </button>

      <Modal.Backdrop isOpen={open} onOpenChange={setOpen} variant="blur">
        <Modal.Container placement="center">
          <Modal.Dialog
            aria-labelledby={headingId}
            className="gap-0 p-0 shadow-2xl sm:max-w-[36rem]"
          >
            <div className="flex items-center gap-1.5 px-4 pt-4 pb-2">
              <span className="rounded bg-surface-secondary px-1.5 py-0.5 font-mono text-[0.6875rem] text-muted">
                {projectKey}
              </span>
              <svg viewBox="0 0 16 16" fill="none" aria-hidden="true" className="size-3 text-muted">
                <path
                  d="M6 3.5 10.5 8 6 12.5"
                  stroke="currentColor"
                  strokeWidth="1.5"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
              <span id={headingId} className="text-sm font-medium text-foreground">
                New card
              </span>
            </div>
            <Modal.CloseTrigger />

            <div className="flex flex-col gap-1 px-4 pt-2">
              {/* `field-sizing-content` grows both fields with their text, so a
                  long title never hides behind a scrollbar. */}
              <textarea
                ref={titleRef}
                autoFocus
                rows={1}
                maxLength={200}
                value={title}
                onChange={(event) => setTitle(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' && !event.shiftKey) {
                    event.preventDefault();
                    submit();
                  }
                }}
                aria-label="Card title"
                placeholder="Card title"
                className="w-full resize-none border-0 bg-transparent p-0 text-lg font-medium text-foreground field-sizing-content placeholder:text-muted focus:outline-none"
              />
              <textarea
                rows={2}
                maxLength={2000}
                value={description}
                onChange={(event) => setDescription(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
                    event.preventDefault();
                    submit();
                  }
                }}
                aria-label="Description"
                placeholder="Add description…"
                className="w-full resize-none border-0 bg-transparent p-0 text-sm text-foreground field-sizing-content placeholder:text-muted focus:outline-none"
              />
            </div>

            <div className="flex flex-wrap items-center gap-1.5 px-4 pt-4 pb-3">
              <Pill
                label="Column"
                value={columnId}
                onChange={setColumnId}
                dot={
                  <span
                    aria-hidden="true"
                    className="size-2 rounded-full border border-muted"
                    title={targetColumn.name}
                  />
                }
              >
                {columns.map((candidate) => (
                  <option key={candidate.id} value={candidate.id}>
                    {candidate.name}
                  </option>
                ))}
              </Pill>

              <Pill
                label="Priority"
                value={priority}
                onChange={(value) => setPriority(value as Priority)}
                dot={
                  <span
                    aria-hidden="true"
                    className={cx(
                      'size-2 rounded-full',
                      PRIORITY_DOT[priority] ?? 'border border-muted',
                    )}
                  />
                }
              >
                {(Object.keys(PRIORITY_LABEL) as Priority[]).map((value) => (
                  <option key={value} value={value}>
                    {PRIORITY_LABEL[value]}
                  </option>
                ))}
              </Pill>

              {/* Members of this organization only. The action re-checks the
                  membership regardless -- this list decides what to OFFER. */}
              <Pill
                label="Assignee"
                value={assigneeId}
                onChange={setAssigneeId}
                dot={
                  assignee ? (
                    <span
                      aria-hidden="true"
                      className="grid size-4 place-items-center rounded-full bg-surface-secondary text-[0.5rem] font-medium text-foreground"
                    >
                      {initials(assignee.name)}
                    </span>
                  ) : (
                    <svg
                      viewBox="0 0 16 16"
                      fill="none"
                      aria-hidden="true"
                      className="size-3.5 text-muted"
                    >
                      <path
                        d="M8 8a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5ZM3 13.5a5 5 0 0 1 10 0"
                        stroke="currentColor"
                        strokeWidth="1.5"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      />
                    </svg>
                  )
                }
              >
                <option value="">Unassigned</option>
                {members.map((member) => (
                  <option key={member.id} value={member.id}>
                    {member.name}
                  </option>
                ))}
              </Pill>
            </div>

            {error ? (
              <div className="px-4 pb-3">
                <FormError>{error}</FormError>
              </div>
            ) : null}

            <div className="flex items-center justify-between gap-3 border-t border-border px-4 py-3">
              <label className="flex cursor-pointer items-center gap-2 text-xs text-muted">
                <input
                  type="checkbox"
                  checked={createMore}
                  onChange={(event) => setCreateMore(event.target.checked)}
                  className="size-3.5 accent-accent"
                />
                Create more
              </label>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => setOpen(false)}
                  className="rounded-lg px-2.5 py-1.5 text-sm text-muted transition-colors hover:text-foreground"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={submit}
                  disabled={pending || title.trim().length === 0}
                  className="rounded-lg bg-accent px-3 py-1.5 text-sm font-medium text-accent-foreground transition-opacity disabled:opacity-50"
                >
                  {pending ? 'Creating…' : 'Create card'}
                </button>
              </div>
            </div>
          </Modal.Dialog>
        </Modal.Container>
      </Modal.Backdrop>
    </>
  );
}

/* -------------------------------------------------------------------------- */
/* Board                                                                       */
/* -------------------------------------------------------------------------- */

export function BoardView({
  boardId,
  boardHref,
  projectKey,
  columns,
  members,
  boards,
}: BoardViewProps) {
  const [records, setRecords] = useState<Record<string, BoardTicket[]>>(() => toRecords(columns));
  const [error, setError] = useState<string | null>(null);
  const [, startTransition] = useTransition();

  // The server is the source of truth. When revalidation delivers new props the
  // optimistic copy is dropped -- which is also what makes a rejected move snap
  // back rather than linger.
  useEffect(() => {
    setRecords(toRecords(columns));
  }, [columns]);

  const byId = useMemo(() => {
    const map = new Map<string, BoardTicket>();
    for (const list of Object.values(records)) {
      for (const ticket of list) map.set(ticket.id, ticket);
    }
    return map;
  }, [records]);

  const total = useMemo(
    () => Object.values(records).reduce((sum, list) => sum + list.length, 0),
    [records],
  );

  /**
   * Column order and names from props, ticket contents from live state, so the
   * menu's "Status" ticks the column a card is actually in mid-drag rather than
   * the one the server last rendered.
   */
  const liveColumns = useMemo(
    () => columns.map((column) => ({ ...column, tickets: records[column.id] ?? [] })),
    [columns, records],
  );

  return (
    <div className="flex flex-col gap-3">
      <FormError>{error}</FormError>

      <Kanban
        value={records}
        onValueChange={setRecords}
        getItemValue={(ticket) => ticket.id}
        restoreOnCancel
        onValueCommit={(next, meta) => {
          // Columns are fixed for this board; only card moves are persisted.
          if (meta.kind !== 'item') return;

          const ticketId = String(meta.event.active.id);
          startTransition(async () => {
            const result = await placeTicket({
              ticketId,
              toColumnId: meta.overContainer,
              toIndex: meta.overIndex,
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
            const tickets = records[column.id] ?? [];
            return (
              <KanbanColumn
                key={column.id}
                value={column.id}
                className="flex w-full flex-col rounded-xl border border-border bg-surface-secondary/40 md:w-72 md:shrink-0"
              >
                <header className="flex items-center gap-2 px-3 py-2.5">
                  <h2 className="text-xs font-semibold tracking-wide text-muted uppercase">
                    {column.name}
                  </h2>
                  <span className="rounded-full bg-surface-secondary px-1.5 text-xs text-muted tabular-nums">
                    {tickets.length}
                  </span>
                </header>

                <KanbanColumnContent
                  value={column.id}
                  className="flex min-h-24 flex-1 flex-col gap-2 px-2 pb-2"
                >
                  {tickets.map((ticket) => {
                    const menuData = {
                      ticket,
                      columns: liveColumns,
                      members,
                      boards,
                      projectKey,
                      boardHref,
                      onError: setError,
                    };
                    return (
                      <KanbanItem key={ticket.id} value={ticket.id}>
                        <KanbanItemHandle className="no-native-drag cursor-grab active:cursor-grabbing">
                          <TicketContextMenu {...menuData}>
                            <TicketCard
                              ticket={ticket}
                              projectKey={projectKey}
                              boardHref={boardHref}
                              // Touch has no right-click, and long-press is
                              // already the drag gesture, so the button is the
                              // only way in on a phone.
                              action={<TicketMenuButton {...menuData} />}
                            />
                          </TicketContextMenu>
                        </KanbanItemHandle>
                      </KanbanItem>
                    );
                  })}

                  {tickets.length === 0 ? (
                    <p className="grid flex-1 place-items-center px-2 py-6 text-center text-xs text-muted">
                      Drop a card here
                    </p>
                  ) : null}
                </KanbanColumnContent>

                <div className="px-2 pb-2">
                  <AddCard
                    boardId={boardId}
                    column={column}
                    columns={liveColumns}
                    projectKey={projectKey}
                    members={members}
                  />
                </div>
              </KanbanColumn>
            );
          })}
        </KanbanBoard>

        <KanbanOverlay>
          {({ value }) => {
            const ticket = byId.get(String(value));
            if (!ticket) return null;
            return (
              <div className="w-72">
                <TicketCard
                  ticket={ticket}
                  projectKey={projectKey}
                  boardHref={boardHref}
                  overlay
                />
              </div>
            );
          }}
        </KanbanOverlay>
      </Kanban>

      {total === 0 ? (
        <p className="text-sm text-muted">
          Add a card to any column to get started, then drag cards between columns as work moves
          along.
        </p>
      ) : null}
    </div>
  );
}
