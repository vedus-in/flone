'use client';

/**
 * The single `'use client'` island for the ticket route: the comment thread plus
 * the ticket's small edit forms. They live together because each one needs
 * `useActionState` (React's `<form action>` prop rejects value-returning
 * functions, and every Server Action here returns an `ActionResult`), and
 * keeping them in one module keeps the route's client bundle to one file.
 *
 * `useFormStatus` -- via `SubmitButton` -- is the only pending primitive: no
 * `useTransition`, no `useOptimistic` (SPEC 7.11). Disabling while pending is
 * also the double-submit guard.
 *
 * Every piece of user text below is rendered as an escaped React child, and
 * multi-line text goes through `.prose` (`white-space: pre-wrap`). There is no
 * markdown renderer, no autolinker and no use of React's raw-HTML escape hatch:
 * the app never constructs HTML from user input.
 *
 * Permission flags (`canManage`, `canDelete`) are computed on the SERVER and
 * passed down. They are politeness only -- every action re-checks the role.
 */

import { useActionState, useEffect, useRef } from 'react';

import { FormError, Prose, SubmitButton } from '@/components/ui';
import type { ActionResult } from '@/lib/result';
import { moveTicket } from '../actions';
import {
  assignTicket,
  createComment,
  deleteComment,
  deleteTicket,
  updateComment,
  updateTicket,
} from './actions';

/* -------------------------------------------------------------------------- */
/* Shared shapes                                                               */
/* -------------------------------------------------------------------------- */

export type ColumnOption = { id: string; name: string };
export type MemberOption = { id: string; name: string };

export type CommentItem = {
  id: string;
  body: string;
  authorName: string;
  /** Pre-formatted on the server so the client never re-derives a locale. */
  createdAtLabel: string;
  createdAtIso: string;
  edited: boolean;
  /** Author, or ADMIN/OWNER. Re-checked server-side on every action. */
  canManage: boolean;
};

function resultError(state: ActionResult | null): string | null {
  return state && !state.ok ? state.error : null;
}

function resultMessage(state: ActionResult | null): string | null {
  return state && state.ok && state.message ? state.message : null;
}

/* -------------------------------------------------------------------------- */
/* Ticket edit                                                                 */
/* -------------------------------------------------------------------------- */

type TicketEditFormProps = {
  ticketId: string;
  title: string;
  description: string;
};

export function TicketEditForm({ ticketId, title, description }: TicketEditFormProps) {
  const [state, action] = useActionState(updateTicket, null);

  return (
    <form action={action} className="stack">
      <input type="hidden" name="ticketId" value={ticketId} />

      <div className="field">
        <label className="label" htmlFor="ticket-title">
          Title
        </label>
        <input
          id="ticket-title"
          className="input"
          name="title"
          defaultValue={title}
          maxLength={200}
          required
          autoComplete="off"
        />
      </div>

      <div className="field">
        <label className="label" htmlFor="ticket-description">
          Description
        </label>
        <textarea
          id="ticket-description"
          className="textarea"
          name="description"
          defaultValue={description}
          maxLength={10000}
          placeholder="What needs to happen?"
        />
      </div>

      <div className="row">
        <SubmitButton pendingLabel="Saving...">Save changes</SubmitButton>
        {resultMessage(state) ? <span className="faint">{resultMessage(state)}</span> : null}
      </div>

      <FormError>{resultError(state)}</FormError>
    </form>
  );
}

/* -------------------------------------------------------------------------- */
/* Column (move)                                                               */
/* -------------------------------------------------------------------------- */

type TicketMoveFormProps = {
  ticketId: string;
  columnId: string;
  columns: ColumnOption[];
};

export function TicketMoveForm({ ticketId, columnId, columns }: TicketMoveFormProps) {
  const [state, action] = useActionState(moveTicket, null);

  return (
    <form action={action} className="stack-sm">
      <input type="hidden" name="ticketId" value={ticketId} />

      <div className="field">
        <label className="label" htmlFor="ticket-column">
          Column
        </label>
        <select id="ticket-column" className="select" name="toColumnId" defaultValue={columnId}>
          {columns.map((column) => (
            <option key={column.id} value={column.id}>
              {column.name}
            </option>
          ))}
        </select>
      </div>

      <div className="row">
        <SubmitButton variant="secondary" size="sm" pendingLabel="Moving...">
          Move
        </SubmitButton>
      </div>

      <FormError>{resultError(state)}</FormError>
    </form>
  );
}

/* -------------------------------------------------------------------------- */
/* Assignee                                                                    */
/* -------------------------------------------------------------------------- */

type TicketAssignFormProps = {
  ticketId: string;
  assigneeId: string | null;
  members: MemberOption[];
};

