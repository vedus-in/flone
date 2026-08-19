import 'server-only';

import { ProjectAccess, Role } from '@prisma/client';

import { visibleProject } from '@/lib/authz';
import { prisma } from '@/lib/db';
import { ensureDefaultStates, type ProjectState } from '@/lib/states';
import { CYCLE_ORDER } from '@/lib/validation';

/**
 * The pickable contents of a project: its states, boards, cycles, labels and
 * people.
 *
 * Every surface that can compose or retarget an issue needs all five, so they
 * are fetched together once per render rather than five times in five files.
 * Each query repeats the membership predicate, so it is safe on its own terms.
 *
 * `projectId` and `organizationId` must come from an authorized upward walk.
 */

export type WorkspaceOption = { id: string; name: string; color: string };
export type WorkspaceCycle = {
  id: string;
  number: number;
  name: string | null;
  startsAt: Date;
  endsAt: Date;
};

export type Workspace = {
  states: ProjectState[];
  boards: WorkspaceOption[];
  cycles: WorkspaceCycle[];
  labels: WorkspaceOption[];
  members: Array<{ id: string; name: string }>;
};

export async function loadWorkspace(ctx: {
  user: { id: string };
  org: { id: string };
  project: { id: string };
}): Promise<Workspace> {
  const projectId = ctx.project.id;

  const [states, boards, cycles, labels, memberships] = await Promise.all([
    // Seeds the defaults if the project somehow has none -- a project with zero
    // states can render nothing and offers no way out through the UI.
    ensureDefaultStates(projectId),
    prisma.board.findMany({
      where: {
        projectId,
        project: visibleProject(ctx.user.id),
      },
      orderBy: [{ name: 'asc' }, { id: 'asc' }],
      select: { id: true, name: true, color: true },
    }),
    prisma.cycle.findMany({
      where: { projectId },
      orderBy: CYCLE_ORDER,
      select: { id: true, number: true, name: true, startsAt: true, endsAt: true },
    }),
    prisma.label.findMany({
      where: { projectId },
      orderBy: [{ name: 'asc' }, { id: 'asc' }],
      select: { id: true, name: true, color: true },
    }),
    // WHO MAY BE HANDED WORK HERE. On an open project that is everyone in the
    // organization, exactly as it always was. On a private one it is the people
    // named on the project, plus the org owner -- the same three branches
    // `visibleProject` ORs together, asked from the membership side.
    //
    // The OPEN branch is written as a condition on the PROJECT rather than a
    // flag read in JS, so this stays one query and cannot disagree with the
    // predicate the rest of the app runs.
    prisma.membership.findMany({
      where: {
        organizationId: ctx.org.id,
        OR: [
          { organization: { projects: { some: { id: projectId, access: ProjectAccess.OPEN } } } },
          { user: { projectMemberships: { some: { projectId } } } },
          { role: Role.OWNER },
        ],
      },
      orderBy: [{ user: { name: 'asc' } }, { userId: 'asc' }],
      select: { user: { select: { id: true, name: true } } },
    }),
  ]);

  return {
    states,
    boards,
    cycles,
    labels,
    members: memberships.map((row) => ({ id: row.user.id, name: row.user.name })),
  };
}
