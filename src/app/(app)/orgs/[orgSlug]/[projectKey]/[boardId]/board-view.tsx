'use client';

/**
 * SPEC 5 "Board UI" -- the interactive shell of the Kanban board, rebuilt on
 * HeroUI v3.
 *
 * Move buttons, not drag-and-drop. Each card carries two tiny forms whose SUBMIT
 * BUTTONS hold the destination in `name`/`value` -- plain HTML expressing N
 * destinations with no hidden-input duplication. `prev` / `next` are resolved on
 * the SERVER at render time from the column ordering; the client only echoes an
 * id that `moveTicket` re-vets against `ticket.boardId` anyway.
 *
 * Those controls stay NATIVE `<button type="submit" name value>` elements
 * wearing HeroUI's button styles via `buttonVariants()`. That is deliberate: the
 * whole mechanism depends on the pressed button being the form's *submitter*, so
 * that `useFormStatus().data` contains its name/value pair. A component that
 * re-implements press handling could break that contract silently, and the
 * styles are the only thing this redesign needed from HeroUI here.
 *
 * `useFormStatus()` is the only pending primitive (SPEC 7.11): no
 * `useTransition`, no `useOptimistic`. Its `data` field identifies which button
 * was pressed, so exactly the pressed control shows activity while all of them
 * disable -- which is also the double-submit guard.
 *
 * All user text is rendered as an escaped React child; React's raw-HTML escape
 * hatch is banned project-wide and is not used here.
 */

import Link from 'next/link';
import { useActionState, useEffect, useRef, useState, type ReactNode } from 'react';
import { useFormStatus } from 'react-dom';
import {
  IconChevronDown,
  IconChevronLeft,
  IconChevronRight,
  IconChevronUp,
  IconPlus,
  Input,
  ScrollShadow,
  Spinner,
  buttonVariants,
} from '@heroui/react';

import { Badge, FormError, SubmitButton } from '@/components/ui';
import type { ActionResult } from '@/lib/result';
import { createTicket, moveTicket, reorderTicket } from './actions';

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

/* -------------------------------------------------------------------------- */
/* Small shared pieces                                                         */
/* -------------------------------------------------------------------------- */

function firstError(...states: Array<ActionResult | null>): string | null {
  for (const state of states) {
    if (state && !state.ok) return state.error;
  }
  return null;
}

/** Compact icon button, sized down from HeroUI's `sm` so a card stays dense. */
const ICON_BUTTON = buttonVariants({
  variant: 'ghost',
  size: 'sm',
  isIconOnly: true,
  className: 'size-7 md:size-7',
});

type IconSubmitProps = {
  name: string;
  value: string;
  icon: ReactNode;
  label: string;
  disabled?: boolean;
};

/**
 * Must be rendered INSIDE the `<form>` it belongs to -- `useFormStatus` reads the
 * nearest ancestor form. `data.get(name)` is what makes "only the pressed button
 * shows activity" possible without any client state.
 */
function IconSubmit({ name, value, icon, label, disabled = false }: IconSubmitProps) {
  const { pending, data } = useFormStatus();
  const isActive = pending && data?.get(name) === value;

  return (
    <button
      type="submit"
      name={name}
      value={value}
      className={ICON_BUTTON}
      disabled={disabled || pending}
      aria-label={label}
      title={label}
      aria-busy={isActive || undefined}
    >
      {isActive ? <Spinner size="sm" color="current" aria-hidden="true" /> : icon}
    </button>
  );
}

/* -------------------------------------------------------------------------- */
/* Ticket card                                                                 */
/* -------------------------------------------------------------------------- */

type TicketCardProps = {
  ticket: BoardTicket;
  boardHref: string;
  projectKey: string;
  previousColumn: BoardColumnData | null;
  nextColumn: BoardColumnData | null;
  isFirst: boolean;
  isLast: boolean;
};

function TicketCard({
  ticket,
  boardHref,
  projectKey,
  previousColumn,
  nextColumn,
  isFirst,
  isLast,
}: TicketCardProps) {
  const [moveState, moveAction] = useActionState(moveTicket, null);
  const [reorderState, reorderAction] = useActionState(reorderTicket, null);
  const error = firstError(moveState, reorderState);

  return (
    <li className="flex flex-col gap-2 rounded-xl border border-border bg-surface-secondary p-3 transition-colors hover:border-border-secondary">
      {/* The card body is an <a>; the move forms are SIBLINGS, never nested. */}
      <Link
        href={`${boardHref}/${ticket.number}`}
        className="rounded-sm text-sm leading-snug font-medium text-foreground no-underline hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
      >
        {ticket.title}
      </Link>

      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted">
        <span className="font-mono tabular-nums">
          {projectKey}-{ticket.number}
        </span>
        <span aria-hidden="true" className="opacity-50">
          &middot;
        </span>
        <span className="min-w-0 truncate">{ticket.assigneeName ?? 'Unassigned'}</span>
        {ticket.commentCount > 0 ? (
          <>
            <span aria-hidden="true" className="opacity-50">
              &middot;
            </span>
            <span className="tabular-nums">
              {ticket.commentCount} {ticket.commentCount === 1 ? 'comment' : 'comments'}
            </span>
          </>
        ) : null}
      </div>

      <div className="flex items-center justify-between gap-1">
        <form action={moveAction} className="flex items-center gap-0.5">
          <input type="hidden" name="ticketId" value={ticket.id} />
          <IconSubmit
            name="toColumnId"
            value={previousColumn?.id ?? ''}
            icon={<IconChevronLeft />}
            label={
              previousColumn
                ? `Move "${ticket.title}" to ${previousColumn.name}`
                : `"${ticket.title}" is already in the first column`
            }
            disabled={previousColumn === null}
          />
          <IconSubmit
            name="toColumnId"
            value={nextColumn?.id ?? ''}
            icon={<IconChevronRight />}
            label={
              nextColumn
                ? `Move "${ticket.title}" to ${nextColumn.name}`
                : `"${ticket.title}" is already in the last column`
            }
            disabled={nextColumn === null}
          />
        </form>

        <form action={reorderAction} className="flex items-center gap-0.5">
          <input type="hidden" name="ticketId" value={ticket.id} />
          <IconSubmit
            name="direction"
            value="up"
            icon={<IconChevronUp />}
            label={`Move "${ticket.title}" up`}
            disabled={isFirst}
          />
          <IconSubmit
            name="direction"
            value="down"
            icon={<IconChevronDown />}
            label={`Move "${ticket.title}" down`}
            disabled={isLast}
          />
        </form>
      </div>

      <FormError>{error}</FormError>
    </li>
  );
}

