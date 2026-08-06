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
 * multi-line text goes through `Prose` (`.pre-wrap`). There is no markdown
 * renderer, no autolinker and no use of React's raw-HTML escape hatch: the app
 * never constructs HTML from user input.
 *
 * Permission flags (`canManage`, `canDelete`) are computed on the SERVER and
 * passed down. They are politeness only -- every action re-checks the role.
 *
 * The two selects here stay NATIVE `<select>` elements wearing Untitled UI's field
 * styles. "Unassigned" submits the empty string, which is the exact value
 * `assignTicket`'s schema accepts to clear the assignee; a listbox keyed by a
 * blank id would be a wire-format change, and this file may not change wire
 * formats.
 */

import { useActionState, useEffect, useRef, useState, type ReactNode } from 'react';
import { Avatar } from '@/components/base/avatar/avatar';

import {
  Field,
  FormError,
  Input,
  Prose,
  Separator,
  SubmitButton,
  Textarea,
} from '@/components/ui';
import type { ActionResult } from '@/lib/result';
// Issue writes live at PROJECT scope now; only the comment actions are local.
import { assignIssue, boardIssue, deleteIssue, moveIssue, updateIssue } from '../../issue-actions';
import { createComment, deleteComment, updateComment } from './actions';

/* -------------------------------------------------------------------------- */
/* Shared shapes                                                               */
/* -------------------------------------------------------------------------- */

export type StateOption = { id: string; name: string };
export type MemberOption = { id: string; name: string };
export type BoardOption = { id: string; name: string };

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

function cx(...values: Array<string | false | null | undefined>): string {
  return values.filter(Boolean).join(' ');
}

function resultError(state: ActionResult | null): string | null {
  return state && !state.ok ? state.error : null;
}

function resultMessage(state: ActionResult | null): string | null {
  return state && state.ok && state.message ? state.message : null;
}

const NO_FIELD_ERRORS: Record<string, string> = {};

function fieldErrorsOf(state: ActionResult | null): Record<string, string> {
  return state && !state.ok && state.fieldErrors ? state.fieldErrors : NO_FIELD_ERRORS;
}

/**
 * `Array.from` rather than indexing: a name may begin with an astral character,
 * and `name[0]` would slice a surrogate pair in half.
 */
function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  const first = Array.from(parts[0])[0] ?? '';
  const last = parts.length > 1 ? (Array.from(parts[parts.length - 1])[0] ?? '') : '';
  return (first + last).toLocaleUpperCase();
}

/** Native `<select>` wearing Untitled UI's field styles, sized to match a `sm` button. */
const SELECT_CLASS =
  'h-9 w-full min-w-0 rounded-lg border border-primary bg-primary px-3 py-0 text-sm text-primary shadow-xs outline-focus-ring transition-colors hover:bg-primary_hover focus-visible:outline-2 focus-visible:outline-offset-2 md:h-8';

/* -------------------------------------------------------------------------- */
/* Disclosure                                                                  */
/* -------------------------------------------------------------------------- */

type CollapsibleProps = {
  summary: ReactNode;
  children: ReactNode;
  tone?: 'default' | 'danger';
  className?: string;
};

/**
 * A `<details>`, not a scripted disclosure: it is the accessible default, it
 * works before hydration, and the forms inside stay mounted when it closes so a
 * half-written edit is never thrown away.
 */
function Collapsible({ summary, children, tone = 'default', className }: CollapsibleProps) {
  return (
    <details className={cx('group', className)}>
      <summary
        className={cx(
          'flex w-fit cursor-pointer list-none items-center gap-1.5 rounded-md text-xs font-medium transition-colors',
          'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring',
          '[&::-webkit-details-marker]:hidden',
          tone === 'danger' ? 'text-error-primary' : 'text-tertiary hover:text-primary',
        )}
      >
        <svg
          viewBox="0 0 16 16"
          fill="none"
          aria-hidden="true"
          className="size-3 shrink-0 transition-transform group-open:rotate-90"
        >
          <path
            d="M6 3.5 10.5 8 6 12.5"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
        {summary}
      </summary>
      <div className="pt-3">{children}</div>
    </details>
  );
}

function StatusNote({ children }: { children: string | null }) {
  if (!children) return null;
  return (
    <span role="status" className="text-xs text-tertiary">
      {children}
    </span>
  );
}

/**
 * Purely decorative: the author's full name is rendered as real text right
 * beside it, so the initials are hidden from assistive technology rather than
 * announced twice.
 */
