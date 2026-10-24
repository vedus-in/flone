'use client';

/**
 * The compose dialog, shared by every surface that can start an issue.
 *
 * Title and description are the whole point, so they are borderless and large;
 * the metadata sits under them as pills. Escape and the backdrop close it --
 * react-aria's Modal owns the focus trap and the scroll lock.
 *
 * The pills wear native `<select>`s deliberately. These are short enumerations,
 * and a real select brings its own keyboard handling, typeahead and -- the
 * reason that actually matters -- the OS picker on a phone. A custom listbox
 * would be more markup for less behaviour.
 *
 * Every id offered here is re-vetted server-side by `createIssue`; this list
 * decides only what to OFFER.
 */

import { useCallback, useEffect, useId, useRef, useState, useTransition, type ReactNode } from 'react';
import { Priority, type WorkflowStateType } from '@prisma/client';
import { X as CloseIcon } from '@untitledui/icons';
import { Button as AriaButton } from 'react-aria-components';

import { Dialog, Modal, ModalOverlay } from '@/components/application/modals/modal';
import { AttachImageButton, useImageAttach } from '@/components/image-attach';
import { PriorityIcon, StateIcon } from '@/components/issue-row';
import { IconChevronRight, IconPlus } from '@/components/icons';
import { PAGE_BAR_ACTION, ProjectGlyph } from '@/components/page-bar';
import { FormError } from '@/components/ui';
import { colorClass, PRIORITY_LABEL, PRIORITY_ORDER } from '@/lib/model';
import { COMPOSE_EVENT, COMPOSE_HASH, type ComposeDetail } from '@/lib/shell-events';
import { cx } from '@/lib/utils/cx';

import { createIssue } from './issue-actions';

export type ComposerState = { id: string; name: string; type: WorkflowStateType; color: string };
export type ComposerOption = { id: string; name: string; color?: string };
export type ComposerCycle = { id: string; number: number; name: string | null };

type ComposerProps = {
  projectId: string;
  projectKey: string;
  states: ComposerState[];
  boards: ComposerOption[];
  cycles: ComposerCycle[];
  labels: ComposerOption[];
  members: ComposerOption[];
  /** Where the dialog opens pointed. */
  defaultStateId: string;
  defaultBoardId?: string;
  defaultCycleId?: string;
  /** Rendered as the trigger. */
  children?: ReactNode;
  className?: string;
};

function Pill({
  label,
  value,
  onChange,
  children,
  glyph,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  children: ReactNode;
  glyph?: ReactNode;
}) {
  return (
    <span className="inline-flex h-7 items-center gap-1.5 rounded-md border border-primary px-2 text-xs font-medium text-secondary transition-colors hover:bg-tertiary has-[select:focus-visible]:outline-2 has-[select:focus-visible]:outline-offset-1 has-[select:focus-visible]:outline-focus-ring">
      {glyph}
      <select
        aria-label={label}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className="cursor-pointer appearance-none bg-transparent text-xs font-medium text-secondary outline-none"
      >
        {children}
      </select>
    </span>
  );
}

