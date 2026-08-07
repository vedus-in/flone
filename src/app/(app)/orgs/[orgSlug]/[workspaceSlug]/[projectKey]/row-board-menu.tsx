'use client';

/**
 * Change an issue's board from a list row.
 *
 * The board's card menu could already do this and the issue page now can too,
 * but the issues list -- the screen you actually triage from -- could not, so
 * refiling an issue meant opening it first.
 *
 * Deliberately just the board, not the whole card menu: `IssueMenuItems` is
 * built around board-shaped data (columns, a current board id, drag positions)
 * that a flat list does not have, and reshaping the list to feed it would be a
 * far bigger change than the one thing that is missing.
 *
 * `setIssueBoard` re-derives the session and re-resolves both the issue and the
 * destination board by walking up to the organization. This menu decides what to
 * OFFER, never what is permitted.
 */

import { useState, useTransition } from 'react';
import { Menu } from '@base-ui/react/menu';

import { cx } from '@/lib/utils/cx';

import { setIssueBoard } from './issue-actions';

export type RowBoardOption = { id: string; name: string };

const POPUP =
  'z-50 max-h-[min(24rem,70dvh)] min-w-52 origin-[var(--transform-origin)] overflow-y-auto overscroll-contain rounded-xl border border-secondary bg-primary p-1 shadow-2xl outline-none';

// `py-2` on touch: 44px-ish rows. `md:py-1.5` tightens it back up for a mouse.
const ITEM =
  'flex w-full cursor-default select-none items-center gap-2.5 rounded-lg px-2.5 py-2 text-sm text-primary outline-none data-[highlighted]:bg-secondary data-[disabled]:opacity-50 md:py-1.5';

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

const I_BOARD = 'M2.5 3.5h11v9h-11zM6 3.5v9M10 3.5v9';
const I_CHECK = 'M3 8.5 6.5 12 13 4.5';

/** A tick occupying fixed width, so names stay aligned whether ticked or not. */
function Tick({ on }: { on: boolean }) {
  return on ? (
    <Icon d={I_CHECK} className="size-3.5 text-brand-secondary" />
  ) : (
    <span aria-hidden="true" className="size-3.5 shrink-0" />
  );
}

type RowBoardMenuProps = {
  ticketId: string;
  /** For the trigger's accessible name, e.g. `ATLA-7`. */
  issueLabel: string;
  boardId: string | null;
  boards: RowBoardOption[];
};

export function RowBoardMenu({ ticketId, issueLabel, boardId, boards }: RowBoardMenuProps) {
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function choose(next: string) {
    startTransition(async () => {
      const result = await setIssueBoard({ ticketId, boardId: next });
      // Closing only on success keeps a failed write on screen with its reason,
      // instead of the menu vanishing and nothing appearing to have happened.
      if (result.ok) {
        setError(null);
        setOpen(false);
      } else {
        setError(result.error ?? 'Something went wrong.');
      }
    });
  }

  return (
    <Menu.Root open={open} onOpenChange={setOpen}>
      <Menu.Trigger
        aria-label={`Board for ${issueLabel}`}
        title="Change board"
        className="grid size-9 shrink-0 place-items-center rounded-md text-tertiary transition-colors hover:bg-secondary hover:text-primary focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring data-[popup-open]:bg-secondary data-[popup-open]:text-primary md:size-7"
      >
        <Icon d={I_BOARD} className="size-3.5" />
      </Menu.Trigger>
      <Menu.Portal>
        <Menu.Positioner side="bottom" align="end" sideOffset={4} className="z-50 outline-none">
          <Menu.Popup className={POPUP}>
            <Menu.Item
              className={ITEM}
              closeOnClick={false}
              disabled={pending}
              onClick={() => choose('')}
            >
              <Tick on={boardId === null} />
              <span className="text-tertiary">No board</span>
            </Menu.Item>
            {boards.map((board) => (
              <Menu.Item
                key={board.id}
                className={ITEM}
                closeOnClick={false}
                disabled={pending}
                onClick={() => choose(board.id)}
              >
                <Tick on={board.id === boardId} />
                {board.name}
              </Menu.Item>
            ))}
            {error ? (
              <p role="alert" className="px-2.5 pt-1.5 pb-1 text-xs text-error-primary">
                {error}
              </p>
            ) : null}
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
  );
}
