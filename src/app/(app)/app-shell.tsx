'use client';

/**
 * The authenticated chrome: a persistent left sidebar carrying the whole
 * navigation tree, and a slim header carrying context.
 *
 * Structure follows the Linear model -- a workspace switcher at the top, then
 * collapsible sections, then the project tree with its boards nested beneath an
 * indent guide, so every board is one click away instead of three. The account
 * lives at the foot of the sidebar behind an avatar menu, not as a bare
 * "Sign out" in the header.
 *
 * Rows are 28px and 13px type on purpose: this density is the whole point of the
 * look. The active row is a neutral wash rather than an accent tint -- colour in
 * the sidebar competes with colour on the board.
 *
 * A client module for exactly four reasons: the drawer needs open/closed state,
 * the sections and the project tree need expand/collapse state, and the active
 * item is derived from `usePathname()`. Everything it renders is data the SERVER
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
const I_CUBE = 'M8 1.75 13.75 5v6L8 14.25 2.25 11V5zM2.25 5 8 8.25 13.75 5M8 8.25v6';
const I_PEOPLE =
  'M6 7.5a2.25 2.25 0 1 0 0-4.5 2.25 2.25 0 0 0 0 4.5ZM1.75 13.5a4.25 4.25 0 0 1 8.5 0M11 3.2a2.25 2.25 0 0 1 0 4.4M12.2 9.6a4.25 4.25 0 0 1 2.05 3.9';
const I_PLUS = 'M8 3.5v9M3.5 8h9';
const I_MENU = 'M2.5 4.5h11M2.5 8h11M2.5 11.5h11';
const I_CHEVRON = 'M6 3.5 10.5 8 6 12.5';
const I_CARET = 'm4.5 6.5 3.5 3.5 3.5-3.5';
const I_SWITCH = 'M4 6.5 8 3l4 3.5M12 9.5 8 13l-4-3.5';

/* -------------------------------------------------------------------------- */

/**
 * A collapsible sidebar group. The heading is the toggle, so the whole label is
 * the hit target rather than a 12px chevron.
 */
