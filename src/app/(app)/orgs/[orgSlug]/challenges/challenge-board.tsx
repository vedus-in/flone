'use client';

/**
 * The Daily Challenges board.
 *
 * Built on the same ReUI `Kanban` primitives as the project board, with two
 * deliberate differences that both follow from it spanning projects:
 *
 *   - Columns are keyed by CHALLENGE COLUMN id, not workflow-state id. Every
 *     project owns its own states, so there is no state id that means the same
 *     thing on two cards here. `moveChallenge` resolves the column back to a
 *     state of each issue's own project.
 *
 *   - Reordering is persisted on the PICK, not the issue. `Ticket.position` is
 *     dense within a (projectId, stateId) pair and has no meaning across
 *     projects, so a drop here renumbers `ChallengePick.position` across the
 *     whole board instead -- every card the board shows, in one list. The board
 *     is the complete set of the owner's picks in this organization, so there is
 *     nothing off-screen to land among and none of the `visibleIds` /
 *     `resolveIndex` machinery the project board needs applies.
 *
 * Each card still shows the status its OWN project calls the issue, because
 * "Done" here may well be "Shipped" there and the column name alone would be a
 * small lie.
 */

import { useEffect, useMemo, useState, useTransition } from 'react';
import Link from 'next/link';
import type { Priority } from '@prisma/client';

import {
  Kanban,
  KanbanBoard,
  KanbanColumn,
  KanbanColumnContent,
  KanbanItem,
  KanbanItemHandle,
  KanbanOverlay,
} from '@/components/reui/kanban';
import { PriorityIcon } from '@/components/issue-row';
import { FormError } from '@/components/ui';
import { CHALLENGE_COLUMNS, type ChallengeColumnId } from '@/lib/challenges';
import { colorClass } from '@/lib/model';
import { cx } from '@/lib/utils/cx';

import { moveChallenge, removeChallenge, reorderChallenges } from './actions';

export type ChallengeCard = {
  id: string;
  /** `VED-153`, already built on the server. */
  key: string;
  title: string;
  href: string;
  projectName: string;
  /** What the issue's own project calls its current status. */
  stateName: string;
  stateColor: string;
  priority: Priority;
  assigneeName: string | null;
  dueDateLabel: string | null;
  overdue: boolean;
};

export type ChallengeBoardData = Record<ChallengeColumnId, ChallengeCard[]>;

const I_CLOSE = 'M4 4l8 8M12 4l-8 8';

function Card({ card, overlay = false }: { card: ChallengeCard; overlay?: boolean }) {
  return (
    <div
      className={cx(
        'no-native-drag flex flex-col gap-2.5 rounded-lg border bg-primary p-3 transition-colors',
        overlay ? 'rotate-2 border-brand shadow-lg' : 'border-secondary shadow-xs hover:border-tertiary',
      )}
    >
      <div className="flex items-start gap-1">
        <Link
          href={card.href}
          // Same guard as the project board: keep the title clickable by holding
          // the press off the drag sensor and cancelling the browser's own
          // link-drag, which would otherwise ghost the text instead of the card.
          onPointerDown={(event) => event.stopPropagation()}
          draggable={false}
          onDragStart={(event) => event.preventDefault()}
          className="min-w-0 flex-1 text-sm leading-snug font-medium text-primary no-underline hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring"
        >
          {card.title}
        </Link>
      </div>

      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-tertiary">
        <PriorityIcon priority={card.priority} className="size-3" />
        <span className="font-mono tabular-nums">{card.key}</span>

        {/* Which project this came from, and what that project calls the status
            right now. On a board mixing four projects both are load-bearing. */}
        <span className="flex items-center gap-1">
          <span
            aria-hidden="true"
            className={cx('size-1.5 rounded-full', colorClass(card.stateColor).dot)}
          />
          {card.stateName}
        </span>

        {card.dueDateLabel ? (
          <span
            className={cx('whitespace-nowrap', card.overdue && 'font-medium text-error-primary')}
            title={card.overdue ? 'Overdue' : 'Due date'}
          >
            {card.dueDateLabel}
          </span>
        ) : null}
      </div>

      <div className="flex items-center gap-2 text-[0.6875rem] text-tertiary">
        <span className="min-w-0 truncate">{card.projectName}</span>
        {card.assigneeName ? <span className="ms-auto truncate">{card.assigneeName}</span> : null}
      </div>
    </div>
  );
}