function Initials({ name, className }: { name: string; className?: string }) {
  return (
    // Untitled UI's `Avatar` takes a fixed prop list and does not spread the
    // rest, so `aria-hidden` goes on a wrapper rather than the component.
    <span aria-hidden="true" className={cx('mt-0.5 shrink-0', className)}>
      <Avatar size="xs" initials={initials(name)} contentClassName="text-xs" />
    </span>
  );
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
  const [state, action] = useActionState(updateIssue, null);
  const errors = fieldErrorsOf(state);

  return (
    <Collapsible summary="Edit title and description">
      <form action={action} className="flex flex-col gap-4">
        <input type="hidden" name="ticketId" value={ticketId} />

        <Field htmlFor="ticket-title" label="Title" error={errors.title}>
          <Input
            id="ticket-title"
            name="title"
            defaultValue={title}
            maxLength={200}
            required
            autoComplete="off"
          />
        </Field>

        <Field
          htmlFor="ticket-description"
          label="Description"
          hint="Plain text. Line breaks are kept."
          error={errors.description}
        >
          <Textarea
            id="ticket-description"
            name="description"
            defaultValue={description}
            maxLength={10000}
            rows={8}
            placeholder="What needs to happen?"
          />
        </Field>

        <div className="flex flex-wrap items-center gap-3">
          <SubmitButton size="sm" pendingLabel="Saving...">
            Save changes
          </SubmitButton>
          <StatusNote>{resultMessage(state)}</StatusNote>
        </div>

        <FormError>{resultError(state)}</FormError>
      </form>
    </Collapsible>
  );
}

/* -------------------------------------------------------------------------- */
/* Status                                                                      */
/* -------------------------------------------------------------------------- */

type TicketStateFormProps = {
  ticketId: string;
  stateId: string;
  states: StateOption[];
};

/**
 * The issue's status.
 *
 * These are the PROJECT's workflow states, not a board's columns -- an issue has
 * exactly one status wherever it is looked at from, which is why this control
 * exists on an issue that is on no board at all.
 */
