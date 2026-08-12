'use client';

/**
 * Card actions, so the common edits do not require opening the issue.
 *
 * Exposed two ways over ONE set of items:
 *   - `IssueContextMenu` wraps the card for right-click (desktop).
 *   - `IssueMenuButton` is an explicit trigger, which is what touch gets.
 *
 * Touch needs its own affordance because there is no right-click, and because
 * long-press is already taken: the board's TouchSensor activates a drag after
 * 250ms, so a long-press menu would fight the drag on every card. Base UI's
 * ContextMenu has no prop to opt out of long-press, hence the button.
 *
 * Built on Base UI (already present as a ReUI dependency), which handles cursor
 * positioning, focus, typeahead, submenu timing and Escape. `ContextMenu.Item`
 * and friends ARE `Menu.Item` and friends -- the same components read from
 * whichever root they are mounted under -- so the item list below is shared
 * verbatim rather than duplicated.
 *
 * Every item calls a Server Action that re-derives the session and re-resolves
 * the issue by walking up to its organization. The menu decides what to OFFER,
 * never what is permitted.
 */

import { useState, useTransition, type ReactNode } from 'react';
import { useRouter } from 'next/navigation';
import { ContextMenu } from '@base-ui/react/context-menu';
import { Menu } from '@base-ui/react/menu';
import { Priority } from '@prisma/client';

import { PRIORITY_LABEL, PRIORITY_ORDER, colorClass } from '@/lib/model';
import { cx } from '@/lib/utils/cx';

import { addChallenge } from '@/app/(app)/orgs/[orgSlug]/challenges/actions';

import type { BoardIssue, BoardStateColumn } from './board-view';
import {
  deleteIssue,
  setIssueAssignee,
  setIssueBoard,
  setIssueCycle,
  setIssueDueDate,
  setIssueLabels,
  setIssuePriority,
  placeIssue,
} from '../../issue-actions';

export type BoardMember = { id: string; name: string };
export type BoardOption = { id: string; name: string };
export type MenuLabel = { id: string; name: string; color: string };
export type MenuCycle = { id: string; number: number; name: string | null };

type MenuData = {
  issue: BoardIssue;
  columns: BoardStateColumn[];
  members: BoardMember[];
  boards: BoardOption[];
  labels: MenuLabel[];
  cycles: MenuCycle[];
  boardId: string;
  projectKey: string;
  onError: (message: string | null) => void;
};

/* -------------------------------------------------------------------------- */
/* Presentation                                                                */
/* -------------------------------------------------------------------------- */

const POPUP =
  'z-50 max-h-[min(24rem,70dvh)] min-w-56 origin-[var(--transform-origin)] overflow-y-auto overscroll-contain rounded-xl border border-secondary bg-primary p-1 shadow-2xl outline-none';

// `py-2` on touch: 44px-ish rows. `md:py-1.5` tightens it back up for a mouse.
const ITEM =
  'flex cursor-default select-none items-center gap-2.5 rounded-lg px-2.5 py-2 text-sm text-primary outline-none data-[highlighted]:bg-secondary data-[disabled]:opacity-50 md:py-1.5';

const DANGER =
  'flex cursor-default select-none items-center gap-2.5 rounded-lg px-2.5 py-2 text-sm text-error-primary outline-none data-[highlighted]:bg-error-primary md:py-1.5';

const LABEL =
  'px-2.5 pt-1.5 pb-1 text-[0.6875rem] font-medium tracking-wider text-tertiary uppercase';

