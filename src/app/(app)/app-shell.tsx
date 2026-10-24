'use client';

/**
 * The authenticated chrome, laid out the way Linear's is: the sidebar sits on
 * the window background, and every page renders into one inset, rounded panel
 * beside it. Each page draws its own 44px header (`PageBar`), so the shell owns
 * no header of its own.
 *
 * Sidebar, top to bottom: the organization menu (which also holds the account
 * and sign-out, as Linear's workspace menu does) with search and compose beside
 * it; the organization-wide destinations; then one collapsible section per
 * workspace, its projects as team-style rows whose destinations unfold beneath
 * them.
 *
 * Rows are 28px and 13px type on purpose: this density is the whole point of the
 * look. The active row is a neutral wash rather than an accent tint -- colour in
 * the sidebar competes with colour on the board.
 *
 * A client module because the drawer, the sections and the project tree hold
 * open/closed state, the active item is derived from `usePathname()`, and
 * dragging a project onto another workspace is a pointer gesture. Everything it
 * renders is data the SERVER resolved; it performs no data access, and the one
 * role check here hides an affordance rather than guarding anything --
 * `moveProjectToWorkspace` proves membership and ADMIN again on its own.
 * `@/lib/authz` is `server-only`, so hrefs arrive already built.
 */

import { useEffect, useMemo, useState, useTransition, type ReactNode } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { Button as AriaButton } from 'react-aria-components';

import { Dropdown } from '@/components/base/dropdown/dropdown';
import {
  IconBell,
  IconBoard,
  IconCaret,
  IconChevronDown,
  IconCompose,
  IconCycle,
  IconDocument,
  IconHome,
  IconIssues,
  IconPlus,
  IconRepeat,
  IconSearch,
  IconTarget,
  IconViews,
  IconWorkspaces,
} from '@/components/icons';
import { ProjectGlyph } from '@/components/page-bar';
import type { ActionResult } from '@/lib/result';
import {
  COMPOSE_HASH,
  OPEN_COMMAND_MENU_EVENT,
  OPEN_NAV_EVENT,
  requestCompose,
} from '@/lib/shell-events';
import { cx } from '@/lib/utils/cx';

import { signOut } from './actions';
import { CommandMenu } from './command-menu';
import { reorderWorkspaces } from './orgs/[orgSlug]/actions';
import { moveProjectToWorkspace } from './orgs/[orgSlug]/[workspaceSlug]/[projectKey]/actions';

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
  /** The viewer's own Daily Challenges board. Org-scoped, not per-workspace. */
  challengesHref: string;
  /** Scheduled email reminders. Org-scoped for the same reason. */
  remindersHref: string;
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

type IconComponent = (props: { className?: string }) => ReactNode;

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  const first = Array.from(parts[0])[0] ?? '';
  const last = parts.length > 1 ? (Array.from(parts[parts.length - 1])[0] ?? '') : '';
  return (first + last).toLocaleUpperCase();
}

const ROW =
  'flex h-7 items-center gap-2 rounded-md pe-2 text-sm font-medium no-underline transition-colors outline-focus-ring focus-visible:outline-2 focus-visible:-outline-offset-2';
const ROW_IDLE = 'text-tertiary hover:bg-secondary hover:text-primary';
const ROW_ACTIVE = 'bg-quaternary text-primary';

/* -------------------------------------------------------------------------- */

/**
 * A collapsible sidebar group. The heading is the toggle, so the whole label is
 * the hit target rather than a 12px caret.
 */
function SectionHeading({
  title,
  open,
  onToggle,
  action,
}: {
  title: string;
  open: boolean;
  onToggle: () => void;
  action?: ReactNode;
}) {
  return (
    <div className="group/heading flex h-7 items-center gap-0.5 pe-1">
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        className="flex min-w-0 items-center gap-0.5 rounded-md px-2 py-1 text-start text-xs font-medium text-tertiary transition-colors outline-focus-ring hover:text-primary focus-visible:outline-2"
      >
        <span className="truncate">{title}</span>
        <IconCaret className={cx('size-3.5 opacity-80 transition-transform', !open && '-rotate-90')} />
      </button>
      {action ? (
        <span className="ms-auto flex opacity-0 transition-opacity group-hover/heading:opacity-100 group-focus-within/heading:opacity-100">
          {action}
        </span>
      ) : null}
    </div>
  );
}

