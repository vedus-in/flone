import { WorkflowStateType } from '@prisma/client';

/**
 * The vocabulary of the Daily Challenges board.
 *
 * A cross-project board cannot use workflow-state ids as its columns: every
 * Project owns its own `WorkflowState` rows, so two projects' "In Progress" are
 * two different ids. The columns are therefore state TYPES -- the one vocabulary
 * every project shares -- and a drop resolves the type back to whichever state
 * of that type the dragged issue's OWN project happens to have.
 *
 * That indirection is the whole feature. Nothing is mirrored and nothing is
 * synced: an issue has exactly one status, so moving a card here writes the same
 * field the project board writes, and the two are the same fact.
 *
 * Deliberately not `server-only` and deliberately free of path aliases, for the
 * same reasons as `model.ts`: the board is a client component that needs the
 * same column order the server queried with, and `scripts/check-model.ts`
 * imports this straight from Node.
 */

export type ChallengeColumnId = 'todo' | 'in-progress' | 'done' | 'completed';

export type ChallengeColumn = {
  id: ChallengeColumnId;
  name: string;
  /** A token from the palette in `model.ts`, never a raw hex value. */
  color: string;
  /** State types whose issues appear in this column. */
  admits: readonly WorkflowStateType[];
  /**
   * The state type a drop into this column writes to the issue.
   *
   * `null` is the entire point of the Completed column: it writes NO status. It
   * deletes the pick, so the card leaves this board and only this board. That is
   * what makes "it disappears from the challenge board" a local gesture rather
   * than a second, conflicting notion of done.
   */
  sets: WorkflowStateType | null;
  hint: string;
};

/**
 * Left to right, as rendered.
 *
 * Two mappings here are load-bearing and non-obvious:
 *
 *   - To-do admits BACKLOG as well as UNSTARTED, but SETS only UNSTARTED.
 *     Cherry-picking something out of the backlog is the common case, and it
 *     should still show up where you put it; dragging it back left promotes it
 *     out of the backlog rather than burying it again.
 *
 *   - Done admits CANCELED as well as COMPLETED. A ticket someone cancels
 *     elsewhere must land in SOME column, or it would sit invisibly on a board
 *     with no way to clear it. Every member of `WorkflowStateType` is admitted
 *     by exactly one column, and `check-model` asserts it.
 */
export const CHALLENGE_COLUMNS: readonly ChallengeColumn[] = [
  {
    id: 'todo',
    name: 'To-do',
    color: 'gray',
    admits: [WorkflowStateType.BACKLOG, WorkflowStateType.UNSTARTED],
    sets: WorkflowStateType.UNSTARTED,
    hint: 'Picked, not started',
  },
  {
    id: 'in-progress',
    name: 'In Progress',
    color: 'warning',
    admits: [WorkflowStateType.STARTED],
    sets: WorkflowStateType.STARTED,
    hint: "What you're on now",
  },
  {
    id: 'done',
    name: 'Done',
    color: 'success',
    admits: [WorkflowStateType.COMPLETED, WorkflowStateType.CANCELED],
    sets: WorkflowStateType.COMPLETED,
    hint: 'Finished, everywhere',
  },
  {
    id: 'completed',
    name: 'Completed',
    color: 'brand',
    admits: [],
    sets: null,
    hint: 'Drop to clear from this board',
  },
] as const;

/** True for the one column that writes no status and empties itself. */
export function isClearingColumn(column: ChallengeColumn): boolean {
  return column.sets === null;
}

/**
 * The column an issue currently sitting in a state of this type belongs to.
 *
 * Total over `WorkflowStateType` by construction. A type admitted by no column
 * would strand a picked issue on a board that cannot show it, so this throws
 * rather than defaulting -- a sixth state type should fail the check script, not
 * silently swallow cards.
 */
export function columnForStateType(type: WorkflowStateType): ChallengeColumnId {
  const column = CHALLENGE_COLUMNS.find((candidate) => candidate.admits.includes(type));
  if (!column) throw new Error(`no challenge column admits ${type}`);
  return column.id;
}

/** Null for anything that is not a column id, so a forged value is rejected. */
export function challengeColumn(id: string): ChallengeColumn | null {
  return CHALLENGE_COLUMNS.find((column) => column.id === id) ?? null;
}