export function ChallengeBoard({ data }: { data: ChallengeBoardData }) {
  const [records, setRecords] = useState<Record<string, ChallengeCard[]>>(data);
  const [error, setError] = useState<string | null>(null);
  const [, startTransition] = useTransition();

  // The server is the source of truth; new props drop the optimistic copy, which
  // is also what makes a rejected move snap back rather than linger.
  useEffect(() => {
    setRecords(data);
  }, [data]);

  const byId = useMemo(() => {
    const map = new Map<string, ChallengeCard>();
    for (const list of Object.values(records)) {
      for (const card of list) map.set(card.id, card);
    }
    return map;
  }, [records]);

  const total = useMemo(
    () => Object.values(records).reduce((sum, list) => sum + list.length, 0),
    [records],
  );

  function run(action: () => Promise<{ ok: boolean; error?: string }>) {
    startTransition(async () => {
      const result = await action();
      setError(result.ok ? null : (result.error ?? 'Something went wrong.'));
    });
  }

  return (
    <div className="flex flex-col gap-3">
      <FormError>{error}</FormError>

      <Kanban
        value={records}
        onValueChange={setRecords}
        getItemValue={(card) => card.id}
        restoreOnCancel
        onValueCommit={(next, meta) => {
          if (meta.kind !== 'item') return;

          const ticketId = String(meta.event.active.id);
          const column = meta.overContainer;

          // Dropping into Completed removes the pick, so the card must not sit
          // in that column even for the moment before revalidation lands --
          // "it disappears" is the whole contract of the column.
          const board = column === 'completed' ? { ...next, completed: [] } : next;
          if (column === 'completed') setRecords(board);

          // The whole board, read top-left to bottom-right. One list settles
          // both the order within a column and where a card landed in the
          // column it moved to.
          const ticketIds = CHALLENGE_COLUMNS.flatMap((c) =>
            (board[c.id] ?? []).map((card) => card.id),
          );

          startTransition(async () => {
            // A drop that stayed in its column is an ARRANGEMENT, never a
            // status: the column it sits in admits several states, and asking
            // for the column again would resolve to the canonical one -- out of
            // the backlog, or out of "In Review".
            const result =
              column === meta.activeContainer
                ? await reorderChallenges({ ticketIds })
                : await moveChallenge({ ticketId, column, order: ticketIds });
            if (!result.ok) {
              setRecords(meta.previousValue);
              setError(result.error);
            } else {
              setError(null);
            }
          });
        }}
      >
        <KanbanBoard className="flex flex-col gap-3 pb-4 md:-mx-6 md:flex-row md:overflow-x-auto md:px-6">
          {CHALLENGE_COLUMNS.map((column) => {
            const cards = records[column.id] ?? [];
            const clearing = column.sets === null;
            return (
              <KanbanColumn
                key={column.id}
                value={column.id}
                className={cx(
                  'flex w-full flex-col rounded-xl border bg-secondary/40 md:w-72 md:shrink-0',
                  clearing ? 'border-dashed border-brand/40' : 'border-secondary',
                )}
              >
                <header className="flex items-center gap-2 px-3 py-2.5">
                  <span
                    aria-hidden="true"
                    className={cx('size-2 rounded-full', colorClass(column.color).dot)}
                  />
                  <h2 className="text-xs font-semibold tracking-wide text-tertiary uppercase">
                    {column.name}
                  </h2>
                  {clearing ? null : (
                    <span className="rounded-full bg-secondary px-1.5 text-xs text-tertiary tabular-nums">
                      {cards.length}
                    </span>
                  )}
                </header>

                <KanbanColumnContent
                  value={column.id}
                  className="flex min-h-24 flex-1 flex-col gap-2 px-2 pb-2"
                >
                  {cards.map((card) => (
                    <KanbanItem key={card.id} value={card.id}>
                      <KanbanItemHandle className="no-native-drag group relative cursor-grab active:cursor-grabbing">
                        <Card card={card} />
                        {/* Same effect as dropping into Completed, for anyone
                            not dragging: keyboard, touch, or a mouse in a
                            hurry. It writes no status either. */}
                        <button
                          type="button"
                          aria-label={`Remove ${card.key} from my challenges`}
                          title="Remove from my challenges"
                          onPointerDown={(event) => event.stopPropagation()}
                          onClick={() => run(() => removeChallenge({ ticketId: card.id }))}
                          className="absolute end-1.5 top-1.5 grid size-7 place-items-center rounded-md text-tertiary opacity-0 transition-[opacity,color,background-color] hover:bg-secondary hover:text-primary focus-visible:opacity-100 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring group-hover:opacity-100"
                        >
                          <svg viewBox="0 0 16 16" fill="none" aria-hidden="true" className="size-3.5">
                            <path
                              d={I_CLOSE}
                              stroke="currentColor"
                              strokeWidth="1.5"
                              strokeLinecap="round"
                            />
                          </svg>
                        </button>
                      </KanbanItemHandle>
                    </KanbanItem>
                  ))}

                  {cards.length === 0 ? (
                    <p className="grid flex-1 place-items-center px-2 py-6 text-center text-xs text-tertiary">
                      {column.hint}
                    </p>
                  ) : null}
                </KanbanColumnContent>
              </KanbanColumn>
            );
          })}
        </KanbanBoard>

        <KanbanOverlay>
          {({ value }) => {
            const card = byId.get(String(value));
            if (!card) return null;
            return (
              <div className="w-72">
                <Card card={card} overlay />
              </div>
            );
          }}
        </KanbanOverlay>
      </Kanban>

      {total === 0 ? (
        <p className="text-sm text-tertiary">
          Nothing picked yet. Search below and add an issue to today&rsquo;s challenges &mdash; it
          stays on its own project&rsquo;s board too.
        </p>
      ) : null}
    </div>
  );
}
