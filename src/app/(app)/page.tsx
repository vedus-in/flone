import type { Metadata } from 'next';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { listUserOrgs, loadPage, orgPath } from '@/lib/authz';
import { Badge, ButtonLink, Card, PageHeader } from '@/components/ui';

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
    <div className="flex flex-col gap-8">
      <PageHeader
        title="Your organizations"
        description="Each one is a separate workspace. Nothing is shared between them."
        actions={<ButtonLink href="/orgs/new">New organization</ButtonLink>}
      />

      <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {orgs.map((org) => (
          <li key={org.id}>
            {/* The title's `::after` covers the card, so the whole tile is one
                link -- one tab stop, one accessible name, no nested anchors. */}
            <Card className="h-full gap-2 transition-colors hover:bg-primary_hover has-[a:focus-visible]:outline-2 has-[a:focus-visible]:outline-offset-2 has-[a:focus-visible]:outline-focus-ring">
              <Card.Header className="flex-row items-start justify-between gap-3">
                <Card.Title className="min-w-0 text-base">
                  <Link
                    href={orgPath(org)}
                    className="rounded-sm outline-none after:absolute after:inset-0 after:content-['']"
                  >
                    {org.name}
                  </Link>
                </Card.Title>
                <Badge tone="accent">{org.role}</Badge>
              </Card.Header>
              <Card.Content>
                <Card.Description className="truncate font-mono text-xs">
                  /orgs/{org.slug}
                </Card.Description>
              </Card.Content>
            </Card>
          </li>
        ))}
      </ul>
    </div>
  );
}
