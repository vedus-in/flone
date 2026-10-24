'use client';

/**
 * The issue page's Linear-style interactive shell: click-to-edit title and
 * description, and the "Properties" sidebar of popup pickers.
 *
 * Click-to-edit contract: the rendered text IS the button. Clicking it (or
 * Enter/Space -- it is a real `<button>`) swaps in a textarea focused with the
 * caret at the end. The title saves on Enter or on blur-with-changes and
 * cancels on Escape; the description saves on Ctrl/Cmd+Enter or its Save
 * button and cancels on Escape. An empty title refuses to save and the editor
 * stays open, because `updateIssue`'s schema requires one.
 *
 * Both editors reuse `updateIssue`, whose schema demands title AND description
 * on every call, so each editor sends the other field's current value along
 * unchanged. The empty string is how "no description" travels; the action
 * stores it as NULL. The same wire rule holds across the pickers: '' means
 * "none" for assignee, board and cycle, and is never re-encoded here.
 *
 * Property values render STRAIGHT from props, never mirrored into state. Each
 * picker fires its Server Action inside a transition; the action's
 * `revalidatePath` re-renders the server page and the new value arrives as
 * props. The sidebar forms this file replaced held the value in an
 * uncontrolled `<select defaultValue>` -- and React 19 resets a
 * `<form action>` to its defaults when the action settles, so every save
 * visibly snapped back to the stale value until a full reload. Props as the
 * only source of truth is what makes that bug unexpressible here. The one
 * exception is the editors' local draft, seeded from the prop and re-synced
 * when the prop changes, so a just-saved text never flashes back to the old
 * value while revalidation is still in flight.
 */

import { useEffect, useRef, useState, useTransition } from 'react';
import { Menu } from '@base-ui/react/menu';
import { Priority } from '@prisma/client';
import type { WorkflowStateType } from '@prisma/client';

import {
  PropertyPicker,
  assigneeOptions,
  priorityOptions,
  stateOptions,
  type PickerOption,
} from '@/components/property-picker';
import { Assignee, PriorityIcon, StateIcon } from '@/components/issue-row';
import { AttachImageButton, useImageAttach } from '@/components/image-attach';
import { Button, FormError, Prose, Textarea } from '@/components/ui';
import { PRIORITY_LABEL, colorClass } from '@/lib/model';
import type { ActionResult } from '@/lib/result';
import { cx } from '@/lib/utils/cx';

import {
  setIssueAssignee,
  setIssueBoard,
  setIssueCycle,
  setIssueLabels,
  setIssuePriority,
  setIssueState,
  updateIssue,
} from '../../issue-actions';

/* -------------------------------------------------------------------------- */
/* Shared helpers                                                              */
/* -------------------------------------------------------------------------- */

/** `updateIssue`'s schema requires both fields every time, so both are sent. */
function editPayload(ticketId: string, title: string, description: string): FormData {
  const data = new FormData();
  data.set('ticketId', ticketId);
  data.set('title', title);
  data.set('description', description);
  return data;
}

/** Focus the just-opened editor with the caret at the end, not selecting all. */
function focusEnd(el: HTMLTextAreaElement | null): void {
  if (!el) return;
  el.focus();
  el.setSelectionRange(el.value.length, el.value.length);
}

type InlineEditorProps = {
  ticketId: string;
  title: string;
  /** The empty string when the issue has none; `updateIssue` stores '' as NULL. */
  description: string;
};

/* -------------------------------------------------------------------------- */
/* Title                                                                       */
/* -------------------------------------------------------------------------- */

