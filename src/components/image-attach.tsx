'use client';

import {
  useRef,
  useState,
  type ClipboardEvent,
  type ComponentProps,
  type DragEvent,
  type RefObject,
} from 'react';

import { Button } from '@/components/base/buttons/button';
import { FormError, Textarea } from '@/components/ui';
// The SAME rules the upload route validates with. Not a copy -- see that module's
// header for why it is one of the two lib modules without `server-only`.
import { rejectionMessage, validateUpload } from '@/lib/attachments';

/**
 * Pasting, dropping and picking an image into a Markdown textarea.
 *
 * The whole feature on the client is: put the file on the server, then edit the
 * caller's text. There is no editor, no preview pane and no upload widget --
 * the textarea stays a textarea, and what lands in it is the Markdown
 * `![name](/api/attachments/<id>)` that `Prose` already knows how to render. That
 * is why this is a hook over a controlled value instead of a component: the
 * description editor, the comment composer and the in-place comment editor each
 * already own their draft, and none of them has to hand it over.
 *
 * WHILE AN UPLOAD IS IN FLIGHT a placeholder holds the spot:
 *
 *     ![uploading screenshot.png…](#upload-3)
 *
 * The `#upload-N` token is what makes the replacement safe when two files are
 * pasted at once or the same file is pasted twice -- matching on the filename
 * alone would swap the wrong one. On success the placeholder becomes the real
 * image; on failure it is removed and the caller shows the error. Either way the
 * text the user typed around it is untouched, which is the entire reason the
 * current draft is read from a ref rather than from the closure: uploads take
 * seconds and people keep typing.
 *
 * A REFUSAL IS AN ANSWER AND MUST LOOK LIKE ONE. Dropping a PDF on a comment box
 * used to do nothing whatsoever -- no upload, no message, nothing to distinguish a
 * refused file from a broken feature -- and letting the browser have the drop
 * instead is worse still: it navigates to the file and takes the half-written issue
 * with it. So every file drop is intercepted, and anything unsupported comes back
 * named, with the reason, from `rejectionMessage`.
 *
 * The rules are IMPORTED from `src/lib/attachments.ts`, the same module the upload
 * route validates with, and are not restated here. That is what stops the browser
 * refusing something the server would have accepted, and what stops 25 MB being
 * uploaded over a hotel connection to be told no at the far end. `accept` on the
 * file input is still only a picker convenience, and the server still re-checks
 * everything: this is a faster no, not the only one.
 */

const UPLOAD_FAILED = 'That image could not be uploaded. Try again.';

/**
 * What the upload is authorized against.
 *
 * A ticket where one exists, and a PROJECT where one does not: the new-issue
 * dialog and the recurring-template form both compose a description before there
 * is any row to attach it to, and with only a ticket target those two surfaces
 * could not upload at all.
 */
export type AttachTarget = { ticketId: string } | { projectId: string };

type UseImageAttachOptions = {
  target: AttachTarget;
  /** The textarea being typed into. Both the caret and, uncontrolled, the text. */
  textareaRef: RefObject<HTMLTextAreaElement | null>;
  /**
   * CONTROLLED CALLERS PASS BOTH; uncontrolled callers pass neither.
   *
   * The issue editors and the comment boxes hold their draft in state, so the
   * image has to be inserted through them or React overwrites it on the next
   * render. The recurring-template forms are deliberately uncontrolled native
   * controls -- `ActionForm` puts a rejected submit back through `form.elements`,
   * which only reaches real ones -- so there the DOM node IS the draft and this
   * writes to it directly.
   */
  value?: string;
  onValueChange?: (next: string) => void;
};

export type ImageAttach = {
  /** Spread onto the textarea. */
  textareaProps: {
    onPaste: (event: ClipboardEvent<HTMLTextAreaElement>) => void;
    onDrop: (event: DragEvent<HTMLTextAreaElement>) => void;
    onDragOver: (event: DragEvent<HTMLTextAreaElement>) => void;
    onDragEnter: (event: DragEvent<HTMLTextAreaElement>) => void;
    onDragLeave: () => void;
    /** Present only while files are over the field; styled by `globals.css`. */
    'data-dragging'?: 'true';
  };
  /** For the attach button, or anything else holding files. */
  upload: (files: FileList | File[] | null) => void;
  /** True while at least one upload is in flight. */
  uploading: boolean;
  error: string | null;
};