function Section({
  title,
  action,
  children,
}: {
  title: string;
  action?: ReactNode;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(true);
  return (
    <div className="flex flex-col">
      <div className="flex items-center gap-0.5 pe-1">
        <button
          type="button"
          onClick={() => setOpen((value) => !value)}
          aria-expanded={open}
          className="flex min-w-0 flex-1 items-center gap-1 rounded px-2 py-1 text-start text-xs font-medium text-muted transition-colors hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-focus"
        >
          <span className="truncate">{title}</span>
          <Icon
            d={I_CARET}
            className={cx('size-3 opacity-70 transition-transform', !open && '-rotate-90')}
          />
        </button>
        {action}
      </div>
      {open ? <ul className="flex flex-col gap-px">{children}</ul> : null}
    </div>
  );
}

function NavRow({
  href,
  children,
  active,
  onNavigate,
  icon,
  indented = false,
}: {
  href: string;
  children: ReactNode;
  active: boolean;
  onNavigate: () => void;
  icon?: string;
  indented?: boolean;
}) {
  return (
    <Link
      href={href}
      onClick={onNavigate}
      aria-current={active ? 'page' : undefined}
      className={cx(
        'flex h-7 items-center gap-2 rounded-md pe-2 text-[0.8125rem] no-underline transition-colors',
        'outline-none focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-focus',
        indented ? 'ps-1.5' : 'ps-2',
        active
          ? 'bg-surface-secondary font-medium text-foreground'
          : 'text-muted hover:bg-surface-secondary hover:text-foreground',
      )}
    >
      {icon ? <Icon d={icon} className="size-3.5 opacity-80" /> : null}
      <span className="min-w-0 truncate">{children}</span>
    </Link>
  );
}

/** The small square button that sits beside a section heading. */
function SectionAction({
  href,
  label,
  onNavigate,
}: {
  href: string;
  label: string;
  onNavigate: () => void;
}) {
  return (
    <Link
      href={href}
      onClick={onNavigate}
      aria-label={label}
      title={label}
      className="grid size-5 shrink-0 place-items-center rounded text-muted transition-colors hover:bg-surface-secondary hover:text-foreground"
    >
      <Icon d={I_PLUS} className="size-3.5" />
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
      {/* Workspace switcher */}
      <div className="p-2">
        {orgs.length === 0 ? (
          <Link
            href="/orgs/new"
            onClick={closeDrawer}
            className="flex h-8 items-center gap-2 rounded-md px-2 text-[0.8125rem] text-muted no-underline hover:bg-surface-secondary hover:text-foreground"
          >
            <Icon d={I_PLUS} className="size-3.5" />
            New organization
          </Link>
        ) : (
          <Dropdown>
            <Dropdown.Trigger>
              <button
                type="button"
                className="flex h-8 w-full items-center gap-2 rounded-md px-1.5 text-start transition-colors hover:bg-surface-secondary focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-focus"
              >
                <span
                  aria-hidden="true"
                  className="grid size-5 shrink-0 place-items-center rounded bg-accent text-[0.625rem] font-semibold text-accent-foreground"
                >
                  {initials(activeOrg?.name ?? 'K')}
                </span>
                <span className="min-w-0 flex-1 truncate text-[0.8125rem] font-medium text-foreground">
                  {activeOrg?.name ?? 'Kanban'}
                </span>
                <Icon d={I_CARET} className="size-3 text-muted" />
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

      {/* Sections */}
      <nav aria-label="Navigation" className="flex flex-1 flex-col gap-4 overflow-y-auto px-2 pb-2">
        {activeOrg ? (
          <>
            <Section title="Workspace">
              <li>
                <NavRow
                  href={activeOrg.href}
                  active={pathname === activeOrg.href}
                  onNavigate={closeDrawer}
                  icon={I_CUBE}
                >
                  Projects
                </NavRow>
              </li>
              <li>
                <NavRow
                  href={activeOrg.settingsHref}
                  active={pathname === activeOrg.settingsHref}
                  onNavigate={closeDrawer}
                  icon={I_PEOPLE}
                >
                  Members &amp; settings
                </NavRow>
              </li>
            </Section>

            <Section
              title="Your projects"
              action={
                <SectionAction
                  href={activeOrg.newProjectHref}
                  label="New project"
                  onNavigate={closeDrawer}
                />
              }
            >
              {activeOrg.projects.length === 0 ? (
                <li className="px-2 py-1 text-[0.8125rem] text-muted">No projects yet</li>
              ) : (
                activeOrg.projects.map((project) => {
                  const isOpen = expanded.has(project.id);
                  const isActive = pathname === project.href;
                  return (
                    <li key={project.id}>
                      <div
                        className={cx(
                          'flex h-7 items-center gap-0.5 rounded-md pe-2 ps-0.5 transition-colors',
                          isActive ? 'bg-surface-secondary' : 'hover:bg-surface-secondary',
                        )}
                      >
                        <button
                          type="button"
                          onClick={() => toggleProject(project.id)}
                          aria-expanded={isOpen}
                          aria-label={`${isOpen ? 'Collapse' : 'Expand'} ${project.name}`}
                          className="grid size-5 shrink-0 place-items-center rounded text-muted transition-colors hover:text-foreground"
                        >
                          <Icon
                            d={I_CHEVRON}
                            className={cx('size-3 transition-transform', isOpen && 'rotate-90')}
                          />
                        </button>
                        <Link
                          href={project.href}
                          onClick={closeDrawer}
                          aria-current={isActive ? 'page' : undefined}
                          className={cx(
                            'flex min-w-0 flex-1 items-center gap-2 text-[0.8125rem] no-underline outline-none focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-focus',
                            isActive ? 'font-medium text-foreground' : 'text-muted',
                          )}
                        >
                          <Icon d={I_CUBE} className="size-3.5 opacity-80" />
                          <span className="truncate">{project.name}</span>
                        </Link>
                        <span className="shrink-0 font-mono text-[0.625rem] text-muted">
                          {project.key}
                        </span>
                      </div>

                      {/* The rule is the indent guide: it ties a board back to
                          the project it hangs off, which plain padding does not. */}
                      {isOpen ? (
                        <ul className="ms-3.5 flex flex-col gap-px border-s border-border ps-1">
                          {project.boards.length === 0 ? (
                            <li className="ps-2 py-1 text-xs text-muted">No boards</li>
                          ) : (
                            project.boards.map((board) => (
                              <li key={board.id}>
                                <NavRow
                                  href={board.href}
                                  active={
                                    pathname === board.href || pathname.startsWith(`${board.href}/`)
                                  }
                                  onNavigate={closeDrawer}
                                  icon={I_BOARD}
                                  indented
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
                })
              )}
            </Section>
          </>
        ) : null}
      </nav>

      {/* Account */}
      <div className="p-2">
        <Dropdown>
          <Dropdown.Trigger>
            <button
              type="button"
              className="flex h-8 w-full items-center gap-2 rounded-md px-1.5 text-start transition-colors hover:bg-surface-secondary focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-focus"
            >
              <span
                aria-hidden="true"
                className="grid size-5 shrink-0 place-items-center rounded-full bg-surface-secondary text-[0.625rem] font-medium text-foreground"
              >
                {initials(userName)}
              </span>
              <span className="min-w-0 flex-1 truncate text-[0.8125rem] text-muted">
                {userName}
              </span>
              <Icon d={I_SWITCH} className="size-3 text-muted" />
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
      <aside className="hidden w-56 shrink-0 border-e border-border bg-surface lg:block">
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
          <div className="absolute inset-y-0 start-0 w-64 border-e border-border bg-surface shadow-2xl">
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