/* -------------------------------------------------------------------------- */
/* Add-a-card form                                                             */
/* -------------------------------------------------------------------------- */

type AddTicketFormProps = {
  boardId: string;
  column: BoardColumnData;
  autoFocus: boolean;
};

function AddTicketForm({ boardId, column, autoFocus }: AddTicketFormProps) {
  const [state, action] = useActionState(createTicket, null);
  const inputRef = useRef<HTMLInputElement>(null);
  const inputId = `add-ticket-${column.id}`;

  // Controlled so the typed title survives a failed submit. React 19 resets a
  // `<form action={fn}>` once the action settles whether it succeeded or not,
  // so `form.reset()` guarded by `state.ok` cannot deliver the SPEC 8.9
  // promise on its own -- only holding the value in state can.
  const [title, setTitle] = useState('');

  useEffect(() => {
    if (state?.ok) {
      setTitle('');
      inputRef.current?.focus();
    }
  }, [state]);

  return (
    <form action={action} className="flex flex-col gap-2">
      <input type="hidden" name="boardId" value={boardId} />
      <input type="hidden" name="columnId" value={column.id} />

      <label className="visually-hidden" htmlFor={inputId}>
        Add a card to {column.name}
      </label>
      <Input
        id={inputId}
        ref={inputRef}
        name="title"
        placeholder="Add a card..."
        maxLength={200}
        required
        autoComplete="off"
        autoFocus={autoFocus}
        value={title}
        onChange={(event) => setTitle(event.target.value)}
        fullWidth
      />

      <SubmitButton variant="ghost" size="sm" fullWidth pendingLabel="Adding...">
        <IconPlus />
        Add card
      </SubmitButton>

      {state && !state.ok ? <FormError>{state.error}</FormError> : null}
    </form>
  );
}

/* -------------------------------------------------------------------------- */
/* Board                                                                       */
/* -------------------------------------------------------------------------- */

export function BoardView({ boardId, boardHref, projectKey, columns }: BoardViewProps) {
  const boardHasTickets = columns.some((column) => column.tickets.length > 0);

  return (
    /*
     * `orientation="horizontal"` is what gives ScrollShadow its `overflow-x`
     * plus the edge fade that tells you there is more board off-screen. The
     * negative margin lets focus rings on the outermost cards breathe without
     * being clipped by that same overflow.
     */
    <ScrollShadow orientation="horizontal" className="-mx-1 px-1 py-1">
      <div className="flex items-start gap-4">
        {columns.map((column, columnIndex) => {
          const previousColumn = columnIndex > 0 ? columns[columnIndex - 1] : null;
          const nextColumn = columnIndex < columns.length - 1 ? columns[columnIndex + 1] : null;
          const headingId = `column-${column.id}`;

          return (
            <section
              key={column.id}
              aria-labelledby={headingId}
              className="flex w-72 shrink-0 flex-col gap-3 rounded-2xl border border-border bg-surface p-3 sm:w-80"
            >
              <div className="flex items-center gap-2 px-1">
                <h2 id={headingId} className="text-sm font-medium text-foreground">
                  {column.name}
                </h2>
                <Badge className="tabular-nums">{column.tickets.length}</Badge>
                <span className="visually-hidden">
                  {column.tickets.length === 1 ? 'ticket' : 'tickets'}
                </span>
              </div>

              {column.tickets.length > 0 ? (
                <ol className="flex flex-col gap-2">
                  {column.tickets.map((ticket, ticketIndex) => (
                    <TicketCard
                      key={ticket.id}
                      ticket={ticket}
                      boardHref={boardHref}
                      projectKey={projectKey}
                      previousColumn={previousColumn}
                      nextColumn={nextColumn}
                      isFirst={ticketIndex === 0}
                      isLast={ticketIndex === column.tickets.length - 1}
                    />
                  ))}
                </ol>
              ) : (
                <p className="rounded-xl border border-dashed border-border px-3 py-6 text-center text-xs text-muted">
                  {boardHasTickets ? 'Nothing in this column' : 'No cards yet'}
                </p>
              )}

              <AddTicketForm
                boardId={boardId}
                column={column}
                autoFocus={columnIndex === 0 && !boardHasTickets}
              />
            </section>
          );
        })}
      </div>
    </ScrollShadow>
  );
}