export function useImageAttach({
  target,
  value,
  onValueChange,
  textareaRef,
}: UseImageAttachOptions): ImageAttach {
  // The draft as of this render, kept in a ref so an upload that finishes in ten
  // seconds edits the text as it is THEN, not as it was when the paste happened.
  const latest = useRef(value ?? '');
  if (onValueChange) latest.current = value ?? '';

  const [inFlight, setInFlight] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const token = useRef(0);

  function read(): string {
    return onValueChange ? latest.current : (textareaRef.current?.value ?? '');
  }

  function write(next: string): void {
    if (onValueChange) {
      // Written to the ref as well as pushed up, so two files in one paste do not
      // both insert at the same offset in the same stale string.
      latest.current = next;
      onValueChange(next);
      return;
    }
    const el = textareaRef.current;
    if (el) el.value = next;
  }

  function insertAtCaret(text: string): void {
    const current = read();
    const caret = textareaRef.current?.selectionStart ?? current.length;
    const before = current.slice(0, caret);
    const after = current.slice(caret);
    // Markdown needs the image to start its own line, or it lands mid-paragraph
    // and the surrounding sentence wraps around it.
    const lead = before.length > 0 && !before.endsWith('\n') ? '\n' : '';
    write(`${before}${lead}${text}\n${after}`);
  }

  async function uploadOne(file: File): Promise<void> {
    const placeholder = `![uploading ${file.name}…](#upload-${(token.current += 1)})`;
    insertAtCaret(placeholder);
    setInFlight((count) => count + 1);

    try {
      const body = new FormData();
      // One field or the other; the route re-derives the project from whichever
      // it can authorize, never from anything else sent here.
      if ('ticketId' in target) body.set('ticketId', target.ticketId);
      else body.set('projectId', target.projectId);
      body.set('file', file);

      const response = await fetch('/api/attachments', { method: 'POST', body });
      const result = (await response.json().catch(() => null)) as
        | { url?: string; filename?: string; error?: string }
        | null;

      if (!response.ok || !result?.url) {
        // The route answers with closed literals only, so its message is safe to
        // show verbatim; anything unexpected falls back to ours.
        throw new Error(typeof result?.error === 'string' ? result.error : UPLOAD_FAILED);
      }

      write(read().replace(placeholder, `![${result.filename ?? file.name}](${result.url})`));
    } catch (e) {
      write(read().replace(`${placeholder}\n`, '').replace(placeholder, ''));
      setError(e instanceof Error && e.message ? e.message : UPLOAD_FAILED);
    } finally {
      setInFlight((count) => count - 1);
    }
  }

  /**
   * Sort the batch into what can be uploaded and what has to be explained.
   *
   * The rules come from `@/lib/attachments` -- the SAME module the route validates
   * with -- so the browser cannot refuse something the server would have taken, or
   * spend a minute uploading 25 MB that the server was always going to reject.
   */
  function upload(files: FileList | File[] | null): void {
    const all = Array.from(files ?? []);
    if (all.length === 0) return;

    const accepted = all.filter((file) => validateUpload(file) === null);
    const rejected = all.filter((file) => validateUpload(file) !== null);

    // Always assigned, so a previous complaint clears when the next drop is fine.
    setError(rejectionMessage(rejected));

    // Sequential, so the placeholders keep the order the files arrived in.
    void accepted.reduce<Promise<void>>(
      (queue, file) => queue.then(() => uploadOne(file)),
      Promise.resolve(),
    );
  }

  /** A drag or a paste carrying files at all -- supported or not. */
  function carriesFiles(transfer: DataTransfer | null | undefined): boolean {
    return (transfer?.files?.length ?? 0) > 0 || (transfer?.types.includes('Files') ?? false);
  }

  return {
    textareaProps: {
      onPaste: (event) => {
        // A paste carrying NO file is left alone entirely: copying an image out of
        // a web page also puts HTML and text on the clipboard, and pasting text has
        // to keep working exactly as it did before this feature existed. A paste
        // that does carry a file is ours to answer -- with the image, or with the
        // reason it was refused.
        if ((event.clipboardData?.files?.length ?? 0) === 0) return;
        event.preventDefault();
        upload(event.clipboardData.files);
      },
      onDrop: (event) => {
        setDragging(false);
        if (!carriesFiles(event.dataTransfer)) return;
        // EVERY file drop is intercepted, not just an acceptable one. Letting an
        // unsupported file through to the browser's default means NAVIGATING AWAY
        // to it -- the page is replaced by a PDF viewer and the half-written issue
        // is gone. Refusing it with a sentence is the whole fix.
        event.preventDefault();
        upload(event.dataTransfer.files);
      },
      onDragOver: (event) => {
        // Without this the browser refuses the drop and navigates to the file
        // instead. Guarded on `Files` so dragging selected TEXT into the textarea
        // still behaves natively.
        if (!carriesFiles(event.dataTransfer)) return;
        event.preventDefault();
      },
      onDragEnter: (event) => {
        if (!carriesFiles(event.dataTransfer)) return;
        event.preventDefault();
        setDragging(true);
      },
      onDragLeave: () => setDragging(false),
      /**
       * Styled by one rule in `globals.css` rather than a class at each call site,
       * so every textarea that spreads these props gets the affordance -- and a new
       * one cannot forget it. An attribute, not a class, because these props are
       * spread onto components whose `className` belongs to the caller.
       */
      'data-dragging': dragging ? 'true' : undefined,
    },
    upload,
    uploading: inFlight > 0,
    error,
  };
}

