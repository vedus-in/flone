'use client';

/**
 * The comment thread plus the ticket's delete disclosure -- the parts of the
 * route that still submit through `<form action>`. They live together because
 * each needs `useActionState` (React's `<form action>` prop rejects
 * value-returning functions, and every Server Action here returns an
 * `ActionResult`). The inline title/description editors and the properties
 * sidebar live in `properties.tsx`.
 *
 * `useFormStatus` -- via `SubmitButton` -- is the only pending primitive: no
 * `useTransition`, no `useOptimistic` (SPEC 7.11). Disabling while pending is
 * also the double-submit guard.
 *
 * Every piece of user text below is rendered as an escaped React child, and
 * multi-line text goes through `Prose`, which renders it as Markdown. That
 * renderer builds React elements and drops raw HTML rather than parsing it, so
 * React's raw-HTML escape hatch is still unused here: the app never constructs
 * HTML from user input.
 *
 * Permission flags (`canManage`, `canDelete`) are computed on the SERVER and
 * passed down. They are politeness only -- every action re-checks the role.
 */

import { useActionState, useEffect, useRef, useState, type ReactNode } from 'react';
import { Avatar } from '@/components/base/avatar/avatar';

import { FormError, Prose, Separator, SubmitButton, Textarea } from '@/components/ui';
import type { ActionResult } from '@/lib/result';
// Issue writes live at PROJECT scope now; only the comment actions are local.
import { deleteIssue } from '../../issue-actions';
import { createComment, deleteComment, updateComment } from './actions';

/* -------------------------------------------------------------------------- */
/* Shared shapes                                                               */
/* -------------------------------------------------------------------------- */

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
