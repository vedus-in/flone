'use client';

/**
 * The authenticated chrome: a persistent left sidebar carrying the whole
 * navigation tree, and a slim header carrying context.
 *
 * Structure follows the Jira model -- an organization switcher at the top, then
 * that organization's projects with their boards nested beneath, so every board
 * is one click away instead of three. The account lives at the foot of the
 * sidebar behind an avatar menu, not as a bare "Sign out" in the header.
 *
 * A client module for exactly three reasons: the drawer needs open/closed
 * state, the project tree needs expand/collapse state, and the active item is
 * derived from `usePathname()`. Everything it renders is data the SERVER
 * resolved; it performs no data access and makes no authorization decision.
 * `@/lib/authz` is `server-only`, so hrefs arrive already built.
 */

import { useEffect, useMemo, useState, type ReactNode } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { Dropdown } from '@heroui/react/dropdown';

import { signOut } from './actions';

export type ShellBoard = { id: string; name: string; href: string };
export type ShellProject = {
  id: string;
  key: string;
  name: string;
  href: string;
  boards: ShellBoard[];
};
export type ShellOrg = {
  id: string;
  name: string;
  slug: string;
  role: string;
  href: string;
  settingsHref: string;
  newProjectHref: string;
  projects: ShellProject[];
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

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  const first = Array.from(parts[0])[0] ?? '';
  const last = parts.length > 1 ? (Array.from(parts[parts.length - 1])[0] ?? '') : '';
  return (first + last).toLocaleUpperCase();
}

/* -------------------------------------------------------------------------- */
/* Icons — inline SVG. HeroUI's icon module is client-only with no public       */
/* subpath export, so it cannot be reached from the server tree; these are      */
/* small enough to carry here.                                                  */
/* -------------------------------------------------------------------------- */

