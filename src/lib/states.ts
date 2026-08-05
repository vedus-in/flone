import 'server-only';

import { prisma } from '@/lib/db';
import { DEFAULT_STATES } from '@/lib/model';
import { STATE_ORDER } from '@/lib/validation';

/**
 * Workflow-state reads and seeding.
 *
 * Deliberately NOT in a `'use server'` module: every export of one of those is a
 * directly addressable POST endpoint, and `ensureDefaultStates` takes a bare
 * `projectId` with no membership check of its own. Behind that boundary it would
 * be a cross-tenant write anyone could call.
 *
 * `projectId` must come from an authorized upward walk, exactly like
 * `requireStateInProject`.
 */

export type ProjectState = {
  id: string;
  name: string;
  type: import('@prisma/client').WorkflowStateType;
  color: string;
  position: number;
};

/**
 * Give a project the default workflow states if it has none, and return them.
 *
 * Called on read rather than only at creation, because a project with zero
 * states cannot render an issue list, cannot create an issue, and offers no way
 * out of that through the UI -- and the migration can leave one that way if a
 * project had no boards at all. Idempotent, and `skipDuplicates` keeps two
 * simultaneous first-loads from colliding on `(projectId, name)`.
 */
export async function ensureDefaultStates(projectId: string): Promise<ProjectState[]> {
  const existing = await prisma.workflowState.findMany({
    where: { projectId },
    orderBy: STATE_ORDER,
    select: { id: true, name: true, type: true, color: true, position: true },
  });
  if (existing.length > 0) return existing;

  await prisma.workflowState.createMany({
    data: DEFAULT_STATES.map((state) => ({ projectId, ...state })),
    skipDuplicates: true,
  });

  return prisma.workflowState.findMany({
    where: { projectId },
    orderBy: STATE_ORDER,
    select: { id: true, name: true, type: true, color: true, position: true },
  });
}

/** The project's states in BOARD order. */
export async function listStates(projectId: string): Promise<ProjectState[]> {
  return prisma.workflowState.findMany({
    where: { projectId },
    orderBy: STATE_ORDER,
    select: { id: true, name: true, type: true, color: true, position: true },
  });
}

/**
 * The state a new issue lands in when nothing else says otherwise: the first
 * one that is not a backlog, falling back to the very first.
 */
export function defaultComposeState(states: ProjectState[]): ProjectState | null {
  return states.find((state) => state.type !== 'BACKLOG') ?? states[0] ?? null;
}