export function InlineTitle({ ticketId, title, description }: InlineEditorProps) {
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
      const result = await updateIssue(null, editPayload(ticketId, next, description));
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
      <h1 className="text-2xl font-semibold text-primary">
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
            aria-label="Issue title"
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
/* Description                                                                 */
/* -------------------------------------------------------------------------- */

export function InlineDescription({ ticketId, title, description }: InlineEditorProps) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(description);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const ref = useRef<HTMLTextAreaElement>(null);
  // Paste, drop and pick an image. It edits `value` like any other keystroke, so
  // the image is Markdown in the draft and is saved by the same `updateIssue`.
  const attach = useImageAttach({
    target: { ticketId },
    value,
    onValueChange: setValue,
    textareaRef: ref,
  });

  useEffect(() => setValue(description), [description]);
  useEffect(() => {
    if (editing) focusEnd(ref.current);
  }, [editing]);

  function save() {
    if (pending) return;
    startTransition(async () => {
      const result = await updateIssue(null, editPayload(ticketId, title, value));
      if (result.ok) {
        setError(null);
        setEditing(false);
      } else {
        setError(result.error);
      }
    });
  }

  function cancel() {
    setValue(description);
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
        aria-label="Edit description"
        onClick={(event) => {
          // A click on a link follows it; a click that ends a text selection
          // (copying a path out of the description) is not an edit request.
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
        {value ? <Prose>{value}</Prose> : <span className="text-sm text-tertiary">Add description...</span>}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-2">
      <Textarea
        ref={ref}
        rows={10}
        maxLength={10000}
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
        aria-label="Description"
        placeholder="What needs to happen? Paste or drop an image to attach it."
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
      </div>
      <FormError>{error ?? attach.error}</FormError>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Properties sidebar                                                          */
/* -------------------------------------------------------------------------- */

const TRIGGER =
  'flex h-7 w-full items-center gap-2 rounded-md px-1.5 text-sm transition-colors hover:bg-secondary';

// The Base UI popup surface and row, as the board's issue menu draws them.
const POPUP =
  'z-50 max-h-[min(24rem,70dvh)] min-w-56 origin-[var(--transform-origin)] overflow-y-auto overscroll-contain rounded-lg border border-secondary_alt bg-elevated p-1 shadow-lg outline-none';

const ITEM =
  'flex cursor-default select-none items-center gap-2.5 rounded-md px-2 py-2 text-sm text-secondary outline-none data-[highlighted]:bg-elevated_hover data-[highlighted]:text-primary data-[disabled]:opacity-50 md:py-1.5';

const I_CHECK = 'M3 8.5 6.5 12 13 4.5';
const I_CYCLE = 'M8 14.5A6.5 6.5 0 1 0 8 1.5a6.5 6.5 0 0 0 0 13ZM8 4.5v3.7l2.2 1.6';
const I_PLUS = 'M8 3v10M3 8h10';

function Icon({ d, className }: { d: string; className?: string }) {
  return (
    <svg viewBox="0 0 16 16" fill="none" aria-hidden="true" className={cx('size-4 shrink-0', className)}>
      <path d={d} stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/** A tick occupying fixed width, so labels stay aligned whether ticked or not. */
function Tick({ on }: { on: boolean }) {
  return on ? (
    <Icon d={I_CHECK} className="size-3.5 text-brand-secondary" />
  ) : (
    <span aria-hidden="true" className="size-3.5 shrink-0" />
  );
}

function Dot({ color, className }: { color: string; className?: string }) {
  return (
    <span
      aria-hidden="true"
      className={cx('shrink-0 rounded-full', colorClass(color).dot, className ?? 'size-2')}
    />
  );
}

type PropertiesPanelProps = {
  ticketId: string;
  stateId: string;
  priority: Priority;
  assigneeId: string | null;
  boardId: string | null;
  cycleId: string | null;
  labelIds: string[];
  /** Already sorted by the page with `sortStatesForBoard`. */
  states: Array<{ id: string; name: string; type: WorkflowStateType; color: string }>;
  members: Array<{ id: string; name: string }>;
  boards: Array<{ id: string; name: string; color: string }>;
  cycles: Array<{ id: string; number: number; name: string | null }>;
  labels: Array<{ id: string; name: string; color: string }>;
};

export function PropertiesPanel({
  ticketId,
  stateId,
  priority,
  assigneeId,
  boardId,
  cycleId,
  labelIds,
  states,
  members,
  boards,
  cycles,
  labels,
}: PropertiesPanelProps) {
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function run(action: () => Promise<ActionResult>) {
    startTransition(async () => {
      const result = await action();
      setError(result.ok ? null : result.error);
    });
  }

  const state = states.find((candidate) => candidate.id === stateId) ?? null;
  const assignee = members.find((member) => member.id === assigneeId) ?? null;
  const board = boards.find((candidate) => candidate.id === boardId) ?? null;
  const cycle = cycles.find((candidate) => candidate.id === cycleId) ?? null;
  const active = new Set(labelIds);
  const currentLabels = labels.filter((label) => active.has(label.id));

  const cycleOpts: PickerOption[] = [
    { id: '', label: 'No cycle', labelClassName: 'text-tertiary' },
    ...cycles.map((option) => ({ id: option.id, label: option.name ?? `Cycle ${option.number}` })),
  ];
  const boardOpts: PickerOption[] = [
    { id: '', label: 'No board', labelClassName: 'text-tertiary' },
    ...boards.map((option) => ({ id: option.id, label: option.name, icon: <Dot color={option.color} /> })),
  ];

  return (
    <div className="flex flex-col gap-5">
      <div className={cx('flex flex-col gap-5 transition-opacity', pending && 'opacity-60')}>
        <section className="flex flex-col gap-0.5">
          <h2 className="mb-1 text-sm font-medium text-tertiary">Properties</h2>

          <PropertyPicker
            options={stateOptions(states)}
            currentId={stateId}
            placeholder="Change status..."
            shortcutHint="S"
            ariaLabel="Change status"
            triggerClassName={TRIGGER}
            onSelect={(id) => run(() => setIssueState({ ticketId, stateId: id }))}
          >
            {state ? <StateIcon type={state.type} color={state.color} /> : null}
            <span className="truncate text-primary">{state?.name ?? 'No status'}</span>
          </PropertyPicker>

          <PropertyPicker
            options={priorityOptions()}
            currentId={priority}
            placeholder="Change priority to..."
            shortcutHint="P"
            ariaLabel="Change priority"
            triggerClassName={TRIGGER}
            onSelect={(id) => run(() => setIssuePriority({ ticketId, priority: id as Priority }))}
          >
            <PriorityIcon priority={priority} />
            <span
              className={cx('truncate', priority === Priority.NONE ? 'text-tertiary' : 'text-primary')}
            >
              {PRIORITY_LABEL[priority]}
            </span>
          </PropertyPicker>

          <PropertyPicker
            options={assigneeOptions(members)}
            currentId={assigneeId ?? ''}
            placeholder="Assign to..."
            shortcutHint="A"
            ariaLabel="Change assignee"
            triggerClassName={TRIGGER}
            onSelect={(id) => run(() => setIssueAssignee({ ticketId, assigneeId: id }))}
          >
            {/* `Assignee` carries its own label; the visible text beside it is
                the announcement, so the glyph is hidden to avoid a double read. */}
            <span aria-hidden="true">
              <Assignee name={assignee?.name ?? null} />
            </span>
            <span className={cx('truncate', assignee ? 'text-primary' : 'text-tertiary')}>
              {assignee?.name ?? (assigneeId ? 'Unknown member' : 'Assign')}
            </span>
          </PropertyPicker>

          <PropertyPicker
            options={cycleOpts}
            currentId={cycleId ?? ''}
            placeholder="Add to cycle..."
            ariaLabel="Change cycle"
            triggerClassName={TRIGGER}
            onSelect={(id) => run(() => setIssueCycle({ ticketId, cycleId: id }))}
          >
            <Icon d={I_CYCLE} className="text-tertiary" />
            <span className={cx('truncate', cycle ? 'text-primary' : 'text-tertiary')}>
              {cycle ? (cycle.name ?? `Cycle ${cycle.number}`) : 'Add to cycle'}
            </span>
          </PropertyPicker>
        </section>

        {labels.length > 0 ? (
          <section className="flex flex-col gap-2">
            <h3 className="text-xs font-medium text-tertiary">Labels</h3>
            <div className="flex flex-wrap items-center gap-1.5">
              {currentLabels.map((label) => (
                <span
                  key={label.id}
                  className="flex items-center gap-1.5 rounded-full border border-secondary px-2 py-0.5 text-[0.6875rem] text-tertiary"
                >
                  <Dot color={label.color} className="size-1.5" />
                  {label.name}
                </span>
              ))}
              <Menu.Root>
                <Menu.Trigger
                  aria-label="Add or remove labels"
                  className="grid size-6 shrink-0 place-items-center rounded-md text-tertiary transition-colors hover:bg-secondary hover:text-primary focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring data-[popup-open]:bg-secondary data-[popup-open]:text-primary"
                >
                  <Icon d={I_PLUS} className="size-3.5" />
                </Menu.Trigger>
                <Menu.Portal>
                  <Menu.Positioner side="bottom" align="start" sideOffset={4} className="z-50 outline-none">
                    <Menu.Popup className={POPUP}>
                      {labels.map((label) => {
                        const on = active.has(label.id);
                        return (
                          <Menu.Item
                            key={label.id}
                            className={ITEM}
                            closeOnClick={false}
                            onClick={() =>
                              run(() =>
                                setIssueLabels({
                                  ticketId,
                                  labelIds: on
                                    ? labelIds.filter((id) => id !== label.id)
                                    : [...labelIds, label.id],
                                }),
                              )
                            }
                          >
                            <Tick on={on} />
                            <Dot color={label.color} />
                            {label.name}
                          </Menu.Item>
                        );
                      })}
                    </Menu.Popup>
                  </Menu.Positioner>
                </Menu.Portal>
              </Menu.Root>
            </div>
          </section>
        ) : null}

        <section className="flex flex-col gap-0.5">
          <h3 className="mb-1 text-xs font-medium text-tertiary">Board</h3>
          <PropertyPicker
            options={boardOpts}
            currentId={boardId ?? ''}
            placeholder="Add to board..."
            ariaLabel="Change board"
            triggerClassName={TRIGGER}
            onSelect={(id) => run(() => setIssueBoard({ ticketId, boardId: id }))}
          >
            {board ? (
              <Dot color={board.color} />
            ) : (
              <span
                aria-hidden="true"
                className="size-2 shrink-0 rounded-full border border-dashed border-secondary"
              />
            )}
            <span className={cx('truncate', board ? 'text-primary' : 'text-tertiary')}>
              {board?.name ?? 'Add to board'}
            </span>
          </PropertyPicker>
        </section>
      </div>

      <FormError>{error}</FormError>
    </div>
  );
}