function Icon({ d, className }: { d: string; className?: string }) {
  return (
    <svg
      viewBox="0 0 16 16"
      fill="none"
      aria-hidden="true"
      className={cx('size-4 shrink-0', className)}
    >
      <path
        d={d}
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

const I_BOARD = 'M2.5 2.5h11v11h-11zM6 2.5v11M10 2.5v11';
const I_PEOPLE =
  'M6 7.5a2.25 2.25 0 1 0 0-4.5 2.25 2.25 0 0 0 0 4.5ZM1.75 13.5a4.25 4.25 0 0 1 8.5 0M11 3.2a2.25 2.25 0 0 1 0 4.4M12.2 9.6a4.25 4.25 0 0 1 2.05 3.9';
const I_SHIELD = 'M8 1.75 13 3.5v4c0 3.2-2.1 5.6-5 6.75-2.9-1.15-5-3.55-5-6.75v-4z';
const I_PLUS = 'M8 3.5v9M3.5 8h9';
const I_MENU = 'M2.5 4.5h11M2.5 8h11M2.5 11.5h11';
const I_CHEVRON = 'M6 3.5 10.5 8 6 12.5';
const I_SWITCH = 'M4 6.5 8 3l4 3.5M12 9.5 8 13l-4-3.5';

/* -------------------------------------------------------------------------- */

function NavRow({
  href,
  children,
  active,
  onNavigate,
  depth = 0,
  icon,
}: {
  href: string;
  children: ReactNode;
  active: boolean;
  onNavigate: () => void;
  depth?: number;
  icon?: string;
}) {
  return (
    <Link
      href={href}
      onClick={onNavigate}
      aria-current={active ? 'page' : undefined}
      style={{ paddingInlineStart: `${0.625 + depth * 0.875}rem` }}
      className={cx(
        'flex items-center gap-2 rounded-md py-1.5 pe-2 text-sm no-underline transition-colors',
        'outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus',
        active
          ? 'bg-accent-soft font-medium text-accent-soft-foreground'
          : 'text-muted hover:bg-surface-secondary hover:text-foreground',
      )}
    >
      {icon ? <Icon d={icon} /> : null}
      <span className="min-w-0 truncate">{children}</span>
    </Link>
  );
}

/* -------------------------------------------------------------------------- */

export function AppShell({ orgs, userEmail, userName, isAdmin, children }: AppShellProps) {
  const pathname = usePathname();
  const [drawerOpen, setDrawerOpen] = useState(false);
  const closeDrawer = () => setDrawerOpen(false);

  // Active org is derived from the URL, never tracked in state, so back/forward
  // can never leave the highlight stale.
  const activeOrg = useMemo(
    () => orgs.find((org) => pathname === org.href || pathname.startsWith(`${org.href}/`)) ?? orgs[0],
    [orgs, pathname],
  );

  const activeProject = useMemo(
    () =>
      activeOrg?.projects.find(
        (project) => pathname === project.href || pathname.startsWith(`${project.href}/`),
      ) ?? null,
    [activeOrg, pathname],
  );

  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  // Auto-open the project you are inside, without collapsing anything you
  // opened by hand.
  useEffect(() => {
    if (!activeProject) return;
    setExpanded((current) =>
      current.has(activeProject.id) ? current : new Set(current).add(activeProject.id),
    );
  }, [activeProject]);

  function toggleProject(id: string) {
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  const sidebar = (
    <div className="flex h-full flex-col">
      {/* Organization switcher */}
      <div className="border-b border-border p-2">
        {orgs.length === 0 ? (
          <Link
            href="/orgs/new"
            onClick={closeDrawer}
            className="flex items-center gap-2 rounded-lg px-2 py-2 text-sm text-muted no-underline hover:bg-surface-secondary hover:text-foreground"
          >
            <Icon d={I_PLUS} />
            New organization
          </Link>
        ) : (
          <Dropdown>
            <Dropdown.Trigger>
              <button
                type="button"
                className="flex w-full items-center gap-2.5 rounded-lg px-2 py-1.5 text-start transition-colors hover:bg-surface-secondary focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
              >
                <span
                  aria-hidden="true"
                  className="grid size-7 shrink-0 place-items-center rounded-md bg-accent text-xs font-semibold text-accent-foreground"
                >
                  {initials(activeOrg?.name ?? 'K')}
                </span>
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="truncate text-sm font-medium text-foreground">
                    {activeOrg?.name ?? 'Kanban'}
                  </span>
                  <span className="truncate text-[0.6875rem] text-muted">
                    {activeOrg ? activeOrg.role.toLowerCase() : 'no organization'}
                  </span>
                </span>
                <Icon d={I_SWITCH} className="size-3.5 text-muted" />
              </button>
            </Dropdown.Trigger>
            <Dropdown.Popover placement="bottom start" className="min-w-64">
              <Dropdown.Menu aria-label="Switch organization">
                <Dropdown.Section>
                  {orgs.map((org) => (
                    <Dropdown.Item
                      key={org.id}
                      id={org.id}
                      href={org.href}
                      textValue={org.name}
                    >
                      <span className="flex min-w-0 flex-1 flex-col">
                        <span className="truncate text-sm">{org.name}</span>
                        <span className="truncate text-xs text-muted">
                          {org.projects.length}{' '}
                          {org.projects.length === 1 ? 'project' : 'projects'}
                        </span>
                      </span>
                    </Dropdown.Item>
                  ))}
                </Dropdown.Section>
                <Dropdown.Item id="new-org" href="/orgs/new" textValue="New organization">
                  New organization
                </Dropdown.Item>
              </Dropdown.Menu>
            </Dropdown.Popover>
          </Dropdown>
        )}
      </div>

      {/* Project / board tree */}
      <nav aria-label="Projects" className="flex-1 overflow-y-auto p-2">
        {activeOrg ? (
          <>
            <div className="flex items-center justify-between px-2.5 pt-1 pb-1.5">
              <span className="text-[0.6875rem] font-semibold tracking-wider text-muted uppercase">
                Projects
              </span>
              <Link
                href={activeOrg.newProjectHref}
                onClick={closeDrawer}
                aria-label="New project"
                title="New project"
                className="grid size-5 place-items-center rounded text-muted hover:bg-surface-secondary hover:text-foreground"
              >
                <Icon d={I_PLUS} className="size-3.5" />
              </Link>
            </div>

            {activeOrg.projects.length === 0 ? (
              <p className="px-2.5 py-2 text-sm text-muted">No projects yet</p>
            ) : (
              <ul className="flex flex-col gap-0.5">
                {activeOrg.projects.map((project) => {
                  const isOpen = expanded.has(project.id);
                  return (
                    <li key={project.id} className="flex flex-col gap-0.5">
                      <div className="flex items-center">
                        <button
                          type="button"
                          onClick={() => toggleProject(project.id)}
                          aria-expanded={isOpen}
                          aria-label={`${isOpen ? 'Collapse' : 'Expand'} ${project.name}`}
                          className="grid size-6 shrink-0 place-items-center rounded text-muted hover:text-foreground"
                        >
                          <Icon
                            d={I_CHEVRON}
                            className={cx('size-3 transition-transform', isOpen && 'rotate-90')}
                          />
                        </button>
                        <Link
                          href={project.href}
                          onClick={closeDrawer}
                          aria-current={pathname === project.href ? 'page' : undefined}
                          className={cx(
                            'flex min-w-0 flex-1 items-center gap-2 rounded-md px-1.5 py-1.5 text-sm no-underline transition-colors',
                            pathname === project.href
                              ? 'bg-accent-soft font-medium text-accent-soft-foreground'
                              : 'text-foreground hover:bg-surface-secondary',
                          )}
                        >
                          <span className="truncate">{project.name}</span>
                          <span className="ms-auto shrink-0 font-mono text-[0.625rem] text-muted">
                            {project.key}
                          </span>
                        </Link>
                      </div>

                      {isOpen ? (
                        <ul className="flex flex-col gap-0.5">
                          {project.boards.length === 0 ? (
                            <li className="ps-9 text-xs text-muted">No boards</li>
                          ) : (
                            project.boards.map((board) => (
                              <li key={board.id}>
                                <NavRow
                                  href={board.href}
                                  active={
                                    pathname === board.href || pathname.startsWith(`${board.href}/`)
                                  }
                                  onNavigate={closeDrawer}
                                  depth={2}
                                  icon={I_BOARD}
                                >
                                  {board.name}
                                </NavRow>
                              </li>
                            ))
                          )}
                        </ul>
                      ) : null}
                    </li>
                  );
                })}
              </ul>
            )}

            <div className="mt-4 flex flex-col gap-0.5 border-t border-border pt-3">
              <NavRow
                href={activeOrg.settingsHref}
                active={pathname === activeOrg.settingsHref}
                onNavigate={closeDrawer}
                icon={I_PEOPLE}
              >
                Members &amp; settings
              </NavRow>
              {isAdmin ? (
                <NavRow
                  href="/admin"
                  active={pathname === '/admin'}
                  onNavigate={closeDrawer}
                  icon={I_SHIELD}
                >
                  Site administration
                </NavRow>
              ) : null}
            </div>
          </>
        ) : null}
      </nav>

      {/* Account */}
      <div className="border-t border-border p-2">
        <Dropdown>
          <Dropdown.Trigger>
            <button
              type="button"
              className="flex w-full items-center gap-2.5 rounded-lg px-2 py-1.5 text-start transition-colors hover:bg-surface-secondary focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
            >
              <span
                aria-hidden="true"
                className="grid size-7 shrink-0 place-items-center rounded-full bg-surface-secondary text-xs font-medium text-foreground"
              >
                {initials(userName)}
              </span>
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="truncate text-sm text-foreground">{userName}</span>
                <span className="truncate text-[0.6875rem] text-muted">{userEmail}</span>
              </span>
              <Icon d={I_SWITCH} className="size-3.5 text-muted" />
            </button>
          </Dropdown.Trigger>
          <Dropdown.Popover placement="top start" className="min-w-56">
            <Dropdown.Menu aria-label="Account">
              <Dropdown.Section>
                <Dropdown.Item id="account" textValue={userEmail} isDisabled>
                  <span className="flex min-w-0 flex-col">
                    <span className="truncate text-sm">{userName}</span>
                    <span className="truncate text-xs text-muted">{userEmail}</span>
                  </span>
                </Dropdown.Item>
              </Dropdown.Section>
              <Dropdown.Item id="tokens" href="/tokens" textValue="MCP access">
                MCP access
              </Dropdown.Item>
              {isAdmin ? (
                <Dropdown.Item id="admin" href="/admin" textValue="Site administration">
                  Site administration
                </Dropdown.Item>
              ) : null}
              <Dropdown.Item
                id="sign-out"
                textValue="Sign out"
                variant="danger"
                onAction={() => {
                  // Server Actions are invoked over POST however they are
                  // called, so sign-out keeps its POST-only semantics here: the
                  // session row is deleted server-side, not merely un-cookied.
                  // The action's signature is the useActionState one, hence the
                  // empty previous-state and FormData arguments.
                  void signOut(null, new FormData());
                }}
              >
                Sign out
              </Dropdown.Item>
            </Dropdown.Menu>
          </Dropdown.Popover>
        </Dropdown>
      </div>
    </div>
  );

  return (
    <div className="flex min-h-dvh">
      <aside className="hidden w-64 shrink-0 border-e border-border bg-surface lg:block">
        <div className="sticky top-0 h-dvh">{sidebar}</div>
      </aside>

      {drawerOpen ? (
        <div className="fixed inset-0 z-50 lg:hidden">
          <button
            type="button"
            aria-label="Close navigation"
            onClick={closeDrawer}
            className="absolute inset-0 size-full bg-black/60"
          />
          <div className="absolute inset-y-0 start-0 w-72 border-e border-border bg-surface shadow-2xl">
            {sidebar}
          </div>
        </div>
      ) : null}

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-40 flex h-12 items-center gap-2 border-b border-border bg-background/80 px-4 backdrop-blur-md sm:px-6">
          <button
            type="button"
            onClick={() => setDrawerOpen(true)}
            aria-label="Open navigation"
            className="-ms-1 grid size-8 place-items-center rounded-md text-muted transition-colors hover:bg-surface-secondary hover:text-foreground lg:hidden"
          >
            <Icon d={I_MENU} />
          </button>

          <nav aria-label="Breadcrumb" className="flex min-w-0 items-center gap-1.5 text-sm">
            {activeOrg ? (
              <Link
                href={activeOrg.href}
                className="truncate text-muted no-underline hover:text-foreground"
              >
                {activeOrg.name}
              </Link>
            ) : null}
            {activeProject ? (
              <>
                <Icon d={I_CHEVRON} className="size-3 text-muted opacity-60" />
                <Link
                  href={activeProject.href}
                  className="truncate font-medium text-foreground no-underline hover:underline"
                >
                  {activeProject.name}
                </Link>
              </>
            ) : null}
          </nav>
        </header>

        <main className="mx-auto w-full max-w-7xl flex-1 px-4 py-6 sm:px-6 lg:py-8">
          {children}
        </main>
      </div>
    </div>
  );
}
