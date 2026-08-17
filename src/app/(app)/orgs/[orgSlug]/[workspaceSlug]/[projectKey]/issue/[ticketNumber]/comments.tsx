'use client';

/**
 * The comment thread plus the ticket's delete disclosure.
 *
 * Two things here are worth knowing before editing it:
 *
 * EDITING IS IN PLACE. A comment renders as text until its author presses Edit,
 * and then the SAME BLOCK becomes a textarea -- no dialog, no second copy of the
 * comment sitting open underneath the first. Ctrl/Cmd+Enter or Save commits,
 * Escape reverts, exactly as the title and description editors in
 * `properties.tsx` behave. Those editors call their Server Action inside a
 * transition rather than through `<form action>`; this file now does the same
 * for the comment editor and for delete, because React 19 resets a
 * `<form action>` when the action settles and an inline editor that snaps back
 * to the old text on save is worse than no inline editor. The composer is still
 * a real `<form action>` with `useFormStatus` -- it posts and clears, which is
 * exactly what that pattern is good at.
 *
 * @MENTIONS ARE PLAIN TEXT. Typing `@` opens a member list; picking someone
 * inserts the literal text `@Their Name` into the body. There is no mention
 * record and no id in the body -- `src/lib/mentions.ts` re-derives who was
 * tagged from the stored text, both for the highlight below and for the email
 * the action sends. The list here is a convenience for typing it correctly;
 * nothing about who gets mailed is decided in the browser.
 *
 * Every piece of user text is rendered as an escaped React child, and multi-line
 * text goes through `Prose`, which renders it as Markdown. That renderer builds
 * React elements and drops raw HTML rather than parsing it, so React's raw-HTML
 * escape hatch is still unused here: the app never constructs HTML from user
 * input.
 *
 * Permission flags (`canManage`, `canDelete`) are computed on the SERVER and
 * passed down. They are politeness only -- every action re-checks the role.
 */

import {
  useActionState,
  useEffect,
  useMemo,
  useRef,
  useState,
  useTransition,
  type ComponentProps,
  type KeyboardEvent,
  type ReactNode,
  type RefObject,
} from 'react';
import { Avatar } from '@/components/base/avatar/avatar';

import { AttachImageButton, useImageAttach } from '@/components/image-attach';
import { Button, FormError, Prose, Separator, SubmitButton, Textarea } from '@/components/ui';
import type { ActionResult } from '@/lib/result';
import { cx } from '@/lib/utils/cx';
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

/** Everyone in the organization -- the people a mention may name. */
export type Member = { id: string; name: string };

