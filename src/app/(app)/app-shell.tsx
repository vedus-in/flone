'use client';

/**
 * The authenticated chrome: a persistent left sidebar for navigation and a top
 * header for context and account actions.
 *
 * This is a client module for exactly one reason -- the sidebar collapses to a
 * drawer on narrow screens, which needs open/closed state and the current
 * pathname to highlight the active organization. Everything it renders is data
 * the SERVER resolved and passed down as plain props; it performs no data access
 * and makes no authorization decision. `@/lib/authz` is `server-only`, so hrefs
 * are computed in the layout and arrive here already built.
 *
 * The nav is presentation. Every page and every Server Action behind these links
 * re-derives the session and re-checks authorization itself.
 */

import { useState, type ReactNode } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';

import { SubmitButton } from '@/components/ui';
import { ActionForm } from './action-form';
import { signOut } from './actions';

export type ShellOrg = {
  id: string;
  name: string;
  slug: string;
  role: string;
  href: string;
  settingsHref: string;
};

type AppShellProps = {
  orgs: ShellOrg[];
  userEmail: string;
  userName: string;
  isAdmin: boolean;
  children: ReactNode;
};

function cx(...values: Array<string | false | null | undefined>): string {
  return values.filter(Boolean).join(' ');
}

/* -------------------------------------------------------------------------- */
/* Icons — inline SVG.                                                         */
/* HeroUI's icon module is client-only with no public subpath export, so it     */
/* cannot be imported from the server tree. These are trivial enough to inline. */
/* -------------------------------------------------------------------------- */

