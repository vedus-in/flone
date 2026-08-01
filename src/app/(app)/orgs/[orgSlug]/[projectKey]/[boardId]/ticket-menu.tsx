'use client';

/**
 * Right-click menu for a card, so the common edits do not require opening the
 * ticket first.
 *
 * Built on Base UI's `ContextMenu` (already present as a ReUI dependency), which
 * handles positioning at the cursor, focus trapping, typeahead, submenu timing
 * and Escape for us. Only the styling is ours.
 *
 * Every item calls a Server Action that re-derives the session and re-resolves
 * the ticket by walking up to its organization, so nothing here is trusted --
 * the menu only decides what to OFFER, never what is permitted.
 *
 * Shortcut hints are shown ONLY for behaviour that is actually wired up. The
 * single-letter hints in Linear open submenus; Base UI's own typeahead already
 * moves focus to a matching item, so labelling those would overpromise.
 */

import { useState, useTransition, type ReactNode } from 'react';
import { useRouter } from 'next/navigation';
import { ContextMenu } from '@base-ui/react/context-menu';
import { Priority } from '@prisma/client';

import type { BoardColumnData, BoardTicket } from './board-view';
import {
  assignTicketFromBoard,
  deleteTicketFromBoard,
  moveTicketToBoard,
  placeTicket,
  setTicketDueDate,
  setTicketPriority,
} from './actions';

export type BoardMember = { id: string; name: string };
export type SiblingBoard = { id: string; name: string };

type TicketMenuProps = {
  ticket: BoardTicket;
  columns: BoardColumnData[];
  members: BoardMember[];
  boards: SiblingBoard[];
  projectKey: string;
  boardHref: string;
  onError: (message: string | null) => void;
  children: ReactNode;
};

function cx(...values: Array<string | false | null | undefined>): string {
  return values.filter(Boolean).join(' ');
}

/* -------------------------------------------------------------------------- */
/* Presentation                                                                */
/* -------------------------------------------------------------------------- */

const POPUP =
  'z-50 min-w-56 origin-[var(--transform-origin)] rounded-xl border border-border bg-surface p-1 shadow-2xl outline-none';

const ITEM =
  'flex cursor-default select-none items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-sm text-foreground outline-none data-[highlighted]:bg-surface-secondary data-[disabled]:opacity-50';

const DANGER =
  'flex cursor-default select-none items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-sm text-danger outline-none data-[highlighted]:bg-danger-soft';

const LABEL = 'px-2.5 pt-1.5 pb-1 text-[0.6875rem] font-medium tracking-wider text-muted uppercase';