function resultError(state: ActionResult | null): string | null {
  return state && !state.ok ? state.error : null;
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

/** One `FormData` shape for both comment actions; body is omitted for delete. */
function commentPayload(commentId: string, body?: string): FormData {
  const data = new FormData();
  data.set('commentId', commentId);
  if (body !== undefined) data.set('body', body);
  return data;
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
 * works before hydration, and the form inside stays mounted when it closes.
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
/* Mention typeahead                                                           */
/* -------------------------------------------------------------------------- */

/**
 * The text between the last `@` and the caret. `[^\n@]` stops it running past a
 * previous mention or onto another line, and the leading `(?:^|\s)` is what
 * keeps an email address in the body from opening the list.
 *
 * Names contain spaces, so the query may too -- "Dana R" still finds
 * "Dana Reed". A query that matches nobody simply closes the list, which is how
 * it gets out of the way once a sentence continues past the mention.
 */
const MENTION_QUERY = /(?:^|\s)@([^\n@]{0,40})$/;
const MAX_SUGGESTIONS = 6;

type MentionState = { anchor: number; query: string };

type MentionTextareaProps = Omit<
  ComponentProps<typeof Textarea>,
  'value' | 'onChange' | 'ref'
> & {
  value: string;
  onValueChange: (next: string) => void;
  members: Member[];
  /** Passed straight through as the textarea's ref, so callers can focus it. */
  textareaRef?: RefObject<HTMLTextAreaElement | null>;
  onKeyDown?: (event: KeyboardEvent<HTMLTextAreaElement>) => void;
};

/**
 * A plain textarea with an `@` typeahead over the organization's members.
 *
 * Keyboard-first, because that is how a mention is actually typed: arrows move,
 * Enter or Tab inserts, Escape closes. Those keys are consumed ONLY while the
 * list is open, so Enter still adds a newline and Escape still cancels the
 * editor the rest of the time -- the parent's `onKeyDown` runs on every key the
 * list did not take.
 */
function MentionTextarea({
  value,
  onValueChange,
  members,
  textareaRef,
  onKeyDown,
  id,
  ...rest
}: MentionTextareaProps) {
  const ownRef = useRef<HTMLTextAreaElement>(null);
  const ref = textareaRef ?? ownRef;
  const [mention, setMention] = useState<MentionState | null>(null);
  const [active, setActive] = useState(0);
  const listId = `${id ?? 'comment'}-mentions`;

  const matches = useMemo(() => {
    if (!mention) return [];
    const query = mention.query.trim().toLocaleLowerCase();
    return members
      .filter((member) => member.name.toLocaleLowerCase().includes(query))
      .slice(0, MAX_SUGGESTIONS);
  }, [members, mention]);

  const open = mention !== null && matches.length > 0;

  /** Re-read the caret and decide whether a mention is being typed at it. */
  function sync(el: HTMLTextAreaElement): void {
    const upto = el.value.slice(0, el.selectionStart ?? el.value.length);
    const match = MENTION_QUERY.exec(upto);
    const next = match ? { anchor: upto.length - match[1].length - 1, query: match[1] } : null;
    // Compared rather than always set: `sync` also runs on the arrow keys that
    // move the highlight, and resetting it there would fight the navigation.
    if (next?.anchor === mention?.anchor && next?.query === mention?.query) return;
    setMention(next);
    setActive(0);
  }

  function insert(member: Member): void {
    const el = ref.current;
    if (!el || !mention) return;

    const caret = el.selectionStart ?? el.value.length;
    const next = `${el.value.slice(0, mention.anchor)}@${member.name} ${el.value.slice(caret)}`;
    const after = mention.anchor + member.name.length + 2;

    onValueChange(next);
    setMention(null);
    // The value is controlled, so the caret can only be placed once React has
    // committed the new text -- otherwise it lands in the middle of the old one.
    requestAnimationFrame(() => {
      el.focus();
      el.setSelectionRange(after, after);
    });
  }

  function handleKeyDown(event: KeyboardEvent<HTMLTextAreaElement>): void {
    if (open) {
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        const step = event.key === 'ArrowDown' ? 1 : matches.length - 1;
        setActive((current) => (current + step) % matches.length);
        return;
      }
      if (event.key === 'Enter' || event.key === 'Tab') {
        event.preventDefault();
        insert(matches[active] ?? matches[0]);
        return;
      }
      if (event.key === 'Escape') {
        // Consumed, so Escape closes the list without also cancelling the edit.
        event.preventDefault();
        setMention(null);
        return;
      }
    }
    onKeyDown?.(event);
  }

  return (
    <div className="relative">
      <Textarea
        {...rest}
        id={id}
        ref={ref}
        value={value}
        role="combobox"
        aria-autocomplete="list"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        aria-activedescendant={open ? `${listId}-${active}` : undefined}
        onChange={(event) => {
          onValueChange(event.target.value);
          sync(event.target);
        }}
        onKeyUp={(event) => sync(event.currentTarget)}
        onClick={(event) => sync(event.currentTarget)}
        onBlur={() => setMention(null)}
        onKeyDown={handleKeyDown}
      />

      {open ? (
        <div
          id={listId}
          role="listbox"
          aria-label="Mention a member"
          className="absolute bottom-full left-0 z-30 mb-1 max-h-56 w-64 overflow-y-auto rounded-xl border border-secondary bg-primary p-1 shadow-lg"
        >
          {matches.map((member, index) => (
            <div
              key={member.id}
              id={`${listId}-${index}`}
              role="option"
              aria-selected={index === active}
              // The textarea must keep focus and its caret: a blur here would
              // close the list before the click ever lands.
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => insert(member)}
              onMouseEnter={() => setActive(index)}
              className={cx(
                'flex cursor-pointer items-center gap-2 rounded-lg px-2 py-1.5 text-sm',
                index === active ? 'bg-secondary text-primary' : 'text-secondary',
              )}
            >
              <Initials name={member.name} className="mt-0" />
              <span className="truncate">{member.name}</span>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Comments                                                                    */
/* -------------------------------------------------------------------------- */

function RowAction({
  children,
  onClick,
  disabled,
  tone = 'default',
}: {
  children: string;
  onClick: () => void;
  disabled?: boolean;
  tone?: 'default' | 'danger';
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={cx(
        'rounded-md px-1 text-xs font-medium transition-colors disabled:opacity-50',
        'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring',
        // Revealed on hover, but only where hover exists: on a touch screen the
        // actions are simply always there.
        'sm:opacity-0 sm:group-hover:opacity-100 sm:group-focus-within:opacity-100 sm:focus-visible:opacity-100',
        tone === 'danger' ? 'text-error-primary' : 'text-tertiary hover:text-primary',
      )}
    >
      {children}
    </button>
  );
}

function CommentRow({
  comment,
  members,
  ticketId,
}: {
  comment: CommentItem;
  members: Member[];
  /** The issue an attachment pasted into this edit belongs to. */
  ticketId: string;
}) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(comment.body);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const ref = useRef<HTMLTextAreaElement>(null);
  const attach = useImageAttach({
    target: { ticketId },
    value,
    onValueChange: setValue,
    textareaRef: ref,
  });

  // Re-seeded from the prop, so a just-saved body does not flash back to the
  // old text while revalidation is still in flight.
  useEffect(() => setValue(comment.body), [comment.body]);
  useEffect(() => {
    if (!editing) return;
    const el = ref.current;
    el?.focus();
    el?.setSelectionRange(el.value.length, el.value.length);
  }, [editing]);

  const names = useMemo(() => members.map((member) => member.name), [members]);

  function save(): void {
    if (pending) return;
    const next = value.trim();
    // An empty body is refused outright; `commentBodySchema` requires one and
    // the editor stays open rather than reporting a server error for it.
    if (!next) return;
    if (next === comment.body) {
      setError(null);
      setEditing(false);
      return;
    }
    startTransition(async () => {
      const result = await updateComment(null, commentPayload(comment.id, next));
      if (result.ok) {
        setError(null);
        setEditing(false);
      } else {
        setError(result.error);
      }
    });
  }

  function cancel(): void {
    setValue(comment.body);
    setError(null);
    setEditing(false);
  }

  function remove(): void {
    if (pending) return;
    // The native confirm is the whole guard. Deleting a comment is recoverable
    // only by retyping it, and a bespoke dialog buys nothing over the one the
    // browser already ships.
    if (!window.confirm('Delete this comment? This cannot be undone.')) return;
    startTransition(async () => {
      const result = await deleteComment(null, commentPayload(comment.id));
      if (!result.ok) setError(result.error);
    });
  }

  return (
    <li className="group flex gap-3">
      <Initials name={comment.authorName} />

      <div className="flex min-w-0 flex-1 flex-col gap-1.5">
        <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
          <span className="text-sm font-medium text-primary">{comment.authorName}</span>
          <time className="text-xs text-tertiary" dateTime={comment.createdAtIso}>
            {comment.createdAtLabel}
          </time>
          {comment.edited ? <span className="text-xs text-tertiary">edited</span> : null}

          {comment.canManage && !editing ? (
            <span className="ml-auto flex items-center gap-1">
              <RowAction onClick={() => setEditing(true)} disabled={pending}>
                Edit
              </RowAction>
              <RowAction onClick={remove} disabled={pending} tone="danger">
                Delete
              </RowAction>
            </span>
          ) : null}
        </div>

        {editing ? (
          <div className="flex flex-col gap-2">
            <MentionTextarea
              id={`comment-body-${comment.id}`}
              textareaRef={ref}
              members={members}
              value={value}
              onValueChange={setValue}
              maxLength={5000}
              rows={5}
              aria-label="Edit comment"
              onKeyDown={(event) => {
                if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
                  event.preventDefault();
                  save();
                } else if (event.key === 'Escape') {
                  cancel();
                }
              }}
              {...attach.textareaProps}
            />
            <div className="flex items-center gap-2">
              <Button
                size="sm"
                color="primary"
                onPress={save}
                isDisabled={pending || attach.uploading}
              >
                {pending ? 'Saving...' : 'Save'}
              </Button>
              <Button size="sm" color="secondary" onPress={cancel} isDisabled={pending}>
                Cancel
              </Button>
              <AttachImageButton attach={attach} />
            </div>
          </div>
        ) : (
          <Prose mentions={names} className={cx(pending && 'opacity-60')}>
            {value}
          </Prose>
        )}

        <FormError>{error ?? attach.error}</FormError>
      </div>
    </li>
  );
}

type CommentThreadProps = {
  ticketId: string;
  comments: CommentItem[];
  members: Member[];
  /** The signed-in member's name, for the composer's avatar. Display only. */
  currentUserName: string;
};

export function CommentThread({
  ticketId,
  comments,
  members,
  currentUserName,
}: CommentThreadProps) {
  const [state, action] = useActionState(createComment, null);
  const bodyRef = useRef<HTMLTextAreaElement>(null);

  // Controlled, deliberately. React 19 resets a `<form action={fn}>` after the
  // action settles regardless of what it resolved to, so an uncontrolled
  // textarea loses the whole draft on a failed submit -- exactly when the user
  // most needs it back. Holding the value in state survives that reset; we
  // clear it ourselves only once the server confirms the comment landed.
  const [body, setBody] = useState('');
  const attach = useImageAttach({
    target: { ticketId },
    value: body,
    onValueChange: setBody,
    textareaRef: bodyRef,
  });

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
            <CommentRow
              key={comment.id}
              comment={comment}
              members={members}
              ticketId={ticketId}
            />
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
          <MentionTextarea
            id="new-comment"
            textareaRef={bodyRef}
            members={members}
            name="body"
            maxLength={5000}
            rows={3}
            required
            placeholder="Write a comment... type @ to mention someone, paste an image to attach it"
            value={body}
            onValueChange={setBody}
            {...attach.textareaProps}
          />
          <div className="flex items-center justify-end gap-2">
            <AttachImageButton attach={attach} />
            {/* Posting mid-upload would store the `![uploading ...]` placeholder. */}
            <SubmitButton size="sm" pendingLabel="Posting..." isDisabled={attach.uploading}>
              Comment
            </SubmitButton>
          </div>
          <FormError>{resultError(state) ?? attach.error}</FormError>
        </div>
      </form>
    </div>
  );
}