function Icon({ path, className }: { path: string; className?: string }) {
  return (
    <svg
      viewBox="0 0 16 16"
      fill="none"
      aria-hidden="true"
      className={cx('size-4 shrink-0', className)}
    >
      <path
        d={path}
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

const PATH_BOARDS = 'M2.5 2.5h3v11h-3zM6.5 2.5h3v7h-3zM10.5 2.5h3v9h-3z';
const PATH_PEOPLE = 'M6 7.5a2.25 2.25 0 1 0 0-4.5 2.25 2.25 0 0 0 0 4.5ZM1.75 13.5a4.25 4.25 0 0 1 8.5 0M11 3.2a2.25 2.25 0 0 1 0 4.4M12.2 9.6a4.25 4.25 0 0 1 2.05 3.9';
const PATH_SHIELD = 'M8 1.75 13 3.5v4c0 3.2-2.1 5.6-5 6.75-2.9-1.15-5-3.55-5-6.75v-4z';
const PATH_PLUS = 'M8 3.5v9M3.5 8h9';
const PATH_MENU = 'M2.5 4.5h11M2.5 8h11M2.5 11.5h11';
const PATH_CLOSE = 'M4 4l8 8M12 4l-8 8';

/* -------------------------------------------------------------------------- */

function NavLink({
  href,
  label,
  iconPath,
  active,
  onNavigate,
  indented = false,
}: {
  href: string;
  label: string;
  iconPath?: string;
  active: boolean;
  onNavigate: () => void;
  indented?: boolean;
}) {
  return (
    <Link
      href={href}
      onClick={onNavigate}
      aria-current={active ? 'page' : undefined}
      className={cx(
        'flex items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-sm no-underline transition-colors',
        'outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus',
        indented && 'ms-3.5 ps-3 border-s border-border',
        active
          ? 'bg-surface-secondary font-medium text-foreground'
          : 'text-muted hover:bg-surface-secondary/60 hover:text-foreground',
      )}
    >
      {iconPath ? <Icon path={iconPath} /> : null}
      <span className="min-w-0 truncate">{label}</span>
    </Link>
  );
}

export function AppShell({ orgs, userEmail, userName, isAdmin, children }: AppShellProps) {
  const pathname = usePathname();
  const [drawerOpen, setDrawerOpen] = useState(false);
  const closeDrawer = () => setDrawerOpen(false);

  // The active org is derived from the URL rather than tracked in state, so a
  // back/forward navigation can never leave the highlight stale.
  const activeOrg = orgs.find(
    (org) => pathname === org.href || pathname.startsWith(`${org.href}/`),
  );

  const sidebar = (
    <div className="flex h-full flex-col gap-6 overflow-y-auto px-3 py-4">
      <Link
        href="/"
        onClick={closeDrawer}
        className="flex items-center gap-2.5 px-2.5 no-underline outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
      >
        <span aria-hidden="true" className="size-5 shrink-0 rounded-md bg-accent" />
        <span className="text-sm font-semibold tracking-tight text-foreground">Kanban</span>
      </Link>

      <nav aria-label="Organizations" className="flex flex-col gap-0.5">
        <p className="px-2.5 pb-1 text-[0.6875rem] font-medium tracking-wider text-muted uppercase">
          Organizations
        </p>

        {orgs.length === 0 ? (
          <p className="px-2.5 py-1 text-sm text-muted">None yet</p>
        ) : (
          orgs.map((org) => {
            const isActive = activeOrg?.id === org.id;
            return (
              <div key={org.id} className="flex flex-col gap-0.5">
                <NavLink
                  href={org.href}
                  label={org.name}
                  iconPath={PATH_BOARDS}
                  active={pathname === org.href}
                  onNavigate={closeDrawer}
                />
                {isActive ? (
                  <NavLink
                    href={org.settingsHref}
                    label="Members & settings"
                    active={pathname === org.settingsHref}
                    onNavigate={closeDrawer}
                    indented
                  />
                ) : null}
              </div>
            );
          })
        )}

        <NavLink
          href="/orgs/new"
          label="New organization"
          iconPath={PATH_PLUS}
          active={pathname === '/orgs/new'}
          onNavigate={closeDrawer}
        />
      </nav>

      <div className="mt-auto flex flex-col gap-0.5 border-t border-border pt-4">
        {isAdmin ? (
          <NavLink
            href="/admin"
            label="Site administration"
            iconPath={PATH_SHIELD}
            active={pathname === '/admin'}
            onNavigate={closeDrawer}
          />
        ) : null}

        <div className="flex items-center gap-2.5 px-2.5 py-2">
          <span
            aria-hidden="true"
            className="grid size-7 shrink-0 place-items-center rounded-full bg-surface-secondary text-xs font-medium text-muted"
          >
            {(userName.trim()[0] ?? '?').toLocaleUpperCase()}
          </span>
          <span className="flex min-w-0 flex-col">
            <span className="truncate text-sm text-foreground">{userName}</span>
            <span className="truncate text-xs text-muted" title={userEmail}>
              {userEmail}
            </span>
          </span>
        </div>
      </div>
    </div>
  );

  return (
    <div className="flex min-h-dvh">
      {/* Persistent rail from lg up. */}
      <aside className="hidden w-64 shrink-0 border-e border-border bg-surface lg:block">
        <div className="sticky top-0 h-dvh">{sidebar}</div>
      </aside>

      {/* Drawer below lg. */}
      {drawerOpen ? (
        <div className="fixed inset-0 z-50 lg:hidden">
          <button
            type="button"
            aria-label="Close navigation"
            onClick={closeDrawer}
            className="absolute inset-0 size-full bg-black/50"
          />
          <div className="absolute inset-y-0 start-0 w-64 border-e border-border bg-surface shadow-xl">
            {sidebar}
          </div>
        </div>
      ) : null}

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-40 border-b border-border bg-background/80 backdrop-blur-md">
          <div className="flex h-14 items-center gap-3 px-4 sm:px-6">
            <button
              type="button"
              onClick={() => setDrawerOpen(true)}
              aria-label="Open navigation"
              aria-expanded={drawerOpen}
              className="-ms-1 grid size-8 place-items-center rounded-lg text-muted transition-colors hover:bg-surface-secondary hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus lg:hidden"
            >
              <Icon path={drawerOpen ? PATH_CLOSE : PATH_MENU} />
            </button>

            <span className="min-w-0 truncate text-sm font-medium text-foreground">
              {activeOrg ? activeOrg.name : 'Kanban'}
            </span>

            <span className="flex-1" />

            {activeOrg ? (
              <span className="hidden text-[0.6875rem] font-medium tracking-wider text-muted uppercase sm:inline">
                {activeOrg.role}
              </span>
            ) : null}

            <ActionForm action={signOut} aria-label="Sign out" className="flex items-center">
              <SubmitButton variant="ghost" size="sm" pendingLabel="Signing out...">
                Sign out
              </SubmitButton>
            </ActionForm>
          </div>
        </header>

        <main className="mx-auto w-full max-w-6xl flex-1 px-4 py-8 sm:px-6 lg:py-10">
          {children}
        </main>
      </div>
    </div>
  );
}
