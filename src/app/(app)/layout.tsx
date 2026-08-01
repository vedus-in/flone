import type { ReactNode } from 'react';
import {
  isCurrentUserAdmin,
  listUserOrgs,
  loadPage,
  orgPath,
  requireUser,
} from '@/lib/authz';
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
 * This file stays a Server Component: it resolves the session and the nav data,
 * then hands plain serializable props to `AppShell`. Hrefs are built HERE
 * because `@/lib/authz` is `server-only` and cannot be reached from the client
 * component that renders them.
 */
export const dynamic = 'force-dynamic';

export default async function AppLayout({ children }: { children: ReactNode }) {
  const user = await loadPage(() => requireUser());
  const orgs = await loadPage(() => listUserOrgs());

  /**
   * Site administration, NOT tenant access. This only decides whether the nav
   * entry is painted; `/admin` and every action behind it re-derive the session
   * and call `requireAdmin()` themselves.
   */
  const isAdmin = await isCurrentUserAdmin();

  const shellOrgs: ShellOrg[] = orgs.map((org) => {
    const href = orgPath(org);
    return {
      id: org.id,
      name: org.name,
      slug: org.slug,
      role: org.role,
      href,
      settingsHref: `${href}/settings`,
    };
  });

  return (
    <AppShell
      orgs={shellOrgs}
      userEmail={user.email}
      userName={user.name}
      isAdmin={isAdmin}
    >
      {children}
    </AppShell>
  );
}