/**
 * An UNCONTROLLED Markdown textarea that accepts images, with the attach button
 * and any upload error under it.
 *
 * For the recurring-template forms, which submit as plain `FormData` and must stay
 * real form controls with a `name` and a `defaultValue` -- so this owns the hook
 * rather than asking the page to, and the page stays a Server Component. Every
 * other prop is forwarded to the textarea untouched.
 */
export function ImageAttachTextarea({
  target,
  ...props
}: { target: AttachTarget } & Omit<ComponentProps<typeof Textarea>, 'value' | 'onChange' | 'ref'>) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const attach = useImageAttach({ target, textareaRef: ref });

  return (
    <div className="flex flex-col items-start gap-1">
      <Textarea {...props} ref={ref} {...attach.textareaProps} />
      <AttachImageButton attach={attach} />
      <FormError>{attach.error}</FormError>
    </div>
  );
}

/**
 * The third way in: a real `<input type="file">` behind a button.
 *
 * The input is hidden rather than absent, because a file picker cannot be opened
 * any other way -- `showOpenFilePicker` is not in Safari, and nothing else can
 * grant a page access to a file. It is reset to `''` after every pick so choosing
 * the same screenshot twice in a row still fires `change`.
 */
export function AttachImageButton({
  attach,
  label = 'Attach image',
}: {
  attach: ImageAttach;
  label?: string;
}) {
  const inputRef = useRef<HTMLInputElement>(null);

  return (
    <>
      <input
        ref={inputRef}
        type="file"
        accept="image/png,image/jpeg,image/gif,image/webp"
        multiple
        className="visually-hidden"
        // Not `aria-hidden`: the button below is its label, and a hidden input the
        // button opens is exactly the pattern screen readers expect.
        tabIndex={-1}
        onChange={(event) => {
          attach.upload(event.target.files);
          event.target.value = '';
        }}
      />
      {/* The `title` sits on a wrapper because Untitled UI's `Button` takes a
          closed prop list and forwards no `title`. It says what is allowed before
          anyone finds out by being refused; the message from a refusal is still
          the real answer. */}
      <span title="PNG, JPEG, GIF or WebP, up to 10 MB">
        <Button
          size="sm"
          color="link-gray"
          isDisabled={attach.uploading}
          onPress={() => inputRef.current?.click()}
        >
          {attach.uploading ? 'Uploading...' : label}
        </Button>
      </span>
    </>
  );
}
