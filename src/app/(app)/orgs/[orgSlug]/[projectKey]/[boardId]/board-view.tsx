'use client';

/**
 * The Kanban board.
 *
 * Cards are dragged between and within columns with @dnd-kit. The drop is
 * applied to local state immediately and `placeTicket` is called in the
 * background; when the Server Action's `revalidatePath` lands, fresh props
 * overwrite the optimistic state. If the action fails, the board resnaps to the
 * server's ordering and an error is shown, so a rejected move can never look
 * like it succeeded.
 *
 * Accessibility is not sacrificed by dropping the old arrow buttons: dnd-kit's
 * KeyboardSensor makes every card draggable from the keyboard (Space to lift,
 * arrows to move, Space to drop, Escape to cancel), and the announcements below
 * describe each step to a screen reader.
 *
 * All user text is rendered as an escaped React child. React's raw-HTML escape
 * hatch is banned project-wide and is not used here.
 */

import { useEffect, useId, useMemo, useRef, useState, useTransition } from 'react';
import Link from 'next/link';
import {
  DndContext,
  DragOverlay,
  KeyboardSensor,
  PointerSensor,
  closestCorners,
  useDroppable,
  useSensor,
  useSensors,
  type Announcements,
  type DragEndEvent,
  type DragOverEvent,
  type DragStartEvent,
} from '@dnd-kit/core';
import {
  SortableContext,
  arrayMove,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';

import { FormError } from '@/components/ui';
import { createTicket, placeTicket } from './actions';

/* -------------------------------------------------------------------------- */
/* Props                                                                       */
/* -------------------------------------------------------------------------- */

export type BoardTicket = {
  id: string;
  number: number;
  title: string;
  assigneeName: string | null;
  commentCount: number;
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

/* -------------------------------------------------------------------------- */
/* Card                                                                        */
/* -------------------------------------------------------------------------- */

type CardBodyProps = {
  ticket: BoardTicket;
  projectKey: string;
  boardHref: string;
  dragging?: boolean;
};

function CardBody({ ticket, projectKey, boardHref, dragging = false }: CardBodyProps) {
  return (
    <div
      className={cx(
        'flex flex-col gap-2.5 rounded-lg border border-border bg-surface p-3',
        'shadow-xs transition-colors',
        dragging ? 'border-accent shadow-lg' : 'hover:border-border-secondary',
      )}
    >
      <Link
        href={`${boardHref}/${ticket.number}`}
        // Stop the pointer sensor claiming the click so the title still opens
        // the ticket; the rest of the card is the drag surface.
        onPointerDown={(event) => event.stopPropagation()}
        className="text-sm leading-snug font-medium text-foreground no-underline hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
      >
        {ticket.title}
      </Link>

      <div className="flex items-center gap-2 text-xs text-muted">
        <span className="font-mono tabular-nums">
          {projectKey}-{ticket.number}
        </span>

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

function SortableCard({ ticket, projectKey, boardHref }: CardBodyProps) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: ticket.id,
    data: { type: 'ticket' },
  });

  return (
    <li
      ref={setNodeRef}
      style={{ transform: CSS.Translate.toString(transform), transition }}
      className={cx('touch-none', isDragging && 'opacity-40')}
      {...attributes}
      {...listeners}
    >
      <CardBody ticket={ticket} projectKey={projectKey} boardHref={boardHref} />
    </li>
  );
}

/* -------------------------------------------------------------------------- */
/* Column                                                                      */
/* -------------------------------------------------------------------------- */

type ColumnProps = {
  column: BoardColumnData;
  boardId: string;
  boardHref: string;
  projectKey: string;
  isOver: boolean;
};

function Column({ column, boardId, boardHref, projectKey, isOver }: ColumnProps) {
  // Column-level droppable so an EMPTY column is still a valid drop target --
  // SortableContext alone gives nothing to aim at when there are no items.
  const { setNodeRef } = useDroppable({ id: column.id, data: { type: 'column' } });
  const ticketIds = useMemo(() => column.tickets.map((t) => t.id), [column.tickets]);

  return (
    <section
      className={cx(
        'flex w-72 shrink-0 flex-col rounded-xl border bg-surface-secondary/40 transition-colors',
        isOver ? 'border-accent bg-surface-secondary/70' : 'border-border',
      )}
      aria-label={column.name}
    >
      <header className="flex items-center gap-2 px-3 py-2.5">
        <h2 className="text-xs font-semibold tracking-wide text-muted uppercase">{column.name}</h2>
        <span className="rounded-full bg-surface-secondary px-1.5 text-xs text-muted tabular-nums">
          {column.tickets.length}
        </span>
      </header>

      <div ref={setNodeRef} className="flex min-h-24 flex-1 flex-col px-2 pb-2">
        <SortableContext items={ticketIds} strategy={verticalListSortingStrategy}>
          <ul className="flex flex-1 flex-col gap-2">
            {column.tickets.map((ticket) => (
              <SortableCard
                key={ticket.id}
                ticket={ticket}
                projectKey={projectKey}
                boardHref={boardHref}
              />
            ))}
          </ul>
        </SortableContext>

        {column.tickets.length === 0 ? (
          <p className="grid flex-1 place-items-center px-2 py-6 text-center text-xs text-muted">
            Drop a card here
          </p>
        ) : null}

        <AddCard boardId={boardId} column={column} />
      </div>
    </section>
  );
}

/* -------------------------------------------------------------------------- */
/* Add card                                                                    */
/* -------------------------------------------------------------------------- */

function AddCard({ boardId, column }: { boardId: string; column: BoardColumnData }) {
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  // Controlled: React 19 resets a form bound to an action once it settles,
  // regardless of the result, which would discard a rejected title.
  const [title, setTitle] = useState('');
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const fieldId = useId();

  function submit() {
    const value = title.trim();
    if (!value) return;
    const data = new FormData();
    data.set('boardId', boardId);
    data.set('columnId', column.id);
    data.set('title', value);

    startTransition(async () => {
      const result = await createTicket(null, data);
      if (result.ok) {
        setTitle('');
        setError(null);
        inputRef.current?.focus();
      } else {
        setError(result.error);
      }
    });
  }

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="mt-2 flex items-center gap-1.5 rounded-lg px-2 py-1.5 text-start text-sm text-muted transition-colors hover:bg-surface-secondary hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
      >
        <svg viewBox="0 0 16 16" fill="none" aria-hidden="true" className="size-4">
          <path
            d="M8 3.5v9M3.5 8h9"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
          />
        </svg>
        Add a card
      </button>
    );
  }

  return (
    <div className="mt-2 flex flex-col gap-2">
      <label className="sr-only" htmlFor={fieldId}>
        Add a card to {column.name}
      </label>
      <textarea
        id={fieldId}
        ref={inputRef}
        autoFocus
        rows={2}
        maxLength={200}
        value={title}
        onChange={(event) => setTitle(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && !event.shiftKey) {
            event.preventDefault();
            submit();
          }
          if (event.key === 'Escape') {
            setOpen(false);
            setTitle('');
            setError(null);
          }
        }}
        placeholder="What needs doing?"
        className="w-full resize-none rounded-lg border border-border bg-surface p-2.5 text-sm text-foreground placeholder:text-muted focus-visible:border-accent focus-visible:outline-none"
      />
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={submit}
          disabled={pending || title.trim().length === 0}
          className="rounded-lg bg-accent px-3 py-1.5 text-sm font-medium text-accent-foreground disabled:opacity-50"
        >
          {pending ? 'Adding…' : 'Add'}
        </button>
        <button
          type="button"
          onClick={() => {
            setOpen(false);
            setTitle('');
            setError(null);
          }}
          className="rounded-lg px-2 py-1.5 text-sm text-muted hover:text-foreground"
        >
          Cancel
        </button>
      </div>
      <FormError>{error}</FormError>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Board                                                                       */
