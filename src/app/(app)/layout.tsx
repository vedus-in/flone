import type { ReactNode } from 'react';
import { isCurrentUserAdmin, loadPage, requireUser } from '@/lib/authz';
import { listNavTree } from '@/lib/nav';
import { AppShell, type ShellOrg } from './app-shell';

/**
 * The authenticated shell.
 *
 * SPEC 3 hard prohibition 4: no caching directives under the authenticated tree.
 * `force-dynamic` is the belt-and-braces guard demanded by the spec -- and
 * `export const revalidate` / `dynamic = 'force-static'` / `unstable_cache` are
 * banned anywhere below this file.
 *
 * SPEC 3 hard prohibition 3: the redirect inside `requireUser()` is UX, NOT
 * authorization. Server Actions are directly addressable POST endpoints that
 * this layout never runs for, so every action re-derives the session itself.
 *
 * Stays a Server Component: it resolves the session and the membership-scoped
 * navigation tree, then hands plain serializable props to `AppShell`. Hrefs are
 * built HERE because the path helpers live in `server-only` modules that the
 * client component rendering them cannot import.
 */
export const dynamic = 'force-dynamic';

export default async function AppLayout({ children }: { children: ReactNode }) {
  const user = await loadPage(() => requireUser());
  const tree = await loadPage(() => listNavTree());

  /**
   * Site administration, NOT tenant access. This only decides whether the nav
   * entry is painted; `/admin` and every action behind it re-derive the session
   * and call `requireAdmin()` themselves.
   */
  const isAdmin = await isCurrentUserAdmin();

  const orgs: ShellOrg[] = tree.map((org) => {
    const orgHref = `/orgs/${encodeURIComponent(org.slug)}`;
    return {
      id: org.id,
      name: org.name,
      slug: org.slug,
      role: org.role,
      href: orgHref,
      settingsHref: `${orgHref}/settings`,
      newWorkspaceHref: `${orgHref}#new-workspace`,
      projectCount: org.workspaces.reduce((total, w) => total + w.projects.length, 0),
      workspaces: org.workspaces.map((workspace) => {
        const workspaceHref = `${orgHref}/${encodeURIComponent(workspace.slug)}`;
        return {
          id: workspace.id,
          name: workspace.name,
          slug: workspace.slug,
          href: workspaceHref,
          settingsHref: `${workspaceHref}/settings`,
          newProjectHref: `${workspaceHref}#new-project`,
          projects: workspace.projects.map((project) => {
            const projectHref = `${workspaceHref}/${encodeURIComponent(project.key)}`;
            return {
              id: project.id,
              key: project.key,
              name: project.name,
              href: projectHref,
              issuesHref: `${projectHref}/issues`,
              cyclesHref: `${projectHref}/cycles`,
              currentCycleHref: `${projectHref}/cycles/current`,
              upcomingCyclesHref: `${projectHref}/cycles/upcoming`,
              boardsHref: `${projectHref}/boards`,
              viewsHref: `${projectHref}/views`,
            };
          }),
        };
      }),
    };
  });

  return (
    <AppShell
      orgs={orgs}
      userEmail={user.email}
      userName={user.name}
      isAdmin={isAdmin}
    >
      {children}
    </AppShell>
  );
}
