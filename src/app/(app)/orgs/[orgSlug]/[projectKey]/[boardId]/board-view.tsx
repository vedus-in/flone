'use client';

/**
 * SPEC 5 "Board UI" -- the interactive shell of the Kanban board.
 *
 * Move buttons, not drag-and-drop. Each card carries two tiny forms whose SUBMIT
 * BUTTONS hold the destination in `name`/`value` -- plain HTML expressing N
 * destinations with no hidden-input duplication. `prev` / `next` are resolved on
 * the SERVER at render time from the column ordering; the client only echoes an
 * id that `moveTicket` re-vets against `ticket.boardId` anyway.
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
import { useActionState, useEffect, useRef } from 'react';
import { useFormStatus } from 'react-dom';

import { FormError, SubmitButton } from '@/components/ui';
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

type IconSubmitProps = {
  name: string;
  value: string;
  symbol: string;
  label: string;
  disabled?: boolean;
};

/**
 * Must be rendered INSIDE the `<form>` it belongs to -- `useFormStatus` reads the
 * nearest ancestor form. `data.get(name)` is what makes "only the pressed button
 * shows activity" possible without any client state.
 */
function IconSubmit({ name, value, symbol, label, disabled = false }: IconSubmitProps) {
  const { pending, data } = useFormStatus();
  const isActive = pending && data?.get(name) === value;

  return (
    <button
      type="submit"
      name={name}
      value={value}
      className="btn btn-ghost btn-sm btn-icon"
      disabled={disabled || pending}
      aria-label={label}
      title={label}
      aria-busy={isActive || undefined}
    >
      <span aria-hidden="true">{isActive ? '···' : symbol}</span>
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
    <li className="ticket">
      {/* The card body is an <a>; the move forms are SIBLINGS, never nested. */}
      <Link href={`${boardHref}/${ticket.number}`} className="ticket-title">
        {ticket.title}
      </Link>

      <div className="ticket-meta">
        <span className="mono">
          {projectKey}-{ticket.number}
        </span>
        <span>{ticket.assigneeName ?? 'Unassigned'}</span>
        {ticket.commentCount > 0 ? (
          <span>
            {ticket.commentCount} {ticket.commentCount === 1 ? 'comment' : 'comments'}
          </span>
        ) : null}
      </div>

      <div className="ticket-actions">
        <form action={moveAction} className="row">
          <input type="hidden" name="ticketId" value={ticket.id} />
          <IconSubmit
            name="toColumnId"
            value={previousColumn?.id ?? ''}
            symbol="←"
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
            symbol="→"
            label={
              nextColumn
                ? `Move "${ticket.title}" to ${nextColumn.name}`
                : `"${ticket.title}" is already in the last column`
            }
            disabled={nextColumn === null}
          />
        </form>

        <form action={reorderAction} className="row">
          <input type="hidden" name="ticketId" value={ticket.id} />
          <IconSubmit
            name="direction"
            value="up"
            symbol="↑"
            label={`Move "${ticket.title}" up`}
            disabled={isFirst}
          />
          <IconSubmit
            name="direction"
            value="down"
            symbol="↓"
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
  const formRef = useRef<HTMLFormElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const inputId = `add-ticket-${column.id}`;

  // Clear and refocus only on success. On failure the typed title stays in the
  // input, so a retry after a transient conflict costs no re-typing (SPEC 8.9).
  useEffect(() => {
    if (state?.ok) {
      formRef.current?.reset();
      inputRef.current?.focus();
    }
  }, [state]);

  return (
    <form ref={formRef} action={action} className="stack-sm">
      <input type="hidden" name="boardId" value={boardId} />
      <input type="hidden" name="columnId" value={column.id} />

      <label className="visually-hidden" htmlFor={inputId}>
        Add a card to {column.name}
      </label>
      <input
        id={inputId}
        ref={inputRef}
        className="input"
        name="title"
        placeholder="Add a card..."
        maxLength={200}
        required
        autoComplete="off"
        autoFocus={autoFocus}
      />

      <div className="row">
        <SubmitButton variant="secondary" size="sm" pendingLabel="Adding...">
          Add
        </SubmitButton>
      </div>

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
    <div className="board">
      {columns.map((column, columnIndex) => {
        const previousColumn = columnIndex > 0 ? columns[columnIndex - 1] : null;
        const nextColumn = columnIndex < columns.length - 1 ? columns[columnIndex + 1] : null;
        const headingId = `column-${column.id}`;

        return (
          <section key={column.id} className="column" aria-labelledby={headingId}>
            <div className="column-head">
              <h2 className="column-title" id={headingId}>
                {column.name}
              </h2>
              <span className="spacer" />
              <span className="badge" aria-label={`${column.tickets.length} tickets`}>
                {column.tickets.length}
              </span>
            </div>

            {column.tickets.length > 0 ? (
              <ol className="column-list">
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
            ) : boardHasTickets ? null : columnIndex === 0 ? (
              <p className="placeholder">Nothing here yet</p>
            ) : (
              <p className="faint">Empty</p>
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
  );
}