/* -------------------------------------------------------------------------- */

export function BoardView({ boardId, boardHref, projectKey, columns }: BoardViewProps) {
  const [local, setLocal] = useState(columns);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [overColumnId, setOverColumnId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [, startTransition] = useTransition();

  // The server is the source of truth. When revalidation delivers new props,
  // drop the optimistic copy -- including after a failed move, which is what
  // makes a rejected drag snap back instead of lying.
  useEffect(() => {
    setLocal(columns);
  }, [columns]);

  const sensors = useSensors(
    // A small distance so a click on the card title is not swallowed as a drag.
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  const activeTicket = useMemo(() => {
    if (!activeId) return null;
    for (const column of local) {
      const found = column.tickets.find((t) => t.id === activeId);
      if (found) return found;
    }
    return null;
  }, [activeId, local]);

  function columnIdOf(id: string): string | null {
    if (local.some((column) => column.id === id)) return id;
    return local.find((column) => column.tickets.some((t) => t.id === id))?.id ?? null;
  }

  function handleDragStart(event: DragStartEvent) {
    setActiveId(String(event.active.id));
    setError(null);
  }

  function handleDragOver(event: DragOverEvent) {
    const { active, over } = event;
    if (!over) {
      setOverColumnId(null);
      return;
    }
    const from = columnIdOf(String(active.id));
    const to = columnIdOf(String(over.id));
    setOverColumnId(to);
    if (!from || !to || from === to) return;

    // Move across columns during the drag so the card follows the cursor into
    // its new column rather than snapping only on drop.
    setLocal((current) => {
      const source = current.find((c) => c.id === from);
      const target = current.find((c) => c.id === to);
      if (!source || !target) return current;
      const moved = source.tickets.find((t) => t.id === active.id);
      if (!moved) return current;

      const overIndex = target.tickets.findIndex((t) => t.id === over.id);
      const insertAt = overIndex === -1 ? target.tickets.length : overIndex;

      return current.map((column) => {
        if (column.id === from) {
          return { ...column, tickets: column.tickets.filter((t) => t.id !== active.id) };
        }
        if (column.id === to) {
          const next = column.tickets.slice();
          next.splice(insertAt, 0, moved);
          return { ...column, tickets: next };
        }
        return column;
      });
    });
  }

  function handleDragEnd(event: DragEndEvent) {
    const { active, over } = event;
    setActiveId(null);
    setOverColumnId(null);
    if (!over) return;

    const targetColumnId = columnIdOf(String(over.id));
    if (!targetColumnId) return;

    let toIndex = 0;
    setLocal((current) => {
      const target = current.find((c) => c.id === targetColumnId);
      if (!target) return current;

      const oldIndex = target.tickets.findIndex((t) => t.id === active.id);
      const overIndex = target.tickets.findIndex((t) => t.id === over.id);
      const newIndex = overIndex === -1 ? target.tickets.length - 1 : overIndex;

      if (oldIndex === -1) return current;
      toIndex = Math.max(0, newIndex);
      if (oldIndex === newIndex) return current;

      return current.map((column) =>
        column.id === targetColumnId
          ? { ...column, tickets: arrayMove(column.tickets, oldIndex, newIndex) }
          : column,
      );
    });

    startTransition(async () => {
      const result = await placeTicket({
        ticketId: String(active.id),
        toColumnId: targetColumnId,
        toIndex,
      });
      // On failure the effect above restores the server ordering on the next
      // revalidation; surface why so the snap-back is not mysterious.
      if (!result.ok) setError(result.error);
    });
  }

  const announcements: Announcements = {
    onDragStart: ({ active }) => `Picked up card ${String(active.id)}.`,
    onDragOver: ({ over }) => (over ? `Over ${String(over.id)}.` : 'No drop target.'),
    onDragEnd: ({ over }) => (over ? `Dropped on ${String(over.id)}.` : 'Drop cancelled.'),
    onDragCancel: () => 'Move cancelled, card returned to its original position.',
  };

  return (
    <div className="flex flex-col gap-3">
      <FormError>{error}</FormError>

      <DndContext
        sensors={sensors}
        collisionDetection={closestCorners}
        accessibility={{ announcements }}
        onDragStart={handleDragStart}
        onDragOver={handleDragOver}
        onDragEnd={handleDragEnd}
        onDragCancel={() => {
          setActiveId(null);
          setOverColumnId(null);
          setLocal(columns);
        }}
      >
        <div className="-mx-4 flex gap-3 overflow-x-auto px-4 pb-4 sm:-mx-6 sm:px-6">
          {local.map((column) => (
            <Column
              key={column.id}
              column={column}
              boardId={boardId}
              boardHref={boardHref}
              projectKey={projectKey}
              isOver={overColumnId === column.id}
            />
          ))}
        </div>

        <DragOverlay dropAnimation={null}>
          {activeTicket ? (
            <div className="w-72 rotate-2 cursor-grabbing">
              <CardBody
                ticket={activeTicket}
                projectKey={projectKey}
                boardHref={boardHref}
                dragging
              />
            </div>
          ) : null}
        </DragOverlay>
      </DndContext>
    </div>
  );
}
