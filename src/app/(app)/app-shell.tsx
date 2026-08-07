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
import { Button as AriaButton } from 'react-aria-components';
import { Dropdown } from '@/components/base/dropdown/dropdown';

import { signOut } from './actions';

/**
 * The fixed destinations under a project. Built on the SERVER (`@/lib/authz` is
 * `server-only`), so hrefs arrive already made -- this module never constructs
 * a path from a slug it was handed.
 */
export type ShellProject = {
  id: string;
  key: string;
  name: string;
  href: string;
  issuesHref: string;
  cyclesHref: string;
  currentCycleHref: string;
  upcomingCyclesHref: string;
  boardsHref: string;
  viewsHref: string;
};
/** A named grouping of projects. The section header the project rows hang off. */
export type ShellWorkspace = {
  id: string;
  name: string;
  slug: string;
  href: string;
  settingsHref: string;
  newProjectHref: string;
  projects: ShellProject[];
};
export type ShellOrg = {
  id: string;
  name: string;
  slug: string;
  role: string;
  href: string;
  settingsHref: string;
  newWorkspaceHref: string;
  /** Flattened across workspaces, for the switcher's subtitle. */
  projectCount: number;
  workspaces: ShellWorkspace[];
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
/* Icons — inline SVG. These predate the design system and are sized to this    */
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
const I_HOME = 'M2.5 6.75 8 2.5l5.5 4.25v6.25h-11zM6.25 13v-4h3.5v4';
const I_ISSUES = 'M2.5 4h11M2.5 8h11M2.5 12h7';
const I_CYCLE = 'M8 14.5A6.5 6.5 0 1 0 8 1.5a6.5 6.5 0 0 0 0 13ZM8 4.5v3.7l2.2 1.6';
const I_VIEWS = 'M1.5 8S4 3.5 8 3.5 14.5 8 14.5 8 12 12.5 8 12.5 1.5 8 1.5 8ZM8 9.75a1.75 1.75 0 1 0 0-3.5 1.75 1.75 0 0 0 0 3.5Z';
const I_FOLDER =
  'M2.25 5.25A1.5 1.5 0 0 1 3.75 3.75h2.19c.4 0 .78.16 1.06.44l.81.81h4.44a1.5 1.5 0 0 1 1.5 1.5v5.25a1.5 1.5 0 0 1-1.5 1.5h-8.5a1.5 1.5 0 0 1-1.5-1.5z';

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
          className="flex min-w-0 flex-1 items-center gap-1 rounded px-2 py-1 text-start text-xs font-medium text-tertiary transition-colors hover:text-primary focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-focus-ring"
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
        'outline-none focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-focus-ring',
        indented ? 'ps-1.5' : 'ps-2',
        active
          ? 'bg-secondary font-medium text-primary'
          : 'text-tertiary hover:bg-secondary hover:text-primary',
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
      className="grid size-5 shrink-0 place-items-center rounded text-tertiary transition-colors hover:bg-secondary hover:text-primary"
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

  const activeWorkspace = useMemo(
    () =>
      activeOrg?.workspaces.find(
        (workspace) =>
          pathname === workspace.href || pathname.startsWith(`${workspace.href}/`),
      ) ?? null,
    [activeOrg, pathname],
  );

  const activeProject = useMemo(
    () =>
      activeWorkspace?.projects.find(
        (project) => pathname === project.href || pathname.startsWith(`${project.href}/`),
      ) ?? null,
    [activeWorkspace, pathname],
  );

  // One set for both levels. Workspace and project ids are cuids from the same
  // generator, so they cannot collide, and a single set means one toggle
  // function rather than two that behave identically.
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  // Auto-open the workspace and project you are inside, without collapsing
  // anything you opened by hand.
  useEffect(() => {
    const open = [activeWorkspace?.id, activeProject?.id].filter(
      (id): id is string => typeof id === 'string',
    );
    if (open.length === 0) return;
    setExpanded((current) => {
      if (open.every((id) => current.has(id))) return current;
      const next = new Set(current);
      for (const id of open) next.add(id);
      return next;
    });
  }, [activeWorkspace, activeProject]);

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
            className="flex h-8 items-center gap-2 rounded-md px-2 text-[0.8125rem] text-tertiary no-underline hover:bg-secondary hover:text-primary"
          >
            <Icon d={I_PLUS} className="size-3.5" />
            New organization
          </Link>
        ) : (
          <Dropdown.Root>
              <AriaButton
                className="flex h-8 w-full items-center gap-2 rounded-md px-1.5 text-start transition-colors hover:bg-secondary focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-focus-ring"
              >
                <span
                  aria-hidden="true"
                  className="grid size-5 shrink-0 place-items-center rounded bg-brand-solid text-[0.625rem] font-semibold text-white"
                >
                  {initials(activeOrg?.name ?? 'K')}
                </span>
                <span className="min-w-0 flex-1 truncate text-[0.8125rem] font-medium text-primary">
                  {activeOrg?.name ?? 'Flone'}
                </span>
                <Icon d={I_CARET} className="size-3 text-tertiary" />
              </AriaButton>
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
                        <span className="truncate text-xs text-tertiary">
                          {org.projectCount} {org.projectCount === 1 ? 'project' : 'projects'}
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
            </Dropdown.Root>
        )}
      </div>

      {/* Sections */}
      <nav aria-label="Navigation" className="flex flex-1 flex-col gap-4 overflow-y-auto px-2 pb-2">
        {activeOrg ? (
          <>
            {/* "Organization", not "Workspace": a Workspace is now a concrete
                thing one level down, and one word cannot mean both on one
                screen. */}
            <Section title="Organization">
              <li>
                <NavRow
                  href={activeOrg.href}
                  active={pathname === activeOrg.href}
                  onNavigate={closeDrawer}
                  icon={I_FOLDER}
                >
                  Workspaces
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

            {/* Workspaces are the grouping this whole section exists for, so
                they get the section, and the projects nest one level in. A
                workspace with no projects still renders: an empty group is the
                only affordance telling you where to put the next one. */}
            <Section
              title="Workspaces"
              action={
                <SectionAction
                  href={activeOrg.newWorkspaceHref}
                  label="New workspace"
                  onNavigate={closeDrawer}
                />
              }
            >
              {activeOrg.workspaces.length === 0 ? (
                <li className="px-2 py-1 text-[0.8125rem] text-tertiary">No workspaces yet</li>
              ) : (
                activeOrg.workspaces.map((workspace) => {
                  const wsOpen = expanded.has(workspace.id);
                  const wsActive = pathname === workspace.href;
                  return (
                    <li key={workspace.id}>
                      <div
                        className={cx(
                          'flex h-7 items-center gap-0.5 rounded-md pe-2 ps-0.5 transition-colors',
                          wsActive ? 'bg-secondary' : 'hover:bg-secondary',
                        )}
                      >
                        <button
                          type="button"
                          onClick={() => toggleProject(workspace.id)}
                          aria-expanded={wsOpen}
                          aria-label={`${wsOpen ? 'Collapse' : 'Expand'} ${workspace.name}`}
                          className="grid size-5 shrink-0 place-items-center rounded text-tertiary transition-colors hover:text-primary"
                        >
                          <Icon
                            d={I_CHEVRON}
                            className={cx('size-3 transition-transform', wsOpen && 'rotate-90')}
                          />
                        </button>
                        <Link
                          href={workspace.href}
                          onClick={closeDrawer}
                          aria-current={wsActive ? 'page' : undefined}
                          className={cx(
                            'flex min-w-0 flex-1 items-center gap-2 text-[0.8125rem] no-underline outline-none focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-focus-ring',
                            wsActive ? 'font-medium text-primary' : 'text-tertiary',
                          )}
                        >
                          <Icon d={I_FOLDER} className="size-3.5 opacity-80" />
                          <span className="truncate">{workspace.name}</span>
                        </Link>
                        <span className="shrink-0 text-[0.625rem] text-tertiary tabular-nums">
                          {workspace.projects.length}
                        </span>
                      </div>

                      {wsOpen ? (
                        <ul className="ms-3.5 flex flex-col gap-px border-s border-secondary ps-1">
                          {workspace.projects.length === 0 ? (
                            <li className="px-2 py-1 text-[0.8125rem] text-tertiary">
                              No projects
                            </li>
                          ) : null}
                          {workspace.projects.map((project) => {
                  const isOpen = expanded.has(project.id);
                  const isActive = pathname === project.href;
                  return (
                    <li key={project.id}>
                      <div
                        className={cx(
                          'flex h-7 items-center gap-0.5 rounded-md pe-2 ps-0.5 transition-colors',
                          isActive ? 'bg-secondary' : 'hover:bg-secondary',
                        )}
                      >
                        <button
                          type="button"
                          onClick={() => toggleProject(project.id)}
                          aria-expanded={isOpen}
                          aria-label={`${isOpen ? 'Collapse' : 'Expand'} ${project.name}`}
                          className="grid size-5 shrink-0 place-items-center rounded text-tertiary transition-colors hover:text-primary"
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
                            'flex min-w-0 flex-1 items-center gap-2 text-[0.8125rem] no-underline outline-none focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-focus-ring',
                            isActive ? 'font-medium text-primary' : 'text-tertiary',
                          )}
                        >
                          <Icon d={I_CUBE} className="size-3.5 opacity-80" />
                          <span className="truncate">{project.name}</span>
                        </Link>
                        <span className="shrink-0 font-mono text-[0.625rem] text-tertiary">
                          {project.key}
                        </span>
                      </div>

                      {/* The rule is the indent guide: it ties a destination
                          back to the project it hangs off, which plain padding
                          does not.

                          A fixed list, not the project's boards. Every project
                          has exactly these five places, and a board list here
                          meant a query on every render to build a tree nobody
                          navigated by -- Boards is one of the five. */}
                      {isOpen ? (
                        <ul className="ms-3.5 flex flex-col gap-px border-s border-secondary ps-1">
                          <li>
                            <NavRow
                              href={project.href}
                              active={pathname === project.href}
                              onNavigate={closeDrawer}
                              icon={I_HOME}
                              indented
                            >
                              Home
                            </NavRow>
                          </li>
                          <li>
                            <NavRow
                              href={project.issuesHref}
                              active={pathname === project.issuesHref}
                              onNavigate={closeDrawer}
                              icon={I_ISSUES}
                              indented
                            >
                              Issues
                            </NavRow>
                          </li>
                          <li>
                            <NavRow
                              href={project.cyclesHref}
                              // The cycle DETAIL pages live under this path too,
                              // so the row stays lit while you are inside one.
                              active={
                                pathname === project.cyclesHref ||
                                pathname.startsWith(`${project.cyclesHref}/`)
                              }
                              onNavigate={closeDrawer}
                              icon={I_CYCLE}
                              indented
                            >
                              Cycles
                            </NavRow>
                          </li>
                          <li>
                            <ul className="ms-4 flex flex-col gap-px">
                              <li>
                                <NavRow
                                  href={project.currentCycleHref}
                                  active={pathname === project.currentCycleHref}
                                  onNavigate={closeDrawer}
                                  indented
                                >
                                  Current
                                </NavRow>
                              </li>
                              <li>
                                <NavRow
                                  href={project.upcomingCyclesHref}
                                  active={pathname === project.upcomingCyclesHref}
                                  onNavigate={closeDrawer}
                                  indented
                                >
                                  Upcoming
                                </NavRow>
                              </li>
                            </ul>
                          </li>
                          <li>
                            <NavRow
                              href={project.boardsHref}
                              active={
                                pathname === project.boardsHref ||
                                pathname.startsWith(`${project.boardsHref}/`)
                              }
                              onNavigate={closeDrawer}
                              icon={I_BOARD}
                              indented
                            >
                              Boards
                            </NavRow>
                          </li>
                          <li>
                            <NavRow
                              href={project.viewsHref}
                              active={pathname === project.viewsHref}
                              onNavigate={closeDrawer}
                              icon={I_VIEWS}
                              indented
                            >
                              Views
                            </NavRow>
                          </li>
                        </ul>
                      ) : null}
                    </li>
                  );
                          })}
                          <li>
                            <NavRow
                              href={workspace.newProjectHref}
                              active={false}
                              onNavigate={closeDrawer}
                              icon={I_PLUS}
                              indented
                            >
                              New project
                            </NavRow>
                          </li>
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
        <Dropdown.Root>
          <AriaButton className="flex h-8 w-full items-center gap-2 rounded-md px-1.5 text-start transition-colors hover:bg-secondary focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-focus-ring">
              <span
                aria-hidden="true"
                className="grid size-5 shrink-0 place-items-center rounded-full bg-secondary text-[0.625rem] font-medium text-primary"
              >
                {initials(userName)}
              </span>
              <span className="min-w-0 flex-1 truncate text-[0.8125rem] text-tertiary">
                {userName}
              </span>
              <Icon d={I_SWITCH} className="size-3 text-tertiary" />
          </AriaButton>
          <Dropdown.Popover placement="top start" className="min-w-56">
            <Dropdown.Menu aria-label="Account">
              <Dropdown.Section>
                {/*
                 * `id` is the React Aria COLLECTION KEY, not a DOM id, and it
                 * must be unique across the whole menu. Two items sharing one
                 * key makes the collection builder render the entire menu
                 * twice -- every entry duplicated, not just the clashing pair.
                 * This one is the identity header, hence `identity`; the link
                 * to /account below is what deserves `account`.
                 */}
                <Dropdown.Item id="identity" textValue={userEmail} isDisabled>
                  <span className="flex min-w-0 flex-col">
                    <span className="truncate text-sm">{userName}</span>
                    <span className="truncate text-xs text-tertiary">{userEmail}</span>
                  </span>
                </Dropdown.Item>
              </Dropdown.Section>
              <Dropdown.Item id="account" href="/account" textValue="Account">
                Account
              </Dropdown.Item>
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
                className="text-error-primary"
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
        </Dropdown.Root>
      </div>
    </div>
  );

  return (
    <div className="flex min-h-dvh">
      <aside className="hidden w-56 shrink-0 border-e border-secondary bg-primary lg:block">
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
          <div className="absolute inset-y-0 start-0 w-64 border-e border-secondary bg-primary shadow-2xl">
            {sidebar}
          </div>
        </div>
      ) : null}

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-40 flex h-12 items-center gap-2 border-b border-secondary bg-primary/80 px-4 backdrop-blur-md sm:px-6">
          <button
            type="button"
            onClick={() => setDrawerOpen(true)}
            aria-label="Open navigation"
            className="-ms-1 grid size-8 place-items-center rounded-md text-tertiary transition-colors hover:bg-secondary hover:text-primary lg:hidden"
          >
            <Icon d={I_MENU} />
          </button>

          <nav aria-label="Breadcrumb" className="flex min-w-0 items-center gap-1.5 text-sm">
            {activeOrg ? (
              <Link
                href={activeOrg.href}
                className="truncate text-tertiary no-underline hover:text-primary"
              >
                {activeOrg.name}
              </Link>
            ) : null}
            {activeProject ? (
              <>
                <Icon d={I_CHEVRON} className="size-3 text-tertiary opacity-60" />
                <Link
                  href={activeProject.href}
                  className="truncate font-medium text-primary no-underline hover:underline"
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
