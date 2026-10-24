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
import { Assignee } from '@/components/issue-row';

import { AttachImageButton, useImageAttach } from '@/components/image-attach';
import { Button, FormError, Prose, SubmitButton, Textarea } from '@/components/ui';
import type { ActionResult } from '@/lib/result';
import { cx } from '@/lib/utils/cx';
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
  /** "5mo ago", also pre-formatted on the server against one `now`. */
  createdAtRelative: string;
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

/** One `FormData` shape for both comment actions; body is omitted for delete. */
function commentPayload(commentId: string, body?: string): FormData {
  const data = new FormData();
  data.set('commentId', commentId);
  if (body !== undefined) data.set('body', body);
  return data;
}

/* -------------------------------------------------------------------------- */
/* Avatar                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Purely decorative: the author's full name is rendered as real text right
 * beside it, so the initials are hidden from assistive technology rather than
 * announced twice.
 */
function Initials({ name, className }: { name: string; className?: string }) {
  return (
    <span aria-hidden="true" className={cx('flex shrink-0', className)}>
      <Assignee name={name} />
    </span>
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
          className="absolute bottom-full left-0 z-30 mb-1 max-h-56 w-64 overflow-y-auto rounded-lg border border-secondary_alt bg-elevated p-1 shadow-lg"
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
                'flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-sm',
                index === active ? 'bg-elevated_hover text-primary' : 'text-secondary',
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
    <li className="group rounded-lg border border-secondary_alt bg-secondary px-4 py-3">
      <div className="flex min-w-0 flex-col gap-2">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
          <Initials name={comment.authorName} />
          <span className="text-sm font-medium text-primary">{comment.authorName}</span>
          <time
            className="text-xs text-tertiary"
            dateTime={comment.createdAtIso}
            title={comment.createdAtLabel}
          >
            {comment.createdAtRelative}
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
          <Prose mentions={names} className={cx('ps-[26px] leading-6 text-secondary', pending && 'opacity-60')}>
            {value}
          </Prose>
        )}

        <FormError>{error ?? attach.error}</FormError>
      </div>
    </li>
  );
}

/** A system entry in the activity timeline: "Ada created the issue". */
export type ActivityEvent = {
  id: string;
  atIso: string;
  icon: ReactNode;
  content: ReactNode;
};

type CommentThreadProps = {
  ticketId: string;
  comments: CommentItem[];
  /** Interleaved with the comments by time. */
  events?: ActivityEvent[];
  members: Member[];
  /** The signed-in member's name, for the composer's avatar. Display only. */
  currentUserName: string;
};

/**
 * Linear's activity column: system events as one quiet line each, comments as
 * cards, all in time order, and the comment box at the foot.
 */
export function CommentThread({
  ticketId,
  comments,
  events = [],
  members,
  currentUserName,
}: CommentThreadProps) {
  const [state, action] = useActionState(createComment, null);
  const bodyRef = useRef<HTMLTextAreaElement>(null);
  const formRef = useRef<HTMLFormElement>(null);

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

  const timeline = useMemo(
    () =>
      [
        ...events.map((event) => ({ kind: 'event' as const, at: event.atIso, event })),
        ...comments.map((comment) => ({ kind: 'comment' as const, at: comment.createdAtIso, comment })),
      ]
        // Creation opens the story whatever the clocks say; the rest by time.
        .sort((a, b) =>
          a.kind === 'event' && a.event.id === 'created'
            ? -1
            : b.kind === 'event' && b.event.id === 'created'
              ? 1
              : a.at < b.at
                ? -1
                : a.at > b.at
                  ? 1
                  : 0,
        ),
    [comments, events],
  );

  return (
    <div className="flex flex-col gap-4">
      {timeline.length > 0 ? (
        <ol className="flex flex-col gap-3">
          {timeline.map((entry) =>
            entry.kind === 'event' ? (
              <li key={entry.event.id} className="flex min-h-6 items-center gap-2.5 ps-1 text-xs text-tertiary">
                <span className="grid size-[18px] shrink-0 place-items-center">{entry.event.icon}</span>
                <span className="min-w-0">{entry.event.content}</span>
              </li>
            ) : (
              <CommentRow
                key={entry.comment.id}
                comment={entry.comment}
                members={members}
                ticketId={ticketId}
              />
            ),
          )}
        </ol>
      ) : null}

      <form
        ref={formRef}
        action={action}
        className="rounded-lg border border-secondary_alt bg-secondary transition-colors focus-within:border-primary"
      >
        <input type="hidden" name="ticketId" value={ticketId} />
        <label className="visually-hidden" htmlFor="new-comment">
          Add a comment as {currentUserName}
        </label>
        <MentionTextarea
          id="new-comment"
          textareaRef={bodyRef}
          members={members}
          name="body"
          maxLength={5000}
          rows={1}
          required
          placeholder="Leave a comment..."
          value={body}
          onValueChange={setBody}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
              event.preventDefault();
              if (!attach.uploading) formRef.current?.requestSubmit();
            }
          }}
          {...attach.textareaProps}
          className="min-h-12 resize-none bg-transparent px-4 pt-3 pb-1 text-sm ring-0 field-sizing-content"
        />
        <div className="flex items-center justify-end gap-1 px-2 pb-2">
          <AttachImageButton attach={attach} />
          {/* Posting mid-upload would store the `![uploading ...]` placeholder. */}
          <SubmitButton size="sm" pendingLabel="Posting..." isDisabled={attach.uploading || body.trim().length === 0}>
            Comment
          </SubmitButton>
        </div>
        {resultError(state) ?? attach.error ? (
          <div className="px-3 pb-3">
            <FormError>{resultError(state) ?? attach.error}</FormError>
          </div>
        ) : null}
      </form>
    </div>
  );
}
