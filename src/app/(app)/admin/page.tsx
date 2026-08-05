import type { Metadata } from 'next';
import { loadPage, requireAdmin } from '@/lib/authz';
import { prisma } from '@/lib/db';
import { getAppSettings } from '@/lib/settings';
import { Card, PageHeader } from '@/components/ui';
import { RegistrationControl, UserAdminTable, type AdminUserRow } from './admin-controls';

/**
 * Site administration.
 *
 * This route sits under the `(app)` group so it inherits the authenticated
 * shell, but it authorizes ITSELF: `requireAdmin()` below is the check that
 * matters. A parent layout is never sufficient -- it does not run for Server
 * Actions, and a route can always be reached by a path the layout does not
 * gate. `loadPage` turns FORBIDDEN into a 404, so a signed-in non-admin cannot
 * even learn that this page exists.
 *
 * Everything interactive lives in `admin-controls.tsx`; this file only reads and
 * hands plain data down.
 */

export const metadata: Metadata = {
  title: 'Site administration',
};

/**
 * Hard cap on the roster. The page is a flat list with no pagination, and an
 * instance with thousands of accounts should not render thousands of rows (or
 * ship them to the browser) just to flip one flag.
 */
const MAX_LISTED_USERS = 200;

/**
 * Fixed locale and zone so the server-rendered string is deterministic. Letting
 * it follow the host's locale would make the markup depend on the machine.
 */
const JOINED_FORMAT = new Intl.DateTimeFormat('en-US', {
  year: 'numeric',
  month: 'short',
  day: 'numeric',
  timeZone: 'UTC',
});

function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

export default async function AdminPage() {
  const admin = await loadPage(() => requireAdmin());

  const [settings, userCount, adminCount, rows] = await Promise.all([
    getAppSettings(),
    prisma.user.count(),
    prisma.user.count({ where: { isAdmin: true } }),
    // Only the columns the table renders. `passwordHash` is never selected
    // anywhere in this slice, and sessions are not touched at all.
    prisma.user.findMany({
      select: { id: true, name: true, email: true, isAdmin: true, createdAt: true },
      orderBy: [{ isAdmin: 'desc' }, { createdAt: 'asc' }, { id: 'asc' }],
      take: MAX_LISTED_USERS,
    }),
  ]);

  const users: AdminUserRow[] = rows.map((row) => ({
    id: row.id,
    name: row.name,
    email: row.email,
    isAdmin: row.isAdmin,
    isSelf: row.id === admin.id,
    joinedISO: row.createdAt.toISOString(),
    joinedLabel: JOINED_FORMAT.format(row.createdAt),
  }));

  const truncated = users.length < userCount;

  return (
    <div className="flex flex-col gap-8">
      <PageHeader
        title="Site administration"
        description="Instance-wide controls: who may join this deployment, and who administers it."
      />

      <Card>
        <Card.Header>
          <Card.Title>Registration</Card.Title>
          <Card.Description>
            Controls whether new people can create an account on this instance.
          </Card.Description>
        </Card.Header>
        <Card.Content>
          <RegistrationControl registrationEnabled={settings.registrationEnabled} />
        </Card.Content>
      </Card>

      <Card>
        <Card.Header>
          <Card.Title>Accounts</Card.Title>
          <Card.Description>
            {plural(userCount, 'account', 'accounts')} &middot;{' '}
            {plural(adminCount, 'administrator', 'administrators')}
          </Card.Description>
        </Card.Header>
        <Card.Content>
          <UserAdminTable users={users} adminCount={adminCount} />
        </Card.Content>
        {truncated ? (
          <Card.Footer>
            <p className="text-xs text-tertiary">
              Showing {users.length} of {userCount} accounts. Administrators are listed
              first, then the oldest accounts.
            </p>
          </Card.Footer>
        ) : null}
      </Card>
    </div>
  );
}
