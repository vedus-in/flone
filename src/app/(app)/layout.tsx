import type { ReactNode } from 'react';
import Link from 'next/link';
import { listUserOrgs, loadPage, orgPath, requireUser } from '@/lib/authz';
import { SubmitButton } from '@/components/ui';
import { ActionForm } from './action-form';
import { signOut } from './actions';

/**
 * The authenticated shell.
 *
 * SPEC 3 hard prohibition 4: no caching directives under the authenticated tree.
 * `force-dynamic` is the belt-and-braces guard demanded by the spec -- and
 * `export const revalidate` / `dynamic = 'force-static'` / `unstable_cache` are
 * banned anywhere below this file.
 *
 * SPEC 3 hard prohibition 3: this redirect is UX, NOT authorization. Server
 * Actions are directly addressable POST endpoints that this layout never runs
 * for, so every action re-derives the session itself.
 */
export const dynamic = 'force-dynamic';

/** Beyond this many organizations the header links to the picker instead. */
const MAX_HEADER_ORGS = 6;

export default async function AppLayout({ children }: { children: ReactNode }) {
  const user = await loadPage(() => requireUser());
  const orgs = await loadPage(() => listUserOrgs());
  const shown = orgs.slice(0, MAX_HEADER_ORGS);

  return (
    <>
      <header className="site-header">
        <div className="container">
          <Link href="/" className="brand">
            Kanban
          </Link>

          {shown.length > 0 ? (
            <nav className="row" aria-label="Your organizations">
              {shown.map((org) => (
                <Link key={org.id} href={orgPath(org)} className="tab">
                  {org.name}
                </Link>
              ))}
              {orgs.length > shown.length ? (
                <Link href="/" className="tab">
                  All {orgs.length}
                </Link>
              ) : null}
            </nav>
          ) : null}

          <span className="spacer" />

          <span className="faint">{user.email}</span>

          <ActionForm action={signOut} aria-label="Sign out">
            <SubmitButton variant="ghost" size="sm" pendingLabel="Signing out...">
              Sign out
            </SubmitButton>
          </ActionForm>
        </div>
      </header>

      <main className="main">
        <div className="container">{children}</div>
      </main>
    </>
  );
}
