import 'server-only';

import { prisma } from '@/lib/db';
import { requireUser, visibleProject } from '@/lib/authz';
import { WORKSPACE_ORDER } from '@/lib/validation';

/**
 * The navigation tree behind the sidebar: the caller's organizations, the
 * workspaces inside them, and the projects inside those.
 *
 * Boards are deliberately NOT loaded. A project row expands to a fixed set of
 * destinations -- Home, Issues, Cycles, Boards, Views -- so the sidebar does not
 * need, or want, a per-project board list: on an organization with a few dozen
 * boards that query ran on every single page render to build a tree nobody
 * navigates by.
 *
 * Workspaces ARE loaded, and that is a different trade: there are few of them,
 * they are the grouping the sidebar renders, and a project cannot be placed
 * without knowing which one owns it. One nested relation, no extra round trip.
 *
 * Their order is `Workspace.position`, arranged by an admin on the organization
 * page. It is the sidebar's only hand-set order; everything else is alphabetical.
 *
 * Scoped by MEMBERSHIP at the root of the query -- every organization returned
 * is one the acting user belongs to, and workspaces and projects come back only
 * as nested relations of those rows. Nothing here is ever keyed off a
 * client-supplied id, so this cannot be turned into a cross-tenant read.
 *
 * The user id comes from the session via `requireUser()`, never from an argument.
 */

export type NavProject = { id: string; key: string; name: string };
export type NavWorkspace = {
  id: string;
  name: string;
  slug: string;
  projects: NavProject[];
};
export type NavOrg = {
  id: string;
  name: string;
  slug: string;
  role: string;
  workspaces: NavWorkspace[];
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
          workspaces: {
            orderBy: WORKSPACE_ORDER,
            select: {
              id: true,
              name: true,
              slug: true,
              // The visibility predicate, on the nested relation rather than
              // the root: a workspace still lists, it simply lists fewer
              // projects. A private project the viewer is not on is absent from
              // the tree, which is the whole of "they stop seeing it" -- there
              // is no greyed-out row to notice and ask about.
              projects: {
                where: visibleProject(user.id),
                orderBy: [{ name: 'asc' }, { id: 'asc' }],
                select: { id: true, key: true, name: true },
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
    workspaces: membership.organization.workspaces.map((workspace) => ({
      id: workspace.id,
      name: workspace.name,
      slug: workspace.slug,
      projects: workspace.projects.map((project) => ({
        id: project.id,
        key: project.key,
        name: project.name,
      })),
    })),
  }));
}