function Icon({ d, className }: { d: string; className?: string }) {
  return (
    <svg viewBox="0 0 16 16" fill="none" aria-hidden="true" className={cx('size-4 shrink-0', className)}>
      <path d={d} stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

const I_STATUS = 'M8 14.5A6.5 6.5 0 1 0 8 1.5a6.5 6.5 0 0 0 0 13ZM8 5v3l2 2';
const I_PRIORITY = 'M2.5 13.5v-4M8 13.5v-8M13.5 13.5v-11';
const I_PERSON = 'M8 8a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5ZM3 13.5a5 5 0 0 1 10 0';
const I_CALENDAR = 'M3 4.5h10v9H3zM3 7h10M6 2.5v3M10 2.5v3';
const I_COPY = 'M5.5 5.5h7v7h-7zM10.5 5.5v-2h-7v7h2';
const I_MOVE = 'M8 2.5v11M2.5 8h11M8 2.5 5.5 5M8 2.5 10.5 5M8 13.5 5.5 11M8 13.5l2.5-2.5';
const I_TAG = 'M2.5 7.5V3a.5.5 0 0 1 .5-.5h4.5L13.5 9 9 13.5zM5 5.5h.01';
const I_CYCLE = 'M8 14.5A6.5 6.5 0 1 0 8 1.5a6.5 6.5 0 0 0 0 13ZM8 4.5v3.7l2.2 1.6';
const I_OPEN = 'M9.5 2.5h4v4M13.5 2.5 8 8M12 9.5v3a1 1 0 0 1-1 1H3.5a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1h3';
const I_TRASH = 'M2.5 4h11M6 4V2.5h4V4M12 4v9a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V4M6.5 7v4M9.5 7v4';
const I_CHEVRON = 'M6 3.5 10.5 8 6 12.5';
const I_CHECK = 'M3 8.5 6.5 12 13 4.5';
const I_DOTS = 'M8 3.2h.01M8 8h.01M8 12.8h.01';
const I_TARGET = 'M8 14.5A6.5 6.5 0 1 0 8 1.5a6.5 6.5 0 0 0 0 13ZM8 11a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z';

function SubTrigger({ icon, children }: { icon: string; children: ReactNode }) {
  return (
    <Menu.SubmenuTrigger className={ITEM}>
      <Icon d={icon} className="text-tertiary" />
      <span className="flex-1">{children}</span>
      <Icon d={I_CHEVRON} className="size-3 text-tertiary" />
    </Menu.SubmenuTrigger>
  );
}

function Submenu({ children }: { children: ReactNode }) {
  return (
    <Menu.Portal>
      <Menu.Positioner side="right" align="start" sideOffset={4} className="z-50 outline-none">
        <Menu.Popup className={POPUP}>{children}</Menu.Popup>
      </Menu.Positioner>
    </Menu.Portal>
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

const PRIORITY_CLASS: Record<Priority, string> = {
  [Priority.URGENT]: 'text-error-primary',
  [Priority.HIGH]: 'text-warning-primary',
  [Priority.MEDIUM]: 'text-primary',
  [Priority.LOW]: 'text-tertiary',
  [Priority.NONE]: 'text-tertiary',
};

/** Local calendar day, offset by `days`, as YYYY-MM-DD. */
function isoDay(days: number): string {
  const date = new Date();
  date.setDate(date.getDate() + days);
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${date.getFullYear()}-${month}-${day}`;
}

/* -------------------------------------------------------------------------- */
/* The shared item list                                                        */
/* -------------------------------------------------------------------------- */

function IssueMenuItems({
  issue,
  columns,
  members,
  boards,
  labels,
  cycles,
  boardId,
  projectKey,
  onError,
}: MenuData) {
  const router = useRouter();
  const [, startTransition] = useTransition();
  const [copied, setCopied] = useState<string | null>(null);

  const issueKey = `${projectKey}-${issue.number}`;
  const currentColumn = columns.find((column) => column.issues.some((i) => i.id === issue.id));
  const labelIds = new Set(issue.labels.map((label) => label.id));

  function run(action: () => Promise<{ ok: boolean; error?: string }>) {
    startTransition(async () => {
      const result = await action();
      onError(result.ok ? null : (result.error ?? 'Something went wrong.'));
    });
  }

  async function copy(text: string, what: string) {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(what);
      window.setTimeout(() => setCopied(null), 1500);
    } catch {
      onError('Could not copy to the clipboard.');
    }
  }

  return (
    <>
      <Menu.Group>
        <Menu.GroupLabel className={LABEL}>{issueKey}</Menu.GroupLabel>

        <Menu.SubmenuRoot>
          <SubTrigger icon={I_STATUS}>Status</SubTrigger>
          <Submenu>
            {columns.map((column) => (
              <Menu.Item
                key={column.id}
                className={ITEM}
                onClick={() =>
                  run(() =>
                    placeIssue({
                      ticketId: issue.id,
                      toStateId: column.id,
                      // Append; a precise index is what dragging is for.
                      toIndex: column.issues.length,
                      visibleIds: column.issues.map((i) => i.id).filter((id) => id !== issue.id),
                    }),
                  )
                }
              >
                <Tick on={currentColumn?.id === column.id} />
                {column.name}
              </Menu.Item>
            ))}
          </Submenu>
        </Menu.SubmenuRoot>

        <Menu.SubmenuRoot>
          <SubTrigger icon={I_PRIORITY}>Priority</SubTrigger>
          <Submenu>
            {PRIORITY_ORDER.map((value) => (
              <Menu.Item
                key={value}
                className={ITEM}
                onClick={() => run(() => setIssuePriority({ ticketId: issue.id, priority: value }))}
              >
                <Tick on={issue.priority === value} />
                <span className={PRIORITY_CLASS[value]}>{PRIORITY_LABEL[value]}</span>
              </Menu.Item>
            ))}
          </Submenu>
        </Menu.SubmenuRoot>

        <Menu.SubmenuRoot>
          <SubTrigger icon={I_PERSON}>Assignee</SubTrigger>
          <Submenu>
            <Menu.Item
              className={ITEM}
              onClick={() => run(() => setIssueAssignee({ ticketId: issue.id, assigneeId: '' }))}
            >
              <Tick on={issue.assigneeId === null} />
              <span className="text-tertiary">Unassigned</span>
            </Menu.Item>
            {members.map((member) => (
              <Menu.Item
                key={member.id}
                className={ITEM}
                onClick={() =>
                  run(() => setIssueAssignee({ ticketId: issue.id, assigneeId: member.id }))
                }
              >
                <Tick on={issue.assigneeId === member.id} />
                {member.name}
              </Menu.Item>
            ))}
          </Submenu>
        </Menu.SubmenuRoot>

        {labels.length > 0 ? (
          <Menu.SubmenuRoot>
            <SubTrigger icon={I_TAG}>Labels</SubTrigger>
            <Submenu>
              {labels.map((label) => {
                const on = labelIds.has(label.id);
                return (
                  <Menu.Item
                    key={label.id}
                    className={ITEM}
                    closeOnClick={false}
                    onClick={() =>
                      run(() =>
                        setIssueLabels({
                          ticketId: issue.id,
                          labelIds: on
                            ? [...labelIds].filter((id) => id !== label.id)
                            : [...labelIds, label.id],
                        }),
                      )
                    }
                  >
                    <Tick on={on} />
                    <span
                      aria-hidden="true"
                      className={cx('size-2 shrink-0 rounded-full', colorClass(label.color).dot)}
                    />
                    {label.name}
                  </Menu.Item>
                );
              })}
            </Submenu>
          </Menu.SubmenuRoot>
        ) : null}

        {cycles.length > 0 ? (
          <Menu.SubmenuRoot>
            <SubTrigger icon={I_CYCLE}>Cycle</SubTrigger>
            <Submenu>
              <Menu.Item
                className={ITEM}
                onClick={() => run(() => setIssueCycle({ ticketId: issue.id, cycleId: '' }))}
              >
                <Tick on={issue.cycleId === null} />
                <span className="text-tertiary">No cycle</span>
              </Menu.Item>
              {cycles.map((cycle) => (
                <Menu.Item
                  key={cycle.id}
                  className={ITEM}
                  onClick={() => run(() => setIssueCycle({ ticketId: issue.id, cycleId: cycle.id }))}
                >
                  <Tick on={issue.cycleId === cycle.id} />
                  {cycle.name ?? `Cycle ${cycle.number}`}
                </Menu.Item>
              ))}
            </Submenu>
          </Menu.SubmenuRoot>
        ) : null}

        <Menu.SubmenuRoot>
          <SubTrigger icon={I_CALENDAR}>Due date</SubTrigger>
          <Submenu>
            {[
              { label: 'Today', days: 0 },
              { label: 'Tomorrow', days: 1 },
              { label: 'Next week', days: 7 },
            ].map((option) => (
              <Menu.Item
                key={option.label}
                className={ITEM}
                onClick={() =>
                  run(() => setIssueDueDate({ ticketId: issue.id, dueDate: isoDay(option.days) }))
                }
              >
                <Tick on={false} />
                {option.label}
              </Menu.Item>
            ))}
            <Menu.Separator className="my-1 h-px bg-border-secondary" />
            <Menu.Item
              className={ITEM}
              disabled={issue.dueDateLabel === null}
              onClick={() => run(() => setIssueDueDate({ ticketId: issue.id, dueDate: null }))}
            >
              <Tick on={false} />
              <span className="text-tertiary">Clear due date</span>
            </Menu.Item>
          </Submenu>
        </Menu.SubmenuRoot>
      </Menu.Group>

      <Menu.Separator className="my-1 h-px bg-border-secondary" />

      {/* Adds a row to the caller's own pick list and nothing else. The issue
          does not move, does not change status, and stays on this board -- the
          challenge board shows it a second time rather than taking it away. */}
      <Menu.Item className={ITEM} onClick={() => run(() => addChallenge({ ticketId: issue.id }))}>
        <Icon d={I_TARGET} className="text-tertiary" />
        Add to my challenges
      </Menu.Item>

      <Menu.Separator className="my-1 h-px bg-border-secondary" />

      <Menu.SubmenuRoot>
        <SubTrigger icon={I_COPY}>Copy</SubTrigger>
        <Submenu>
          <Menu.Item
            className={ITEM}
            closeOnClick={false}
            onClick={() => void copy(`${window.location.origin}${issue.href}`, 'link')}
          >
            <Tick on={copied === 'link'} />
            Copy link
          </Menu.Item>
          <Menu.Item className={ITEM} closeOnClick={false} onClick={() => void copy(issueKey, 'id')}>
            <Tick on={copied === 'id'} />
            Copy ID
          </Menu.Item>
          <Menu.Item
            className={ITEM}
            closeOnClick={false}
            onClick={() => void copy(issue.title, 'title')}
          >
            <Tick on={copied === 'title'} />
            Copy title
          </Menu.Item>
        </Submenu>
      </Menu.SubmenuRoot>

      {/* "Move to board" is now just setting a field, and the field is nullable:
          an issue can legitimately belong to no board at all. */}
      <Menu.SubmenuRoot>
        <SubTrigger icon={I_MOVE}>Board</SubTrigger>
        <Submenu>
          <Menu.Item
            className={ITEM}
            onClick={() => run(() => setIssueBoard({ ticketId: issue.id, boardId: '' }))}
          >
            <Tick on={false} />
            <span className="text-tertiary">No board</span>
          </Menu.Item>
          {boards.map((board) => (
            <Menu.Item
              key={board.id}
              className={ITEM}
              disabled={board.id === boardId}
              onClick={() => run(() => setIssueBoard({ ticketId: issue.id, boardId: board.id }))}
            >
              <Tick on={board.id === boardId} />
              {board.name}
            </Menu.Item>
          ))}
        </Submenu>
      </Menu.SubmenuRoot>

      <Menu.SubmenuRoot>
        <SubTrigger icon={I_OPEN}>Open in</SubTrigger>
        <Submenu>
          <Menu.Item className={ITEM} onClick={() => router.push(issue.href)}>
            <Tick on={false} />
            This tab
          </Menu.Item>
          <Menu.Item
            className={ITEM}
            onClick={() => window.open(issue.href, '_blank', 'noopener,noreferrer')}
          >
            <Tick on={false} />
            New tab
          </Menu.Item>
        </Submenu>
      </Menu.SubmenuRoot>

      {/* Author, ADMIN or OWNER only -- the flag is computed on the server and
          `deleteIssue` enforces the same rule again. */}
      {issue.canDelete ? (
        <>
          <Menu.Separator className="my-1 h-px bg-border-secondary" />

          <Menu.Item className={DANGER} onClick={() => run(() => deleteFromMenu(issue.id))}>
            <Icon d={I_TRASH} />
            <span className="flex-1">Delete</span>
            <kbd className="hidden font-mono text-[0.6875rem] text-tertiary md:inline">Ctrl Del</kbd>
          </Menu.Item>
        </>
      ) : null}

      <div className="mt-1 border-t border-secondary px-2.5 pt-2 pb-1 text-[0.6875rem] text-tertiary">
        Updated {issue.updatedAtLabel}
        {issue.dueDateLabel ? <> &middot; due {issue.dueDateLabel}</> : null}
      </div>
    </>
  );
}

/**
 * `deleteIssue` takes FormData and redirects on success. From the board that
 * redirect is unwanted -- the card simply disappears -- but a Server Action's
 * `redirect()` throws, and React swallows it as a navigation rather than an
 * error, so the call is fire-and-forget with the result mapped back.
 */
async function deleteFromMenu(ticketId: string): Promise<{ ok: boolean; error?: string }> {
  const data = new FormData();
  data.set('ticketId', ticketId);
  return deleteIssue(null, data);
}

/* -------------------------------------------------------------------------- */
/* Right-click (pointer devices)                                               */
/* -------------------------------------------------------------------------- */

export function IssueContextMenu({ children, ...data }: MenuData & { children: ReactNode }) {
  return (
    <ContextMenu.Root>
      <ContextMenu.Trigger className="outline-none">{children}</ContextMenu.Trigger>
      <ContextMenu.Portal>
        <ContextMenu.Positioner className="z-50 outline-none" side="bottom" align="start">
          <ContextMenu.Popup
            className={POPUP}
            onKeyDown={(event) => {
              // The one shortcut actually bound. Ctrl/Cmd guards against a stray
              // Delete press while merely browsing the menu.
              if (event.key === 'Delete' && (event.ctrlKey || event.metaKey)) {
                event.preventDefault();
                if (!data.issue.canDelete) return;
                void deleteFromMenu(data.issue.id).then((result) => {
                  data.onError(result.ok ? null : (result.error ?? 'Something went wrong.'));
                });
              }
            }}
          >
            <IssueMenuItems {...data} />
          </ContextMenu.Popup>
        </ContextMenu.Positioner>
      </ContextMenu.Portal>
    </ContextMenu.Root>
  );
}

/* -------------------------------------------------------------------------- */
/* Explicit trigger (touch, and handy with a mouse)                            */
/* -------------------------------------------------------------------------- */

export function IssueMenuButton(data: MenuData) {
  return (
    <Menu.Root>
      <Menu.Trigger
        aria-label={`Actions for ${data.projectKey}-${data.issue.number}`}
        // Keep the press off the drag sensor, or opening the menu would start a
        // drag on the card underneath.
        onPointerDown={(event) => event.stopPropagation()}
        // -mt-1/-me-1 pull the larger touch target back so it does not push the
        // title down: the hit area grows, the visual weight does not.
        className="-mt-1 -me-1 grid size-9 shrink-0 place-items-center rounded-md text-tertiary transition-colors hover:bg-secondary hover:text-primary focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring data-[popup-open]:bg-secondary data-[popup-open]:text-primary md:mt-0 md:me-0 md:size-7"
      >
        <Icon d={I_DOTS} className="size-4" />
      </Menu.Trigger>
      <Menu.Portal>
        <Menu.Positioner side="bottom" align="end" sideOffset={4} className="z-50 outline-none">
          <Menu.Popup className={POPUP}>
            <IssueMenuItems {...data} />
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
  );
}