export function TicketStateForm({ ticketId, stateId, states }: TicketStateFormProps) {
  const [state, action] = useActionState(moveIssue, null);

  return (
    <form action={action} className="flex flex-col gap-2">
      <input type="hidden" name="ticketId" value={ticketId} />

      <Field htmlFor="ticket-state" label="Status">
        <div className="flex items-center gap-2">
          <select
            id="ticket-state"
            className={SELECT_CLASS}
            name="toStateId"
            defaultValue={stateId}
          >
            {states.map((option) => (
              <option key={option.id} value={option.id}>
                {option.name}
              </option>
            ))}
          </select>
          <SubmitButton color="secondary" size="sm" pendingLabel="Moving...">
            Move
          </SubmitButton>
        </div>
      </Field>

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
  const [state, action] = useActionState(assignIssue, null);

  return (
    <form action={action} className="flex flex-col gap-2">
      <input type="hidden" name="ticketId" value={ticketId} />

      <Field htmlFor="ticket-assignee" label="Assignee">
        <div className="flex items-center gap-2">
          <select
            id="ticket-assignee"
            className={SELECT_CLASS}
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
          <SubmitButton color="secondary" size="sm" pendingLabel="Saving...">
            Save
          </SubmitButton>
        </div>
      </Field>

      <StatusNote>{resultMessage(state)}</StatusNote>

      <FormError>{resultError(state)}</FormError>
    </form>
  );
}

/* -------------------------------------------------------------------------- */
/* Board                                                                       */
/* -------------------------------------------------------------------------- */

type TicketBoardFormProps = {
  ticketId: string;
  boardId: string | null;
  boards: BoardOption[];
};

/**
 * Which board the issue is filed under, or none.
 *
 * The board card menu could already do this; the issue page could not, which
 * left an issue on no board -- or on the wrong one -- with nowhere to fix it.
 * "No board" submits the empty string, the exact value `setIssueBoard` accepts
 * to clear the field.
 */
export function TicketBoardForm({ ticketId, boardId, boards }: TicketBoardFormProps) {
  const [state, action] = useActionState(boardIssue, null);

  return (
    <form action={action} className="flex flex-col gap-2">
      <input type="hidden" name="ticketId" value={ticketId} />

      <Field htmlFor="ticket-board" label="Board">
        <div className="flex items-center gap-2">
          <select id="ticket-board" className={SELECT_CLASS} name="boardId" defaultValue={boardId ?? ''}>
            <option value="">No board</option>
            {boards.map((board) => (
              <option key={board.id} value={board.id}>
                {board.name}
              </option>
            ))}
          </select>
          <SubmitButton color="secondary" size="sm" pendingLabel="Saving...">
            Save
          </SubmitButton>
        </div>
      </Field>

      <StatusNote>{resultMessage(state)}</StatusNote>

      <FormError>{resultError(state)}</FormError>
    </form>
  );
}

/* -------------------------------------------------------------------------- */
/* Delete ticket                                                               */
/* -------------------------------------------------------------------------- */

export function TicketDeleteForm({ ticketId }: { ticketId: string }) {
  const [state, action] = useActionState(deleteIssue, null);

  return (
    <Collapsible summary="Delete this issue" tone="danger">
      <form action={action} className="flex flex-col gap-3">
        <input type="hidden" name="ticketId" value={ticketId} />
        <p className="text-sm text-tertiary">
          This permanently deletes the issue and all of its comments. Any sub-issues survive and
          simply lose their parent. This cannot be undone.
        </p>
        <div className="flex">
          <SubmitButton color="primary-destructive" size="sm" pendingLabel="Deleting...">
            Yes, delete this issue
          </SubmitButton>
        </div>
        <FormError>{resultError(state)}</FormError>
      </form>
    </Collapsible>
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
    <li className="flex gap-3">
      <Initials name={comment.authorName} />

      <div className="flex min-w-0 flex-1 flex-col gap-1.5">
        <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
          <span className="text-sm font-medium text-primary">{comment.authorName}</span>
          <time className="text-xs text-tertiary" dateTime={comment.createdAtIso}>
            {comment.createdAtLabel}
          </time>
          {comment.edited ? <span className="text-xs text-tertiary">edited</span> : null}
        </div>

        <Prose>{comment.body}</Prose>

        {comment.canManage ? (
          <Collapsible summary="Edit or delete" className="pt-0.5">
            <div className="flex flex-col gap-4">
              <form action={updateAction} className="flex flex-col gap-2">
                <input type="hidden" name="commentId" value={comment.id} />
                <label className="visually-hidden" htmlFor={bodyId}>
                  Edit comment
                </label>
                <Textarea
                  id={bodyId}
                  name="body"
                  defaultValue={comment.body}
                  maxLength={5000}
                  rows={4}
                  required
                />
                <div className="flex flex-wrap items-center gap-3">
                  <SubmitButton color="secondary" size="sm" pendingLabel="Saving...">
                    Save comment
                  </SubmitButton>
                  <StatusNote>{resultMessage(updateState)}</StatusNote>
                </div>
                <FormError>{resultError(updateState)}</FormError>
              </form>

              <form action={deleteAction} className="flex flex-col gap-2">
                <input type="hidden" name="commentId" value={comment.id} />
                <div className="flex">
                  <SubmitButton color="secondary-destructive" size="sm" pendingLabel="Deleting...">
                    Delete comment
                  </SubmitButton>
                </div>
                <FormError>{resultError(deleteState)}</FormError>
              </form>
            </div>
          </Collapsible>
        ) : null}
      </div>
    </li>
  );
}

type CommentThreadProps = {
  ticketId: string;
  comments: CommentItem[];
  /** The signed-in member's name, for the composer's avatar. Display only. */
  currentUserName: string;
};

export function CommentThread({ ticketId, comments, currentUserName }: CommentThreadProps) {
  const [state, action] = useActionState(createComment, null);
  const bodyRef = useRef<HTMLTextAreaElement>(null);

  // Controlled, deliberately. React 19 resets a `<form action={fn}>` after the
  // action settles regardless of what it resolved to, so an uncontrolled
  // textarea loses the whole draft on a failed submit -- exactly when the user
  // most needs it back. Holding the value in state survives that reset; we
  // clear it ourselves only once the server confirms the comment landed.
  const [body, setBody] = useState('');

  useEffect(() => {
    if (state?.ok) {
      setBody('');
      bodyRef.current?.focus();
    }
  }, [state]);

  return (
    <div className="flex flex-col gap-6">
      {comments.length > 0 ? (
        <ol className="flex flex-col gap-6">
          {comments.map((comment) => (
            <CommentRow key={comment.id} comment={comment} />
          ))}
        </ol>
      ) : (
        <p className="text-sm text-tertiary">No comments yet. Start the conversation below.</p>
      )}

      <Separator />

      <form action={action} className="flex gap-3">
        <Initials name={currentUserName} className="max-sm:hidden" />

        <div className="flex min-w-0 flex-1 flex-col gap-2">
          <input type="hidden" name="ticketId" value={ticketId} />
          <label className="visually-hidden" htmlFor="new-comment">
            Add a comment
          </label>
          <Textarea
            id="new-comment"
            ref={bodyRef}
            name="body"
            maxLength={5000}
            rows={3}
            required
            placeholder="Write a comment..."
            value={body}
            onChange={(event) => setBody(event.target.value)}
          />
          <div className="flex justify-end">
            <SubmitButton size="sm" pendingLabel="Posting...">
              Comment
            </SubmitButton>
          </div>
          <FormError>{resultError(state)}</FormError>
        </div>
      </form>
    </div>
  );
}
