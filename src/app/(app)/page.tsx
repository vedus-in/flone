import type { Metadata } from 'next';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { listUserOrgs, loadPage, orgPath } from '@/lib/authz';
import { Badge, ButtonLink } from '@/components/ui';

export const metadata: Metadata = { title: 'Organizations' };

/**
 * SPEC 5 -- the `/` dispatcher.
 *
 *   0 organizations -> /orgs/new (first-run copy lives there)
 *   1 organization  -> straight into it
 *   2 or more       -> the picker below
 *
 * `redirect()` throws, so it is called outside `loadPage`'s try/catch.
 */
export default async function HomePage() {
  const orgs = await loadPage(() => listUserOrgs());

  if (orgs.length === 0) redirect('/orgs/new');

  const only = orgs.length === 1 ? orgs[0] : undefined;
  if (only) redirect(orgPath(only));

  return (
    <>
      <div className="page-head">
        <div className="stack-sm">
          <h1>Your organizations</h1>
          <p className="muted">Pick an organization to see its projects.</p>
        </div>
        <ButtonLink href="/orgs/new">New organization</ButtonLink>
      </div>

      <div className="grid">
        {orgs.map((org) => (
          <Link key={org.id} href={orgPath(org)} className="card card-link">
            <div className="stack-sm">
              <div className="row">
                <h2>{org.name}</h2>
                <Badge tone="accent">{org.role}</Badge>
              </div>
              <p className="faint mono">/orgs/{org.slug}</p>
            </div>
          </Link>
        ))}
      </div>
    </>
  );
}