function Icon({ d, className }: { d: string; className?: string }) {
  return (
    <svg
      viewBox="0 0 16 16"
      fill="none"
      aria-hidden="true"
      className={cx('size-4 shrink-0', className)}
    >
      <path
        d={d}
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

const I_STATUS = 'M8 14.5A6.5 6.5 0 1 0 8 1.5a6.5 6.5 0 0 0 0 13ZM8 5v3l2 2';
const I_PRIORITY = 'M2.5 13.5v-4M8 13.5v-8M13.5 13.5v-11';
const I_PERSON = 'M8 8a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5ZM3 13.5a5 5 0 0 1 10 0';
const I_CALENDAR = 'M3 4.5h10v9H3zM3 7h10M6 2.5v3M10 2.5v3';
const I_COPY = 'M5.5 5.5h7v7h-7zM10.5 5.5v-2h-7v7h2';
const I_MOVE = 'M8 2.5v11M2.5 8h11M8 2.5 5.5 5M8 2.5 10.5 5M8 13.5 5.5 11M8 13.5l2.5-2.5';
const I_OPEN = 'M9.5 2.5h4v4M13.5 2.5 8 8M12 9.5v3a1 1 0 0 1-1 1H3.5a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1h3';
const I_TRASH = 'M2.5 4h11M6 4V2.5h4V4M12 4v9a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V4M6.5 7v4M9.5 7v4';
const I_CHEVRON = 'M6 3.5 10.5 8 6 12.5';
const I_CHECK = 'M3 8.5 6.5 12 13 4.5';

function SubTrigger({ icon, children }: { icon: string; children: ReactNode }) {
  return (
    <ContextMenu.SubmenuTrigger className={ITEM}>
      <Icon d={icon} className="text-muted" />
      <span className="flex-1">{children}</span>
      <Icon d={I_CHEVRON} className="size-3 text-muted" />
    </ContextMenu.SubmenuTrigger>
  );
}

function Submenu({ children }: { children: ReactNode }) {
  return (
    <ContextMenu.Portal>
      <ContextMenu.Positioner side="right" align="start" sideOffset={4} className="outline-none">
        <ContextMenu.Popup className={POPUP}>{children}</ContextMenu.Popup>
      </ContextMenu.Positioner>
    </ContextMenu.Portal>
  );
}

/** A tick occupying fixed width, so labels stay aligned whether ticked or not. */
function Tick({ on }: { on: boolean }) {
  return on ? (
    <Icon d={I_CHECK} className="size-3.5 text-accent" />
  ) : (
    <span aria-hidden="true" className="size-3.5 shrink-0" />
  );
}

const PRIORITIES: Array<{ value: Priority; label: string; className: string }> = [
  { value: Priority.URGENT, label: 'Urgent', className: 'text-danger' },
  { value: Priority.HIGH, label: 'High', className: 'text-warning' },
  { value: Priority.MEDIUM, label: 'Medium', className: 'text-foreground' },
  { value: Priority.LOW, label: 'Low', className: 'text-muted' },
  { value: Priority.NONE, label: 'No priority', className: 'text-muted' },
];

/** Local calendar day, offset by `days`, as YYYY-MM-DD. */
function isoDay(days: number): string {
  const date = new Date();
  date.setDate(date.getDate() + days);
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${date.getFullYear()}-${month}-${day}`;
}

/* -------------------------------------------------------------------------- */

export function TicketContextMenu({
  ticket,
  columns,
  members,
  boards,
  projectKey,
  boardHref,
  onError,
  children,
}: TicketMenuProps) {
  const router = useRouter();
  const [, startTransition] = useTransition();
  const [copied, setCopied] = useState<string | null>(null);

  const ticketHref = `${boardHref}/${ticket.number}`;
  const ticketKey = `${projectKey}-${ticket.number}`;
  const currentColumn = columns.find((column) => column.tickets.some((t) => t.id === ticket.id));

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
    <ContextMenu.Root>
      <ContextMenu.Trigger className="outline-none">{children}</ContextMenu.Trigger>

      <ContextMenu.Portal>
        <ContextMenu.Positioner className="outline-none" side="bottom" align="start">
          <ContextMenu.Popup
            className={POPUP}
            onKeyDown={(event) => {
              // The one shortcut actually bound. Ctrl/Cmd guards against a
              // stray Delete press while merely browsing the menu.
              if (event.key === 'Delete' && (event.ctrlKey || event.metaKey)) {
                event.preventDefault();
                run(() => deleteTicketFromBoard({ ticketId: ticket.id }));
              }
            }}
          >
            <ContextMenu.Group>
              <ContextMenu.GroupLabel className={LABEL}>{ticketKey}</ContextMenu.GroupLabel>

              {/* Status -> the board's own columns */}
              <ContextMenu.SubmenuRoot>
                <SubTrigger icon={I_STATUS}>Status</SubTrigger>
                <Submenu>
                  {columns.map((column) => (
                    <ContextMenu.Item
                      key={column.id}
                      className={ITEM}
                      onClick={() =>
                        run(() =>
                          placeTicket({
                            ticketId: ticket.id,
                            toColumnId: column.id,
                            // Append; a precise index is what dragging is for.
                            toIndex: column.tickets.length,
                          }),
                        )
                      }
                    >
                      <Tick on={currentColumn?.id === column.id} />
                      {column.name}
                    </ContextMenu.Item>
                  ))}
                </Submenu>
              </ContextMenu.SubmenuRoot>

              {/* Priority */}
              <ContextMenu.SubmenuRoot>
                <SubTrigger icon={I_PRIORITY}>Priority</SubTrigger>
                <Submenu>
                  {PRIORITIES.map((option) => (
                    <ContextMenu.Item
                      key={option.value}
                      className={ITEM}
                      onClick={() =>
                        run(() =>
                          setTicketPriority({ ticketId: ticket.id, priority: option.value }),
                        )
                      }
                    >
                      <Tick on={ticket.priority === option.value} />
                      <span className={option.className}>{option.label}</span>
                    </ContextMenu.Item>
                  ))}
                </Submenu>
              </ContextMenu.SubmenuRoot>

              {/* Assignee -> members of THIS organization only */}
              <ContextMenu.SubmenuRoot>
                <SubTrigger icon={I_PERSON}>Assignee</SubTrigger>
                <Submenu>
                  <ContextMenu.Item
                    className={ITEM}
                    onClick={() =>
                      run(() => assignTicketFromBoard({ ticketId: ticket.id, assigneeId: '' }))
                    }
                  >
                    <Tick on={ticket.assigneeName === null} />
                    <span className="text-muted">Unassigned</span>
                  </ContextMenu.Item>
                  {members.map((member) => (
                    <ContextMenu.Item
                      key={member.id}
                      className={ITEM}
                      onClick={() =>
                        run(() =>
                          assignTicketFromBoard({ ticketId: ticket.id, assigneeId: member.id }),
                        )
                      }
                    >
                      <Tick on={ticket.assigneeName === member.name} />
                      {member.name}
                    </ContextMenu.Item>
                  ))}
                </Submenu>
              </ContextMenu.SubmenuRoot>

              {/* Due date -> quick relative choices, no calendar needed */}
              <ContextMenu.SubmenuRoot>
                <SubTrigger icon={I_CALENDAR}>Due date</SubTrigger>
                <Submenu>
                  {[
                    { label: 'Today', days: 0 },
                    { label: 'Tomorrow', days: 1 },
                    { label: 'Next week', days: 7 },
                  ].map((option) => (
                    <ContextMenu.Item
                      key={option.label}
                      className={ITEM}
                      onClick={() =>
                        run(() =>
                          setTicketDueDate({ ticketId: ticket.id, dueDate: isoDay(option.days) }),
                        )
                      }
                    >
                      <Tick on={false} />
                      {option.label}
                    </ContextMenu.Item>
                  ))}
                  <ContextMenu.Separator className="my-1 h-px bg-border" />
                  <ContextMenu.Item
                    className={ITEM}
                    disabled={ticket.dueDateLabel === null}
                    onClick={() => run(() => setTicketDueDate({ ticketId: ticket.id, dueDate: null }))}
                  >
                    <Tick on={false} />
                    <span className="text-muted">Clear due date</span>
                  </ContextMenu.Item>
                </Submenu>
              </ContextMenu.SubmenuRoot>
            </ContextMenu.Group>

            <ContextMenu.Separator className="my-1 h-px bg-border" />

            {/* Copy */}
            <ContextMenu.SubmenuRoot>
              <SubTrigger icon={I_COPY}>Copy</SubTrigger>
              <Submenu>
                <ContextMenu.Item
                  className={ITEM}
                  closeOnClick={false}
                  onClick={() => void copy(`${window.location.origin}${ticketHref}`, 'link')}
                >
                  <Tick on={copied === 'link'} />
                  Copy link
                </ContextMenu.Item>
                <ContextMenu.Item
                  className={ITEM}
                  closeOnClick={false}
                  onClick={() => void copy(ticketKey, 'id')}
                >
                  <Tick on={copied === 'id'} />
                  Copy ID
                </ContextMenu.Item>
                <ContextMenu.Item
                  className={ITEM}
                  closeOnClick={false}
                  onClick={() => void copy(ticket.title, 'title')}
                >
                  <Tick on={copied === 'title'} />
                  Copy title
                </ContextMenu.Item>
              </Submenu>
            </ContextMenu.SubmenuRoot>

            {/* Move -> a different board in the SAME project */}
            {boards.length > 1 ? (
              <ContextMenu.SubmenuRoot>
                <SubTrigger icon={I_MOVE}>Move to board</SubTrigger>
                <Submenu>
                  {boards.map((board) => (
                    <ContextMenu.Item
                      key={board.id}
                      className={ITEM}
                      disabled={boardHref.endsWith(board.id)}
                      onClick={() =>
                        run(() => moveTicketToBoard({ ticketId: ticket.id, toBoardId: board.id }))
                      }
                    >
                      <Tick on={boardHref.endsWith(board.id)} />
                      {board.name}
                    </ContextMenu.Item>
                  ))}
                </Submenu>
              </ContextMenu.SubmenuRoot>
            ) : null}

            {/* Open in */}
            <ContextMenu.SubmenuRoot>
              <SubTrigger icon={I_OPEN}>Open in</SubTrigger>
              <Submenu>
                <ContextMenu.Item className={ITEM} onClick={() => router.push(ticketHref)}>
                  <Tick on={false} />
                  This tab
                </ContextMenu.Item>
                <ContextMenu.Item
                  className={ITEM}
                  onClick={() => window.open(ticketHref, '_blank', 'noopener,noreferrer')}
                >
                  <Tick on={false} />
                  New tab
                </ContextMenu.Item>
              </Submenu>
            </ContextMenu.SubmenuRoot>

            <ContextMenu.Separator className="my-1 h-px bg-border" />

            <ContextMenu.Item
              className={DANGER}
              onClick={() => run(() => deleteTicketFromBoard({ ticketId: ticket.id }))}
            >
              <Icon d={I_TRASH} />
              <span className="flex-1">Delete</span>
              <kbd className="font-mono text-[0.6875rem] text-muted">Ctrl Del</kbd>
            </ContextMenu.Item>

            {/* Metadata footer, in the spirit of Notion's "Last edited by". */}
            <div className="mt-1 border-t border-border px-2.5 pt-2 pb-1 text-[0.6875rem] text-muted">
              Updated {ticket.updatedAtLabel}
              {ticket.dueDateLabel ? <> &middot; due {ticket.dueDateLabel}</> : null}
            </div>
          </ContextMenu.Popup>
        </ContextMenu.Positioner>
      </ContextMenu.Portal>
    </ContextMenu.Root>
  );
}
