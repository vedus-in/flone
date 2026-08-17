'use client';

import { useRef, useState, type ClipboardEvent, type DragEvent, type RefObject } from 'react';

import { Button } from '@/components/base/buttons/button';

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
 * NO CLIENT-SIDE SIZE OR TYPE VALIDATION, deliberately. `accept="image/*"` is a
 * file-picker convenience and `file.type.startsWith('image/')` below only decides
 * whether to intercept the event at all. The rules live once, on the server, in
 * `src/lib/attachments.ts` -- a second copy here would be a second thing to get
 * out of date, and the server's refusal already arrives as a sentence worth
 * showing.
 */

const UPLOAD_FAILED = 'That image could not be uploaded. Try again.';

type UseImageAttachOptions = {
  ticketId: string;
  /** The caller's current draft. */
  value: string;
  onValueChange: (next: string) => void;
  /** Needed for the caret position; insertion falls back to the end without it. */
  textareaRef: RefObject<HTMLTextAreaElement | null>;
};

export type ImageAttach = {
  /** Spread onto the textarea. */
  textareaProps: {
    onPaste: (event: ClipboardEvent<HTMLTextAreaElement>) => void;
    onDrop: (event: DragEvent<HTMLTextAreaElement>) => void;
    onDragOver: (event: DragEvent<HTMLTextAreaElement>) => void;
  };
  /** For the attach button, or anything else holding files. */
  upload: (files: FileList | File[] | null) => void;
  /** True while at least one upload is in flight. */
  uploading: boolean;
  error: string | null;
};

export function useImageAttach({
  ticketId,
  value,
  onValueChange,
  textareaRef,
}: UseImageAttachOptions): ImageAttach {
  // The draft as of this render, kept in a ref so an upload that finishes in ten
  // seconds edits the text as it is THEN, not as it was when the paste happened.
  const latest = useRef(value);
  latest.current = value;

  const [inFlight, setInFlight] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const token = useRef(0);

  function write(next: string): void {
    // Written to the ref as well as pushed up, so two files in one paste do not
    // both insert at the same offset in the same stale string.
    latest.current = next;
    onValueChange(next);
  }

  function insertAtCaret(text: string): void {
    const current = latest.current;
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
      body.set('ticketId', ticketId);
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

      write(latest.current.replace(placeholder, `![${result.filename ?? file.name}](${result.url})`));
    } catch (e) {
      write(latest.current.replace(`${placeholder}\n`, '').replace(placeholder, ''));
      setError(e instanceof Error && e.message ? e.message : UPLOAD_FAILED);
    } finally {
      setInFlight((count) => count - 1);
    }
  }

  function upload(files: FileList | File[] | null): void {
    const images = Array.from(files ?? []).filter((file) => file.type.startsWith('image/'));
    if (images.length === 0) return;
    setError(null);
    // Sequential, so the placeholders keep the order the files arrived in.
    void images.reduce<Promise<void>>(
      (queue, file) => queue.then(() => uploadOne(file)),
      Promise.resolve(),
    );
  }

  /** True when a drag or paste is carrying at least one image file. */
  function hasImage(files: FileList | null | undefined): boolean {
    return Array.from(files ?? []).some((file) => file.type.startsWith('image/'));
  }

  return {
    textareaProps: {
      onPaste: (event) => {
        // Only an image paste is intercepted. Copying an image out of a web page
        // also puts HTML and text on the clipboard, and pasting text must keep
        // working exactly as it did before this feature existed.
        if (!hasImage(event.clipboardData?.files)) return;
        event.preventDefault();
        upload(event.clipboardData.files);
      },
      onDrop: (event) => {
        if (!hasImage(event.dataTransfer?.files)) return;
        event.preventDefault();
        upload(event.dataTransfer.files);
      },
      onDragOver: (event) => {
        // Without this the browser refuses the drop and navigates to the file
        // instead, losing the whole page and the draft with it. Guarded on `Files`
        // so dragging selected TEXT into the textarea still behaves natively.
        if (!event.dataTransfer?.types.includes('Files')) return;
        event.preventDefault();
      },
    },
    upload,
    uploading: inFlight > 0,
    error,
  };
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
      <Button
        size="sm"
        color="link-gray"
        isDisabled={attach.uploading}
        onPress={() => inputRef.current?.click()}
      >
        {attach.uploading ? 'Uploading...' : label}
      </Button>
    </>
  );
}