export function IssueComposer({
  projectId,
  projectKey,
  states,
  boards,
  cycles,
  labels,
  members,
  defaultStateId,
  defaultBoardId = '',
  defaultCycleId = '',
  children,
  className,
}: ComposerProps) {
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  // Controlled: React 19 resets a form bound to an action once it settles,
  // regardless of the result, which would discard a rejected title.
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [stateId, setStateId] = useState(defaultStateId);
  const [priority, setPriority] = useState<Priority>(Priority.NONE);
  const [assigneeId, setAssigneeId] = useState('');
  const [boardId, setBoardId] = useState(defaultBoardId);
  const [cycleId, setCycleId] = useState(defaultCycleId);
  const [labelIds, setLabelIds] = useState<string[]>([]);
  // Off by default: the common case is one issue, and a dialog that refuses to
  // close is worse than one extra click.
  const [createMore, setCreateMore] = useState(false);
  const titleRef = useRef<HTMLTextAreaElement>(null);
  const descriptionRef = useRef<HTMLTextAreaElement>(null);
  const headingId = useId();

  // Targeted at the PROJECT: there is no issue yet, which is the whole reason
  // `Attachment.ticketId` is nullable. An abandoned dialog therefore leaves its
  // objects in the bucket -- an accepted orphan, and cheaper than a parser that
  // decides when a file may be destroyed.
  const attach = useImageAttach({
    target: { projectId },
    value: description,
    onValueChange: setDescription,
    textareaRef: descriptionRef,
  });

  const state = states.find((candidate) => candidate.id === stateId) ?? states[0];
  const assignee = members.find((member) => member.id === assigneeId) ?? null;

  function reset() {
    setTitle('');
    setDescription('');
    setPriority(Priority.NONE);
    setAssigneeId('');
    setLabelIds([]);
    setError(null);
  }

  const openComposer = useCallback((presetStateId?: string) => {
    setStateId(presetStateId && states.some((s) => s.id === presetStateId) ? presetStateId : defaultStateId);
    setBoardId(defaultBoardId);
    setCycleId(defaultCycleId);
    setError(null);
    setOpen(true);
  }, [defaultBoardId, defaultCycleId, defaultStateId, states]);

  // `C` anywhere in the app, and the sidebar's compose button, ask whichever
  // composer is on the page to open; arriving with `#new-issue` asks the same.
  useEffect(() => {
    function onCompose(event: Event) {
      if (event.defaultPrevented) return;
      event.preventDefault();
      openComposer((event as CustomEvent<ComposeDetail | null>).detail?.stateId);
    }
    window.addEventListener(COMPOSE_EVENT, onCompose);
    if (window.location.hash === COMPOSE_HASH) {
      window.history.replaceState(null, '', window.location.pathname + window.location.search);
      openComposer();
    }
    return () => window.removeEventListener(COMPOSE_EVENT, onCompose);
  }, [openComposer]);

  function submit() {
    const value = title.trim();
    if (!value) return;

    const data = new FormData();
    data.set('projectId', projectId);
    data.set('stateId', stateId);
    data.set('title', value);
    data.set('description', description.trim());
    data.set('priority', priority);
    data.set('assigneeId', assigneeId);
    data.set('boardId', boardId);
    data.set('cycleId', cycleId);
    for (const id of labelIds) data.append('labelIds', id);

    startTransition(async () => {
      const result = await createIssue(null, data);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      reset();
      if (createMore) titleRef.current?.focus();
      else setOpen(false);
    });
  }

  return (
    <>
      <button
        type="button"
        onClick={() => openComposer()}
        title="New issue (C)"
        className={cx(PAGE_BAR_ACTION, className)}
      >
        {children ?? (
          <>
            <IconPlus className="size-3.5" />
            New issue
          </>
        )}
      </button>

      <ModalOverlay isOpen={open} onOpenChange={setOpen}>
        <Modal className="w-full sm:max-w-[45rem]">
          <Dialog aria-labelledby={headingId} className="gap-0 p-0">
            <div className="flex items-center gap-1.5 px-4 pt-3.5 pb-1">
              <span className="flex h-6 items-center gap-1.5 rounded-md border border-primary px-2 text-xs font-medium text-secondary">
                <ProjectGlyph projectKey={projectKey} className="size-3" />
                {projectKey}
              </span>
              <IconChevronRight className="size-3 text-quaternary" />
              <span id={headingId} className="text-sm text-secondary">
                New issue
              </span>
            </div>
            <AriaButton
              aria-label="Close"
              onPress={() => setOpen(false)}
              className="absolute top-3 right-3 grid size-7 cursor-pointer place-items-center rounded-md text-tertiary outline-focus-ring transition-colors hover:bg-tertiary hover:text-primary focus-visible:outline-2 focus-visible:outline-offset-2"
            >
              <CloseIcon className="size-4" />
            </AriaButton>

            <div className="flex flex-col gap-2 px-4 pt-3">
              {/* `field-sizing-content` grows both fields with their text, so a
                  long title never hides behind a scrollbar. */}
              <textarea
                ref={titleRef}
                autoFocus
                rows={1}
                maxLength={200}
                value={title}
                onChange={(event) => setTitle(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' && !event.shiftKey) {
                    event.preventDefault();
                    submit();
                  }
                }}
                aria-label="Issue title"
                placeholder="Issue title"
                className="w-full resize-none border-0 bg-transparent p-0 text-lg font-semibold text-primary field-sizing-content placeholder:text-quaternary focus:outline-none"
              />
              <textarea
                ref={descriptionRef}
                rows={3}
                maxLength={2000}
                value={description}
                onChange={(event) => setDescription(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
                    event.preventDefault();
                    submit();
                  }
                }}
                {...attach.textareaProps}
                aria-label="Description"
                placeholder="Add description…"
                className="min-h-16 w-full resize-none border-0 bg-transparent p-0 text-md text-secondary field-sizing-content placeholder:text-quaternary focus:outline-none"
              />
            </div>

            <div className="flex flex-wrap items-center gap-1.5 px-4 pt-4 pb-3">
              <Pill
                label="Status"
                value={stateId}
                onChange={setStateId}
                glyph={state ? <StateIcon type={state.type} color={state.color} /> : null}
              >
                {states.map((candidate) => (
                  <option key={candidate.id} value={candidate.id}>
                    {candidate.name}
                  </option>
                ))}
              </Pill>

              <Pill
                label="Priority"
                value={priority}
                onChange={(value) => setPriority(value as Priority)}
                glyph={<PriorityIcon priority={priority} />}
              >
                {PRIORITY_ORDER.map((value) => (
                  <option key={value} value={value}>
                    {PRIORITY_LABEL[value]}
                  </option>
                ))}
              </Pill>

              <Pill
                label="Assignee"
                value={assigneeId}
                onChange={setAssigneeId}
                glyph={
                  <span
                    aria-hidden="true"
                    className={cx(
                      'grid size-4 place-items-center rounded-full text-[0.5rem] font-medium',
                      assignee ? 'bg-secondary text-primary' : 'border border-dashed border-secondary text-tertiary',
                    )}
                  >
                    {assignee ? assignee.name.slice(0, 1).toUpperCase() : '–'}
                  </span>
                }
              >
                <option value="">Unassigned</option>
                {members.map((member) => (
                  <option key={member.id} value={member.id}>
                    {member.name}
                  </option>
                ))}
              </Pill>

              {boards.length > 0 ? (
                <Pill
                  label="Board"
                  value={boardId}
                  onChange={setBoardId}
                  glyph={
                    <span
                      aria-hidden="true"
                      className={cx(
                        'size-2 rounded-full',
                        boardId
                          ? colorClass(boards.find((b) => b.id === boardId)?.color ?? 'gray').dot
                          : 'border border-tertiary',
                      )}
                    />
                  }
                >
                  <option value="">No board</option>
                  {boards.map((board) => (
                    <option key={board.id} value={board.id}>
                      {board.name}
                    </option>
                  ))}
                </Pill>
              ) : null}

              {cycles.length > 0 ? (
                <Pill label="Cycle" value={cycleId} onChange={setCycleId}>
                  <option value="">No cycle</option>
                  {cycles.map((cycle) => (
                    <option key={cycle.id} value={cycle.id}>
                      {cycle.name ? `Cycle ${cycle.number} — ${cycle.name}` : `Cycle ${cycle.number}`}
                    </option>
                  ))}
                </Pill>
              ) : null}
            </div>

            {labels.length > 0 ? (
              <div className="flex flex-wrap items-center gap-1.5 px-4 pb-3">
                {labels.map((label) => {
                  const on = labelIds.includes(label.id);
                  return (
                    <button
                      key={label.id}
                      type="button"
                      aria-pressed={on}
                      onClick={() =>
                        setLabelIds((current) =>
                          on ? current.filter((id) => id !== label.id) : [...current, label.id],
                        )
                      }
                      className={cx(
                        'flex h-6 items-center gap-1.5 rounded-full border px-2.5 text-xs font-medium transition-colors',
                        on
                          ? 'border-primary bg-tertiary text-primary'
                          : 'border-primary text-tertiary hover:bg-tertiary hover:text-secondary',
                      )}
                    >
                      <span
                        aria-hidden="true"
                        className={cx('size-2 rounded-full', colorClass(label.color ?? 'gray').dot)}
                      />
                      {label.name}
                    </button>
                  );
                })}
              </div>
            ) : null}

            {error ?? attach.error ? (
              <div className="px-4 pb-3">
                <FormError>{error ?? attach.error}</FormError>
              </div>
            ) : null}

            <div className="flex items-center justify-between gap-3 border-t border-secondary_alt px-4 py-3">
              <AttachImageButton attach={attach} />
              <div className="flex items-center gap-3">
                <label className="flex cursor-pointer items-center gap-2 text-xs text-tertiary">
                  <input
                    type="checkbox"
                    checked={createMore}
                    onChange={(event) => setCreateMore(event.target.checked)}
                    className="size-3.5 accent-brand-600"
                  />
                  Create more
                </label>
                <button
                  type="button"
                  onClick={submit}
                  // Creating mid-upload would store the `![uploading ...]`
                  // placeholder as the description.
                  disabled={pending || attach.uploading || title.trim().length === 0}
                  className="h-8 rounded-md bg-brand-solid px-3 text-sm font-medium text-white shadow-xs ring-1 ring-white/10 ring-inset transition-colors hover:bg-brand-solid_hover disabled:opacity-50"
                >
                  {pending ? 'Creating…' : 'Create issue'}
                </button>
              </div>
            </div>
          </Dialog>
        </Modal>
      </ModalOverlay>
    </>
  );
}