export function TicketAssignForm({ ticketId, assigneeId, members }: TicketAssignFormProps) {
  const [state, action] = useActionState(assignTicket, null);

  return (
    <form action={action} className="stack-sm">
      <input type="hidden" name="ticketId" value={ticketId} />

      <div className="field">
        <label className="label" htmlFor="ticket-assignee">
          Assignee
        </label>
        <select
          id="ticket-assignee"
          className="select"
          name="assigneeId"
          defaultValue={assigneeId ?? ''}
        >
          <option value="">Unassigned</option>
          {members.map((member) => (
            <option key={member.id} value={member.id}>
              {member.name}
            </option>
          ))}
        </select>
      </div>

      <div className="row">
        <SubmitButton variant="secondary" size="sm" pendingLabel="Saving...">
          Save
        </SubmitButton>
      </div>

      <FormError>{resultError(state)}</FormError>
    </form>
  );
}

/* -------------------------------------------------------------------------- */
/* Delete ticket                                                               */
/* -------------------------------------------------------------------------- */

export function TicketDeleteForm({ ticketId }: { ticketId: string }) {
  const [state, action] = useActionState(deleteTicket, null);

  return (
    <details>
      <summary>Delete this ticket</summary>
      <form action={action} className="stack-sm">
        <input type="hidden" name="ticketId" value={ticketId} />
        <p className="muted">
          This permanently deletes the ticket and all of its comments. This cannot be undone.
        </p>
        <div className="row">
          <SubmitButton variant="danger" pendingLabel="Deleting...">
            Yes, delete this ticket
          </SubmitButton>
        </div>
        <FormError>{resultError(state)}</FormError>
      </form>
    </details>
  );
}

/* -------------------------------------------------------------------------- */
/* Comments                                                                    */
/* -------------------------------------------------------------------------- */

function CommentRow({ comment }: { comment: CommentItem }) {
  const [updateState, updateAction] = useActionState(updateComment, null);
  const [deleteState, deleteAction] = useActionState(deleteComment, null);

  const bodyId = `comment-body-${comment.id}`;

  return (
    <li className="comment">
      <div className="comment-head">
        <span className="comment-author">{comment.authorName}</span>
        <time className="faint" dateTime={comment.createdAtIso}>
          {comment.createdAtLabel}
        </time>
        {comment.edited ? <span className="faint">edited</span> : null}
      </div>

      <Prose>{comment.body}</Prose>

      {comment.canManage ? (
        <details>
          <summary>Edit or delete</summary>
          <div className="stack">
            <form action={updateAction} className="stack-sm">
              <input type="hidden" name="commentId" value={comment.id} />
              <label className="visually-hidden" htmlFor={bodyId}>
                Edit comment
              </label>
              <textarea
                id={bodyId}
                className="textarea"
                name="body"
                defaultValue={comment.body}
                maxLength={5000}
                required
              />
              <div className="row">
                <SubmitButton variant="secondary" size="sm" pendingLabel="Saving...">
                  Save comment
                </SubmitButton>
              </div>
              <FormError>{resultError(updateState)}</FormError>
            </form>

            <form action={deleteAction}>
              <input type="hidden" name="commentId" value={comment.id} />
              <SubmitButton variant="danger" size="sm" pendingLabel="Deleting...">
                Delete comment
              </SubmitButton>
              <FormError>{resultError(deleteState)}</FormError>
            </form>
          </div>
        </details>
      ) : null}
    </li>
  );
}

type CommentThreadProps = {
  ticketId: string;
  comments: CommentItem[];
};

export function CommentThread({ ticketId, comments }: CommentThreadProps) {
  const [state, action] = useActionState(createComment, null);
  const formRef = useRef<HTMLFormElement>(null);
  const bodyRef = useRef<HTMLTextAreaElement>(null);

  // Clear and refocus only on success; on failure the typed text stays put.
  useEffect(() => {
    if (state?.ok) {
      formRef.current?.reset();
      bodyRef.current?.focus();
    }
  }, [state]);

  return (
    <div className="stack">
      {comments.length > 0 ? (
        <ul className="column-list">
          {comments.map((comment) => (
            <CommentRow key={comment.id} comment={comment} />
          ))}
        </ul>
      ) : (
        <p className="muted">No comments yet.</p>
      )}

      <form ref={formRef} action={action} className="stack-sm">
        <input type="hidden" name="ticketId" value={ticketId} />
        <label className="label" htmlFor="new-comment">
          Add a comment
        </label>
        <textarea
          id="new-comment"
          ref={bodyRef}
          className="textarea"
          name="body"
          maxLength={5000}
          required
          placeholder="Write a comment..."
        />
        <div className="row">
          <SubmitButton pendingLabel="Posting...">Comment</SubmitButton>
        </div>
        <FormError>{resultError(state)}</FormError>
      </form>
    </div>
  );
}
