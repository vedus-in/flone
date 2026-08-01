import 'server-only';

import { prisma } from '@/lib/db';
import { requireUser } from '@/lib/authz';

/**
 * The navigation tree behind the sidebar: the caller's organizations, each with
 * its projects, each with its boards.
 *
 * Scoped by MEMBERSHIP at the root of the query -- every organization returned
 * is one the acting user belongs to, and projects/boards come back only as
 * nested relations of those rows. Nothing here is ever keyed off a
 * client-supplied id, so this cannot be turned into a cross-tenant read.
 *
 * The user id comes from the session via `requireUser()`, never from an argument.
 */

export type NavBoard = { id: string; name: string };
export type NavProject = { id: string; key: string; name: string; boards: NavBoard[] };
export type NavOrg = {
  id: string;
  name: string;
  slug: string;
  role: string;
  projects: NavProject[];
};

export async function listNavTree(): Promise<NavOrg[]> {
  const user = await requireUser();

  const memberships = await prisma.membership.findMany({
    where: { userId: user.id },
    orderBy: [{ organization: { name: 'asc' } }, { organizationId: 'asc' }],
    select: {
      role: true,
      organization: {
        select: {
          id: true,
          name: true,
          slug: true,
          projects: {
            orderBy: [{ name: 'asc' }, { id: 'asc' }],
            select: {
              id: true,
              key: true,
              name: true,
              boards: {
                orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
                select: { id: true, name: true },
              },
            },
          },
        },
      },
    },
  });

  return memberships.map((membership) => ({
    id: membership.organization.id,
    name: membership.organization.name,
    slug: membership.organization.slug,
    role: membership.role,
    projects: membership.organization.projects.map((project) => ({
      id: project.id,
      key: project.key,
      name: project.name,
      boards: project.boards.map((board) => ({ id: board.id, name: board.name })),
    })),
  }));
}
