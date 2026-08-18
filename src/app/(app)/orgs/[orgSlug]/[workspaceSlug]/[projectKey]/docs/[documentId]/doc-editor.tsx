'use client';

/**
 * The document page's interactive shell: Notion's behaviour, this app's parts.
 *
 * CLICK-TO-EDIT, EXACTLY AS THE ISSUE PAGE DOES IT. The rendered title and body
 * ARE the controls: clicking one swaps in a textarea seeded from props, Escape
 * reverts, and saving calls the same `updateDocument` Server Action the old
 * form posted -- whose schema wants title AND body on every call, so each editor
 * sends the other field's current value along unchanged. Values render straight
 * from props and re-sync when revalidation delivers new ones; the local draft
 * exists only while an editor is open. This replaces the Edit popup outright:
 * there is no separate editing surface, the page is the editing surface.
 *
 * THE POPOVERS ARE BASE UI, NOT `<details>`. The details experiment failed the
 * way details always do -- two open at once, nothing closes on outside click.
 * `Popover` is the same primitive the issue page's property pickers already
 * ship: outside click dismisses, Escape dismisses, focus is trapped correctly,
 * and opening one closes the other because the first's outside-click fires.
 *
 * The forms inside the popovers still submit through `ActionForm` to the same
 * Server Actions as before. Nothing about authorization moved; this file only
 * decides what is on screen when.
 */

import { useEffect, useRef, useState, useTransition, type ReactNode } from 'react';
import { Popover } from '@base-ui/react/popover';

import { AttachImageButton, useImageAttach } from '@/components/image-attach';
import { Button, Field, FormError, Input, Prose, Separator, SubmitButton, Textarea } from '@/components/ui';
import { cx } from '@/lib/utils/cx';

import { ActionForm } from '../../../../../../action-form';
import {
  createDocument,
  deleteDocument,
  moveDocument,
  setDocumentShared,
  updateDocument,
} from '../actions';

/* -------------------------------------------------------------------------- */
/* Shared                                                                      */
/* -------------------------------------------------------------------------- */

/** `updateDocument`'s schema requires both fields every time, so both are sent. */
function editPayload(documentId: string, title: string, body: string): FormData {
  const data = new FormData();
  data.set('documentId', documentId);
  data.set('title', title);
  data.set('body', body);
  return data;
}

/** Focus the just-opened editor with the caret at the end, not selecting all. */
function focusEnd(el: HTMLTextAreaElement | null): void {
  if (!el) return;
  el.focus();
  el.setSelectionRange(el.value.length, el.value.length);
}

type InlineProps = {
  documentId: string;
  title: string;
  /** The empty string when the document has none; the action stores it as ''. */
  body: string;
};

/* -------------------------------------------------------------------------- */
/* Title                                                                       */
/* -------------------------------------------------------------------------- */

export function InlineDocTitle({ documentId, title, body }: InlineProps) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(title);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const ref = useRef<HTMLTextAreaElement>(null);

  useEffect(() => setValue(title), [title]);
  useEffect(() => {
    if (editing) focusEnd(ref.current);
  }, [editing]);

  function save() {
    if (pending) return;
    const next = value.trim();
    // An empty title is refused outright; the editor stays open.
    if (!next) return;
    if (next === title) {
      setValue(next);
      setError(null);
      setEditing(false);
      return;
    }
    startTransition(async () => {
      const result = await updateDocument(null, editPayload(documentId, next, body));
      if (result.ok) {
        setValue(next);
        setError(null);
        setEditing(false);
      } else {
        setError(result.error);
      }
    });
  }

  function cancel() {
    setValue(title);
    setError(null);
    setEditing(false);
  }

  return (
    <div className="flex flex-col gap-2">
      {/* Preflight gives the button and textarea `font: inherit`, so the
          typography lives once, on the heading. */}
      <h1 className="text-4xl font-bold tracking-tight text-balance text-primary">
        {editing ? (
          <textarea
            ref={ref}
            rows={1}
            maxLength={200}
            value={value}
            onChange={(event) => setValue(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault();
                save();
              } else if (event.key === 'Escape') {
                cancel();
              }
            }}
            onBlur={() => {
              if (value.trim() && value.trim() !== title) save();
              else if (value.trim()) cancel();
              // Empty on blur: keep editing, there is nothing valid to show.
            }}
            aria-label="Document title"
            className={cx(
              'w-full resize-none border-0 bg-transparent p-0 field-sizing-content focus:outline-none',
              pending && 'opacity-60',
            )}
          />
        ) : (
          <button
            type="button"
            onClick={() => setEditing(true)}
            aria-label="Edit title"
            className="w-full cursor-text rounded-md text-left focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring"
          >
            {value}
          </button>
        )}
      </h1>
      <FormError>{error}</FormError>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Body                                                                        */