function NavRow({
  href,
  children,
  active,
  onNavigate,
  icon: Icon,
  depth = 0,
}: {
  href: string;
  children: ReactNode;
  active: boolean;
  onNavigate: () => void;
  icon?: IconComponent;
  /** 0: top level; 1: under a project; 2: under a project destination. */
  depth?: 0 | 1 | 2;
}) {
  return (
    <Link
      href={href}
      onClick={onNavigate}
      aria-current={active ? 'page' : undefined}
      className={cx(
        ROW,
        depth === 0 && 'ps-2',
        depth === 1 && 'ps-6',
        depth === 2 && 'ps-12',
        active ? ROW_ACTIVE : ROW_IDLE,
      )}
    >
      {Icon ? <Icon className="size-4" /> : null}
      <span className="min-w-0 truncate">{children}</span>
    </Link>
  );
}

/** The small square button that appears beside a section heading on hover. */
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
      className="grid size-6 shrink-0 place-items-center rounded-md text-tertiary transition-colors hover:bg-secondary hover:text-primary"
    >
      <IconPlus className="size-3.5" />
    </Link>
  );
}

/* -------------------------------------------------------------------------- */

export function AppShell({ orgs, userEmail, userName, isAdmin, children }: AppShellProps) {
  const pathname = usePathname();
  const [drawerOpen, setDrawerOpen] = useState(false);
  const closeDrawer = () => setDrawerOpen(false);

  useEffect(() => {
    const open = () => setDrawerOpen(true);
    window.addEventListener(OPEN_NAV_EVENT, open);
    return () => window.removeEventListener(OPEN_NAV_EVENT, open);
  }, []);

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

  // Projects start collapsed and open as you visit them; workspace sections
  // start open. Two sets, because the defaults are opposite.
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [collapsedWorkspaces, setCollapsedWorkspaces] = useState<Set<string>>(new Set());

  // Auto-open the project you are inside, and its workspace, without
  // collapsing anything you opened by hand.
  useEffect(() => {
    if (activeProject) {
      setExpanded((current) => {
        if (current.has(activeProject.id)) return current;
        const next = new Set(current);
        next.add(activeProject.id);
        return next;
      });
    }
    if (activeWorkspace) {
      setCollapsedWorkspaces((current) => {
        if (!current.has(activeWorkspace.id)) return current;
        const next = new Set(current);
        next.delete(activeWorkspace.id);
        return next;
      });
    }
  }, [activeWorkspace, activeProject]);

  function toggleIn(setter: typeof setExpanded, id: string) {
    setter((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  /*
   * Two arrangements, one gesture, and every drop lands on a workspace section:
   * a PROJECT dropped there is regrouped into that workspace, a WORKSPACE
   * dropped there takes that section's place in the order and the rest shift
   * around it.
   *
   * Native HTML5 drag rather than the board's dnd-kit setup -- these are rows
   * onto rows, and the sidebar already carries every id involved, so there is
   * nothing a sensor library would add.
   *
   * ponytail: no touch and no keyboard path -- native drag has neither. The
   * arrows on the Workspaces page remain the accessible way to order
   * workspaces; a project has no equivalent left, so give the workspace row a
   * "Move project here" menu if one is wanted.
   *
   * Gated on ADMIN so a member is not shown an affordance the action will
   * refuse. The server re-proves it; this only hides the handle.
   */
  const canArrange = activeOrg?.role === 'OWNER' || activeOrg?.role === 'ADMIN';
  const [dragging, setDragging] = useState<{ kind: 'project' | 'workspace'; id: string } | null>(
    null,
  );
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  const [moveError, setMoveError] = useState<string | null>(null);
  const [, startTransition] = useTransition();

  function dropOnWorkspace(workspace: ShellWorkspace) {
    const source = dragging;
    setDragging(null);
    setDropTarget(null);
    if (!source || !activeOrg) return;

    if (source.kind === 'project') {
      startTransition(async () => {
        // `follow` only when the page being read is the one whose URL is about
        // to change: the action answers with a redirect, and a redirect
        // resolves the call with nothing, hence the widened type.
        const result: ActionResult | undefined = await moveProjectToWorkspace({
          projectId: source.id,
          workspaceId: workspace.id,
          follow: activeProject?.id === source.id,
        });
        setMoveError(result && !result.ok ? result.error : null);
      });
      return;
    }

    // Inserted at the target's index in the CURRENT list, before the dragged
    // row is taken out of it -- that one rule reads as "lands on that row"
    // whether the drag went up or down.
    const ids = activeOrg.workspaces.map((candidate) => candidate.id);
    const at = ids.indexOf(workspace.id);
    const next = ids.filter((id) => id !== source.id);
    next.splice(at, 0, source.id);

    startTransition(async () => {
      const result = await reorderWorkspaces({ orgSlug: activeOrg.slug, workspaceIds: next });
      setMoveError(result.ok ? null : result.error);
    });
  }

  /**
   * Compose from the sidebar: a composer on the current page opens itself;
   * anywhere else, the project you are in (or the first one) opens its own.
   */
  function compose() {
    closeDrawer();
    if (requestCompose()) return;
    window.dispatchEvent(new CustomEvent(OPEN_COMMAND_MENU_EVENT, { detail: 'compose' }));
  }

  const orgMenu =
    orgs.length === 0 ? (
      <Link
        href="/orgs/new"
        onClick={closeDrawer}
        className={cx(ROW, ROW_IDLE, 'ps-2')}
      >
        <IconPlus className="size-4" />
        New organization
      </Link>
    ) : (
      <Dropdown.Root>
        <AriaButton className="flex h-7 min-w-0 items-center gap-2 rounded-md ps-1.5 pe-1.5 text-start transition-colors outline-focus-ring hover:bg-secondary focus-visible:outline-2">
          <span
            aria-hidden="true"
            className="grid size-[18px] shrink-0 place-items-center rounded-[5px] bg-brand-solid text-[0.5625rem] font-semibold text-white"
          >
            {initials(activeOrg?.name ?? 'F')}
          </span>
          <span className="min-w-0 truncate text-sm font-semibold text-primary">
            {activeOrg?.name ?? 'Flone'}
          </span>
          <IconChevronDown className="size-3 text-tertiary" />
        </AriaButton>
        <Dropdown.Popover placement="bottom start" className="w-64">
          <Dropdown.Menu aria-label="Organization">
            {activeOrg ? (
              <Dropdown.Section>
                <Dropdown.Item id="settings" href={activeOrg.settingsHref} textValue="Settings" addon="G then S">
                  Settings
                </Dropdown.Item>
                <Dropdown.Item id="workspaces" href={activeOrg.href} textValue="Workspaces">
                  Workspaces
                </Dropdown.Item>
              </Dropdown.Section>
            ) : null}
            <Dropdown.Separator />
            <Dropdown.Section>
              <Dropdown.SectionHeader className="px-3.5 pt-1.5 pb-1 text-xs font-medium text-tertiary">
                Switch organization
              </Dropdown.SectionHeader>
              {orgs.map((org) => (
                <Dropdown.Item key={org.id} id={`org-${org.id}`} href={org.href} textValue={org.name}>
                  <span className="flex min-w-0 flex-1 items-center gap-2">
                    <span
                      aria-hidden="true"
                      className="grid size-4 shrink-0 place-items-center rounded-[4px] bg-brand-solid text-[0.5rem] font-semibold text-white"
                    >
                      {initials(org.name)}
                    </span>
                    <span className="truncate">{org.name}</span>
                  </span>
                </Dropdown.Item>
              ))}
              <Dropdown.Item id="new-org" href="/orgs/new" textValue="New organization">
                New organization
              </Dropdown.Item>
            </Dropdown.Section>
            <Dropdown.Separator />
            <Dropdown.Section>
              {/*
               * `id` is the React Aria COLLECTION KEY, not a DOM id, and it
               * must be unique across the whole menu. Two items sharing one key
               * makes the collection builder render the entire menu twice.
               */}
              <Dropdown.Item id="identity" textValue={userEmail} isDisabled>
                <span className="flex min-w-0 flex-col">
                  <span className="truncate text-sm text-primary">{userName}</span>
                  <span className="truncate text-xs text-tertiary">{userEmail}</span>
                </span>
              </Dropdown.Item>
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
                textValue="Log out"
                onAction={() => {
                  // Server Actions are invoked over POST however they are
                  // called, so sign-out keeps its POST-only semantics here: the
                  // session row is deleted server-side, not merely un-cookied.
                  // The action's signature is the useActionState one, hence the
                  // empty previous-state and FormData arguments.
                  void signOut(null, new FormData());
                }}
              >
                Log out
              </Dropdown.Item>
            </Dropdown.Section>
          </Dropdown.Menu>
        </Dropdown.Popover>
      </Dropdown.Root>
    );

  const sidebar = (
    <div className="flex h-full flex-col">
      {/* Same 44px as a page header, offset by the panel's 8px inset so the
          two rows line up across the gap. */}
      <div className="flex h-11 shrink-0 items-center gap-1 px-3 lg:mt-2">
        <div className="flex min-w-0 flex-1">{orgMenu}</div>
        <button
          type="button"
          onClick={() => {
            closeDrawer();
            window.dispatchEvent(new Event(OPEN_COMMAND_MENU_EVENT));
          }}
          aria-label="Search"
          title="Search (⌘K)"
          className="grid size-7 shrink-0 place-items-center rounded-md text-tertiary transition-colors hover:bg-secondary hover:text-primary"
        >
          <IconSearch className="size-[15px]" />
        </button>
        {activeOrg && activeOrg.projectCount > 0 ? (
          <button
            type="button"
            onClick={compose}
            aria-label="New issue"
            title="New issue (C)"
            className="grid size-7 shrink-0 place-items-center rounded-full border border-secondary_alt bg-tertiary text-secondary transition-colors hover:bg-quaternary hover:text-primary"
          >
            <IconCompose className="size-[15px]" />
          </button>
        ) : null}
      </div>

      <nav aria-label="Navigation" className="flex flex-1 flex-col gap-5 overflow-y-auto px-3 pt-2 pb-3">
        {activeOrg ? (
          <>
            <ul className="flex flex-col gap-px">
              <li>
                <NavRow
                  href={activeOrg.href}
                  active={pathname === activeOrg.href}
                  onNavigate={closeDrawer}
                  icon={IconWorkspaces}
                >
                  Workspaces
                </NavRow>
              </li>
              {/* Personal, not shared: this row leads to the viewer's OWN
                  picks. It sits at organization level because a pick may name
                  an issue in any project. */}
              <li>
                <NavRow
                  href={activeOrg.challengesHref}
                  active={pathname === activeOrg.challengesHref}
                  onNavigate={closeDrawer}
                  icon={IconTarget}
                >
                  Daily Challenges
                </NavRow>
              </li>
              {/* Shared, unlike the row above: everyone in the organization
                  sees every scheduled reminder. */}
              <li>
                <NavRow
                  href={activeOrg.remindersHref}
                  active={pathname === activeOrg.remindersHref}
                  onNavigate={closeDrawer}
                  icon={IconBell}
                >
                  Reminders
                </NavRow>
              </li>
            </ul>

            {/* A refused move -- the row snaps back on its own when the layout
                revalidates, so this only has to say why. */}
            {moveError ? (
              <p role="alert" className="px-2 text-xs text-error-primary">
                {moveError}
              </p>
            ) : null}

            {/* One section per workspace, projects as team-style rows. A
                workspace with no projects still renders: an empty group is the
                only affordance telling you where to put the next one. */}
            {activeOrg.workspaces.map((workspace) => {
              const wsOpen = !collapsedWorkspaces.has(workspace.id);
              // The whole section is the target, not just its heading, so a
              // drop anywhere in an expanded workspace lands. A drop that would
              // change nothing -- a project onto the workspace it is already
              // in, a workspace onto itself -- is refused here rather than sent
              // and answered with a no-op.
              const dragged =
                dragging?.kind === 'project'
                  ? !workspace.projects.some((project) => project.id === dragging.id)
                  : dragging?.id !== workspace.id;
              const canDrop = dragging !== null && dragged;
              return (
                <section
                  key={workspace.id}
                  aria-label={workspace.name}
                  // Without preventDefault the browser refuses the drop, so
                  // this is also what makes a pointless target inert.
                  onDragOver={(event) => {
                    if (!canDrop) return;
                    event.preventDefault();
                    event.dataTransfer.dropEffect = 'move';
                    setDropTarget(workspace.id);
                  }}
                  onDragLeave={(event) => {
                    if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
                      setDropTarget((current) => (current === workspace.id ? null : current));
                    }
                  }}
                  onDrop={(event) => {
                    event.preventDefault();
                    dropOnWorkspace(workspace);
                  }}
                  className={cx(
                    'flex flex-col rounded-md',
                    dropTarget === workspace.id && 'outline-2 outline-offset-2 outline-focus-ring',
                  )}
                >
                  <div
                    draggable={canArrange}
                    onDragStart={(event) => {
                      // Firefox will not start a drag with an empty payload.
                      event.dataTransfer.setData('text/plain', workspace.name);
                      event.dataTransfer.effectAllowed = 'move';
                      setDragging({ kind: 'workspace', id: workspace.id });
                    }}
                    onDragEnd={() => {
                      setDragging(null);
                      setDropTarget(null);
                    }}
                    title={canArrange ? 'Drag onto another workspace to reorder' : undefined}
                    className={cx(
                      dragging?.kind === 'workspace' && dragging.id === workspace.id && 'opacity-50',
                    )}
                  >
                    <SectionHeading
                      title={workspace.name}
                      open={wsOpen}
                      onToggle={() => toggleIn(setCollapsedWorkspaces, workspace.id)}
                      action={
                        <SectionAction
                          href={workspace.newProjectHref}
                          label={`New project in ${workspace.name}`}
                          onNavigate={closeDrawer}
                        />
                      }
                    />
                  </div>

                  {wsOpen ? (
                    <ul className="flex flex-col gap-px">
                      {workspace.projects.length === 0 ? (
                        <li>
                          <NavRow
                            href={workspace.newProjectHref}
                            active={false}
                            onNavigate={closeDrawer}
                            icon={IconPlus}
                          >
                            New project
                          </NavRow>
                        </li>
                      ) : null}
                      {workspace.projects.map((project) => (
                        <ProjectTree
                          key={project.id}
                          project={project}
                          pathname={pathname}
                          open={expanded.has(project.id)}
                          onToggle={() => toggleIn(setExpanded, project.id)}
                          onNavigate={closeDrawer}
                          draggable={canArrange}
                          dimmed={dragging?.kind === 'project' && dragging.id === project.id}
                          onDragStart={() => setDragging({ kind: 'project', id: project.id })}
                          onDragEnd={() => {
                            setDragging(null);
                            setDropTarget(null);
                          }}
                        />
                      ))}
                    </ul>
                  ) : null}
                </section>
              );
            })}

            <ul className="flex flex-col gap-px">
              <li>
                <NavRow
                  href={activeOrg.newWorkspaceHref}
                  active={false}
                  onNavigate={closeDrawer}
                  icon={IconPlus}
                >
                  New workspace
                </NavRow>
              </li>
            </ul>
          </>
        ) : null}
      </nav>
    </div>
  );

  return (
    <div className="flex h-dvh overflow-hidden bg-app">
      <aside className="hidden w-[244px] shrink-0 lg:block">{sidebar}</aside>

      {drawerOpen ? (
        <div className="fixed inset-0 z-50 lg:hidden">
          <button
            type="button"
            aria-label="Close navigation"
            onClick={closeDrawer}
            className="absolute inset-0 size-full bg-overlay"
          />
          <div className="absolute inset-y-0 start-0 w-[280px] border-e border-secondary bg-app shadow-2xl">
            {sidebar}
          </div>
        </div>
      ) : null}

      {/* The inset panel. It is the scroll container, so each page's sticky
          `PageBar` pins to its top edge and the rounded corners clip the
          content scrolling under it. */}
      <main className="relative min-w-0 flex-1 overflow-y-auto bg-primary lg:my-2 lg:me-2 lg:rounded-lg lg:border lg:border-panel lg:shadow-xs">
        {children}
      </main>

      <CommandMenu
        orgs={orgs}
        activeOrg={activeOrg ?? null}
        activeProject={activeProject}
        isAdmin={isAdmin}
        composeHash={COMPOSE_HASH}
      />
    </div>
  );
}

/* -------------------------------------------------------------------------- */

/**
 * A project as a team row: clicking it unfolds its destinations, as a team row
 * does in Linear, rather than navigating -- Home is the first destination.
 */
function ProjectTree({
  project,
  pathname,
  open,
  onToggle,
  onNavigate,
  draggable,
  dimmed,
  onDragStart,
  onDragEnd,
}: {
  project: ShellProject;
  pathname: string;
  open: boolean;
  onToggle: () => void;
  onNavigate: () => void;
  draggable: boolean;
  dimmed: boolean;
  onDragStart: () => void;
  onDragEnd: () => void;
}) {
  const under = (href: string) => pathname === href || pathname.startsWith(`${href}/`);

  return (
    <li>
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        draggable={draggable}
        onDragStart={(event) => {
          // Firefox will not start a drag with an empty payload.
          event.dataTransfer.setData('text/plain', project.key);
          event.dataTransfer.effectAllowed = 'move';
          onDragStart();
        }}
        onDragEnd={onDragEnd}
        title={draggable ? 'Drag onto a workspace to move it' : undefined}
        className={cx(ROW, ROW_IDLE, 'w-full ps-2 text-start', dimmed && 'opacity-50')}
      >
        <span className="grid size-4 shrink-0 place-items-center">
          <ProjectGlyph projectKey={project.key} />
        </span>
        <span className="min-w-0 truncate">{project.name}</span>
        <IconCaret className={cx('size-3.5 shrink-0 opacity-80 transition-transform', !open && '-rotate-90')} />
      </button>

      {/* A fixed list, not the project's boards. Every project has exactly
          these places, and a board list here meant a query on every render to
          build a tree nobody navigated by -- Boards is one of them. The
          `recurring` and `docs` hrefs are appended here: `project.href` is
          already built and encoded by the layout and each is a fixed segment,
          so there is no slug for this module to construct. */}
      {open ? (
        <ul className="flex flex-col gap-px pt-px">
          <li>
            <NavRow href={project.href} active={pathname === project.href} onNavigate={onNavigate} icon={IconHome} depth={1}>
              Home
            </NavRow>
          </li>
          <li>
            <NavRow href={project.issuesHref} active={pathname === project.issuesHref} onNavigate={onNavigate} icon={IconIssues} depth={1}>
              Issues
            </NavRow>
          </li>
          <li>
            <NavRow
              href={project.cyclesHref}
              // The cycle DETAIL pages live under this path too, so the row
              // stays lit while you are inside one -- unless a sub-row is lit.
              active={
                pathname === project.cyclesHref ||
                (under(project.cyclesHref) &&
                  pathname !== project.currentCycleHref &&
                  pathname !== project.upcomingCyclesHref)
              }
              onNavigate={onNavigate}
              icon={IconCycle}
              depth={1}
            >
              Cycles
            </NavRow>
          </li>
          <li>
            <NavRow href={project.currentCycleHref} active={pathname === project.currentCycleHref} onNavigate={onNavigate} depth={2}>
              Current
            </NavRow>
          </li>
          <li>
            <NavRow href={project.upcomingCyclesHref} active={pathname === project.upcomingCyclesHref} onNavigate={onNavigate} depth={2}>
              Upcoming
            </NavRow>
          </li>
          <li>
            <NavRow href={project.boardsHref} active={under(project.boardsHref)} onNavigate={onNavigate} icon={IconBoard} depth={1}>
              Boards
            </NavRow>
          </li>
          <li>
            <NavRow
              href={`${project.href}/recurring`}
              active={pathname === `${project.href}/recurring`}
              onNavigate={onNavigate}
              icon={IconRepeat}
              depth={1}
            >
              Recurring
            </NavRow>
          </li>
          <li>
            <NavRow href={project.viewsHref} active={pathname === project.viewsHref} onNavigate={onNavigate} icon={IconViews} depth={1}>
              Views
            </NavRow>
          </li>
          <li>
            <NavRow href={`${project.href}/docs`} active={under(`${project.href}/docs`)} onNavigate={onNavigate} icon={IconDocument} depth={1}>
              Documents
            </NavRow>
          </li>
        </ul>
      ) : null}
    </li>
  );
}