/* -------------------------------------------------------------------------- */

export function InlineDocBody({
  documentId,
  title,
  body,
  projectId,
}: InlineProps & { projectId: string }) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(body);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const ref = useRef<HTMLTextAreaElement>(null);
  // Paste, drop and pick an image. It edits `value` like any other keystroke, so
  // the image is Markdown in the draft and is saved by the same `updateDocument`.
  const attach = useImageAttach({
    target: { projectId },
    value,
    onValueChange: setValue,
    textareaRef: ref,
  });

  useEffect(() => setValue(body), [body]);
  useEffect(() => {
    if (editing) focusEnd(ref.current);
  }, [editing]);

  function save() {
    if (pending) return;
    startTransition(async () => {
      const result = await updateDocument(null, editPayload(documentId, title, value));
      if (result.ok) {
        setError(null);
        setEditing(false);
      } else {
        setError(result.error);
      }
    });
  }

  function cancel() {
    setValue(body);
    setError(null);
    setEditing(false);
  }

  if (!editing) {
    return (
      // Not a `<button>`: the rendered Markdown may contain links, and an `<a>`
      // inside a button is invalid nesting the browser resolves by making the
      // link dead. A focusable div keeps links clickable and Enter/Space edits.
      <div
        role="button"
        tabIndex={0}
        aria-label="Edit document body"
        onClick={(event) => {
          // A click on a link follows it; a click that ends a text selection
          // (copying a command out of the page) is not an edit request.
          if ((event.target as HTMLElement).closest('a')) return;
          if (!window.getSelection()?.isCollapsed) return;
          setEditing(true);
        }}
        onKeyDown={(event) => {
          if ((event.key === 'Enter' || event.key === ' ') && event.target === event.currentTarget) {
            event.preventDefault();
            setEditing(true);
          }
        }}
        className="w-full cursor-text rounded-md text-left focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring"
      >
        {value ? (
          <Prose className="markdown-doc text-[0.9375rem] leading-7">{value}</Prose>
        ) : (
          <span className="text-sm text-tertiary">
            This page is empty. Click to start writing.
          </span>
        )}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-2">
      <Textarea
        ref={ref}
        // Sized to the draft, capped well inside a screen: a long document edits
        // in a scrolling box rather than a page-length one.
        rows={Math.min(28, Math.max(10, value.split('\n').length + 2))}
        maxLength={100000}
        value={value}
        onChange={(event) => setValue(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
            event.preventDefault();
            save();
          } else if (event.key === 'Escape') {
            cancel();
          }
        }}
        {...attach.textareaProps}
        aria-label="Document body (Markdown)"
        placeholder="Write in Markdown. Paste or drop an image to attach it."
        className="text-[0.9375rem] leading-7"
      />
      <div className="flex items-center gap-2">
        {/* Saving mid-upload would store the `![uploading ...]` placeholder, so
            the button waits rather than the person having to notice. */}
        <Button size="sm" color="primary" onPress={save} isDisabled={pending || attach.uploading}>
          {pending ? 'Saving...' : 'Save'}
        </Button>
        <Button size="sm" color="secondary" onPress={cancel} isDisabled={pending}>
          Cancel
        </Button>
        <AttachImageButton attach={attach} />
        <span className="text-xs text-tertiary">Ctrl/⌘+Enter saves, Escape cancels.</span>
      </div>
      <FormError>{error ?? attach.error}</FormError>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Top-bar actions                                                             */
/* -------------------------------------------------------------------------- */

const TRIGGER =
  'inline-flex cursor-pointer items-center rounded-md px-2 py-1 text-xs whitespace-nowrap text-tertiary outline-focus-ring transition-colors hover:bg-secondary hover:text-primary focus-visible:outline-2 data-[popup-open]:bg-secondary data-[popup-open]:text-primary';

// The Base UI popup surface, as the issue page's pickers draw it -- widened and
// padded for forms rather than menu rows.
const POPUP =
  'z-50 flex w-80 max-w-[calc(100vw-2rem)] origin-[var(--transform-origin)] flex-col gap-4 rounded-xl border border-secondary bg-primary p-4 shadow-2xl outline-none';

const SELECT_CLASS =
  'min-h-9 rounded-lg border border-primary bg-primary px-3 py-2 text-sm text-primary shadow-xs outline-focus-ring transition-colors hover:bg-primary_hover focus-visible:outline-2 focus-visible:outline-offset-2';

type DocActionsProps = {
  documentId: string;
  projectId: string;
  parentId: string | null;
  /** Legal new parents, `parentOptions` output: never this document or its subtree. */
  parents: Array<{ id: string; title: string }>;
  /** Null when the document is private. */
  shareUrl: string | null;
  /** Author or ADMIN+: may share and delete. */
  canManage: boolean;
  descendants: number;
};

/** One Base UI popover: trigger chip in the top bar, panel underneath. */
function ActionPopover({
  label,
  children,
  ariaLabel,
}: {
  label: ReactNode;
  children: ReactNode;
  ariaLabel?: string;
}) {
  return (
    <Popover.Root>
      <Popover.Trigger className={TRIGGER} aria-label={ariaLabel}>
        {label}
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Positioner side="bottom" align="end" sideOffset={6} className="z-50 outline-none">
          <Popover.Popup className={POPUP}>{children}</Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}

export function DocActions({
  documentId,
  projectId,
  parentId,
  parents,
  shareUrl,
  canManage,
  descendants,
}: DocActionsProps) {
  return (
    <div className="flex shrink-0 items-center gap-0.5">
      {canManage ? (
        <ActionPopover
          ariaLabel={shareUrl ? 'Sharing options — public' : 'Share'}
          label={shareUrl ? <span className="text-brand-secondary">Public</span> : 'Share'}
        >
          {shareUrl ? (
            <>
              {/* Readonly rather than plain text so it can be selected and
                  copied in one gesture. */}
              <Input id="document-share-url" aria-label="Public link" readOnly value={shareUrl} />
              <p className="text-xs text-pretty text-tertiary">
                Anyone with this link can read this document — the title, the body and the
                images in it — without signing in. Documents filed inside this one are not
                shared. Stopping breaks this link permanently; sharing again makes a new one.
              </p>
            </>
          ) : (
            <p className="text-xs text-pretty text-tertiary">
              Makes a read-only page anyone with the link can open, no account needed. Only
              this document: anything filed inside it stays private.
            </p>
          )}
          <ActionForm
            action={setDocumentShared}
            aria-label={shareUrl ? 'Stop sharing document' : 'Share document'}
          >
            <input type="hidden" name="documentId" value={documentId} />
            <input type="hidden" name="shared" value={shareUrl ? 'false' : 'true'} />
            <SubmitButton
              size="sm"
              color={shareUrl ? 'secondary' : 'primary'}
              pendingLabel={shareUrl ? 'Stopping...' : 'Creating...'}
            >
              {shareUrl ? 'Stop sharing' : 'Create a public link'}
            </SubmitButton>
          </ActionForm>
        </ActionPopover>
      ) : null}

      <ActionPopover ariaLabel="More actions" label={<span className="text-sm leading-none">⋯</span>}>
        <ActionForm
          action={createDocument}
          className="flex flex-col gap-2"
          aria-label="New page inside this document"
        >
          <input type="hidden" name="projectId" value={projectId} />
          <input type="hidden" name="parentId" value={documentId} />
          <Field htmlFor="child-document-title" label="New page inside">
            <Input
              id="child-document-title"
              name="title"
              isRequired
              maxLength={200}
              autoComplete="off"
              placeholder="Deployment checklist"
            />
          </Field>
          <div>
            <SubmitButton size="sm" color="secondary" pendingLabel="Creating...">
              Create
            </SubmitButton>
          </div>
        </ActionForm>

        <Separator />

        <ActionForm action={moveDocument} className="flex flex-col gap-2" aria-label="Move document">
          <input type="hidden" name="documentId" value={documentId} />
          <Field htmlFor="document-parent" label="Move under">
            {/* A native `<select>`, and it CANNOT OFFER A CYCLE: `parents` is
                `parentOptions` output, computed on the server. `moveDocument`
                checks again anyway -- a select is a suggestion, a POST body is
                whatever the caller sent. */}
            <select
              id="document-parent"
              name="parentId"
              defaultValue={parentId ?? ''}
              className={cx(SELECT_CLASS, 'w-full')}
            >
              <option value="">Top level</option>
              {parents.map((option) => (
                <option key={option.id} value={option.id}>
                  {option.title}
                </option>
              ))}
            </select>
          </Field>
          <div>
            <SubmitButton size="sm" color="secondary" pendingLabel="Moving...">
              Move
            </SubmitButton>
          </div>
        </ActionForm>

        {canManage ? (
          <>
            <Separator />
            {/* The button IS the confirmation: it names the descendant count,
                because deleting a document deletes what is filed under it and
                nothing here goes to a trash. */}
            <ActionForm action={deleteDocument} aria-label="Delete document">
              <input type="hidden" name="documentId" value={documentId} />
              <SubmitButton size="sm" color="secondary-destructive" pendingLabel="Deleting...">
                {descendants > 0
                  ? `Delete, with ${descendants} nested ${descendants === 1 ? 'page' : 'pages'}`
                  : 'Delete this document'}
              </SubmitButton>
            </ActionForm>
          </>
        ) : null}
      </ActionPopover>
    </div>
  );
}
