'use client';

/**
 * The command menu (⌘K / Ctrl+K, or `/`) and the app-wide keyboard shortcuts.
 *
 * One component owns both because they draw on the same table: every command
 * in the menu is something a shortcut can also run, and the shortcut column in
 * the menu is how people learn the keys. The table is built from the navigation
 * tree the shell already holds, so it performs no data access -- "search
 * issues" hands the query to the issues page, which runs the real, membership-
 * scoped search on the server.
 *
 * Shortcuts never fire while focus is in a text field, a select or anything
 * editable, and never while another dialog is open: a letter typed into a
 * comment must stay a letter.
 */

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useRouter } from 'next/navigation';
import { Dialog, Modal, ModalOverlay } from 'react-aria-components';

import {
  IconBell,
  IconBoard,
  IconCompose,
  IconCycle,
  IconDocument,
  IconHome,
  IconIssues,
  IconKey,
  IconKeyboard,
  IconMonitor,
  IconMoon,
  IconRepeat,
  IconSearch,
  IconSettings,
  IconShield,
  IconSignOut,
  IconSun,
  IconTarget,
  IconUser,
  IconViews,
  IconWorkspaces,
} from '@/components/icons';
import { ProjectGlyph } from '@/components/page-bar';
import { isTypingTarget, overlayHasFocus } from '@/lib/hotkey';
import { setThemePreference } from '@/lib/theme';
import { OPEN_COMMAND_MENU_EVENT, requestCompose } from '@/lib/shell-events';
import { cx } from '@/lib/utils/cx';

import { signOut } from './actions';
import type { ShellOrg, ShellProject } from './app-shell';

type Command = {
  id: string;
  group: string;
  label: string;
  /** Extra words the filter matches on. */
  keywords?: string;
  icon: ReactNode;
  /** Displayed, and -- for the `g` sequences -- also bound. */
  shortcut?: string[];
  run: () => void;
};

type CommandMenuProps = {
  orgs: ShellOrg[];
  activeOrg: ShellOrg | null;
  activeProject: ShellProject | null;
  isAdmin: boolean;
  /** Appended to a project URL to open its composer on arrival. */
  composeHash: string;
};

function matches(command: Command, query: string): boolean {
  if (!query) return true;
  const haystack = `${command.label} ${command.keywords ?? ''} ${command.group}`.toLowerCase();
  return query
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .every((word) => haystack.includes(word));
}

export function CommandMenu({ orgs, activeOrg, activeProject, isAdmin, composeHash }: CommandMenuProps) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [composeOnly, setComposeOnly] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [activeIndex, setActiveIndex] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);

  const projects = useMemo(
    () => (activeOrg ? activeOrg.workspaces.flatMap((workspace) => workspace.projects) : []),
    [activeOrg],
  );

  const go = useCallback((href: string) => router.push(href), [router]);

  const openMenu = useCallback((mode?: 'compose') => {
    setQuery('');
    setComposeOnly(mode === 'compose');
    setOpen(true);
  }, []);

  /**
   * Start an issue. The composer already on the page takes it when it belongs
   * to the right project -- a hash-only navigation to the page you are on would
   * not remount it, so it would never see `#new-issue`. Otherwise go to the
   * project's issues page and let its composer open on arrival; with no project
   * in hand and several to choose from, ask which.
   */
  const compose = useCallback(
    (project: ShellProject | null) => {
      const onPage = !project || project.id === activeProject?.id;
      if (onPage && requestCompose()) return;
      const target = project ?? activeProject ?? (projects.length === 1 ? projects[0] : null);
      if (target) go(`${target.issuesHref}${composeHash}`);
      else if (projects.length > 1) openMenu('compose');
    },
    [activeProject, composeHash, go, openMenu, projects],
  );

  const commands = useMemo<Command[]>(() => {
    const list: Command[] = [];

    if (projects.length > 0) {
      list.push({
        id: 'compose',
        group: 'Issues',
        label: activeProject ? `Create new issue in ${activeProject.name}` : 'Create new issue',
        keywords: 'new add ticket',
        icon: <IconCompose />,
        shortcut: ['C'],
        run: () => compose(null),
      });
    }

    if (activeProject) {
      const p = activeProject;
      list.push(
        { id: 'go-home', group: 'Navigation', label: 'Go to project home', keywords: p.name, icon: <IconHome />, shortcut: ['G', 'H'], run: () => go(p.href) },
        { id: 'go-active', group: 'Navigation', label: 'Go to active issues', keywords: 'issues list', icon: <IconIssues />, shortcut: ['G', 'A'], run: () => go(`${p.issuesHref}?tab=active`) },
        { id: 'go-backlog', group: 'Navigation', label: 'Go to backlog', keywords: 'issues list', icon: <IconIssues />, shortcut: ['G', 'B'], run: () => go(`${p.issuesHref}?tab=backlog`) },
        { id: 'go-all', group: 'Navigation', label: 'Go to all issues', keywords: 'issues list everything', icon: <IconIssues />, shortcut: ['G', 'E'], run: () => go(`${p.issuesHref}?tab=all`) },
        { id: 'go-current', group: 'Navigation', label: 'Go to current cycle', keywords: 'sprint', icon: <IconCycle />, shortcut: ['G', 'V'], run: () => go(p.currentCycleHref) },
        { id: 'go-cycles', group: 'Navigation', label: 'Go to cycles', keywords: 'sprints', icon: <IconCycle />, shortcut: ['G', 'C'], run: () => go(p.cyclesHref) },
        { id: 'go-boards', group: 'Navigation', label: 'Go to boards', keywords: 'kanban', icon: <IconBoard />, shortcut: ['G', 'K'], run: () => go(p.boardsHref) },
        { id: 'go-views', group: 'Navigation', label: 'Go to views', keywords: 'saved filters', icon: <IconViews />, run: () => go(p.viewsHref) },
        { id: 'go-docs', group: 'Navigation', label: 'Go to documents', keywords: 'docs pages', icon: <IconDocument />, shortcut: ['G', 'D'], run: () => go(`${p.href}/docs`) },
        { id: 'go-recurring', group: 'Navigation', label: 'Go to recurring issues', keywords: 'templates repeat', icon: <IconRepeat />, run: () => go(`${p.href}/recurring`) },
      );
    }

    if (activeOrg) {
      const o = activeOrg;
      list.push(
        { id: 'go-workspaces', group: 'Navigation', label: 'Go to workspaces', keywords: o.name, icon: <IconWorkspaces />, shortcut: ['G', 'W'], run: () => go(o.href) },
        { id: 'go-challenges', group: 'Navigation', label: 'Go to daily challenges', keywords: 'today picks', icon: <IconTarget />, shortcut: ['G', 'T'], run: () => go(o.challengesHref) },
        { id: 'go-reminders', group: 'Navigation', label: 'Go to reminders', keywords: 'schedule email', icon: <IconBell />, shortcut: ['G', 'R'], run: () => go(o.remindersHref) },
        { id: 'go-settings', group: 'Navigation', label: 'Go to settings', keywords: 'members organization', icon: <IconSettings />, shortcut: ['G', 'S'], run: () => go(o.settingsHref) },
      );
    }

    for (const project of projects) {
      list.push({
        id: `project-${project.id}`,
        group: 'Projects',
        label: project.name,
        keywords: `${project.key} project open`,
        icon: <ProjectGlyph projectKey={project.key} />,
        run: () => go(project.issuesHref),
      });
      if (projects.length > 1) {
        list.push({
          id: `compose-${project.id}`,
          group: 'Issues',
          label: `Create new issue in ${project.name}`,
          keywords: `${project.key} new add ticket`,
          icon: <IconCompose />,
          run: () => compose(project),
        });
      }
    }

    for (const org of orgs) {
      if (org.id === activeOrg?.id) continue;
      list.push({
        id: `org-${org.id}`,
        group: 'Organizations',
        label: `Switch to ${org.name}`,
        keywords: 'organization workspace',
        icon: <IconWorkspaces />,
        run: () => go(org.href),
      });
    }

    list.push(
      { id: 'theme-dark', group: 'Preferences', label: 'Switch to dark theme', keywords: 'appearance mode', icon: <IconMoon />, run: () => setThemePreference('dark') },
      { id: 'theme-light', group: 'Preferences', label: 'Switch to light theme', keywords: 'appearance mode', icon: <IconSun />, run: () => setThemePreference('light') },
      { id: 'theme-system', group: 'Preferences', label: 'Use system theme', keywords: 'appearance mode auto', icon: <IconMonitor />, run: () => setThemePreference('system') },
      { id: 'shortcuts', group: 'Preferences', label: 'Keyboard shortcuts', keywords: 'help keys hotkeys', icon: <IconKeyboard />, shortcut: ['?'], run: () => setHelpOpen(true) },
      { id: 'account', group: 'Account', label: 'Account settings', keywords: 'notifications email', icon: <IconUser />, run: () => go('/account') },
      { id: 'tokens', group: 'Account', label: 'MCP access tokens', keywords: 'api ai assistant', icon: <IconKey />, run: () => go('/tokens') },
    );
    if (isAdmin) {
      list.push({ id: 'admin', group: 'Account', label: 'Site administration', keywords: 'admin users', icon: <IconShield />, run: () => go('/admin') });
    }
    list.push({
      id: 'sign-out',
      group: 'Account',
      label: 'Log out',
      keywords: 'sign out',
      icon: <IconSignOut />,
      run: () => void signOut(null, new FormData()),
    });

    return list;
  }, [activeOrg, activeProject, compose, go, isAdmin, orgs, projects]);

  const visible = useMemo(() => {
    const pool = composeOnly ? commands.filter((command) => command.id.startsWith('compose')) : commands;
    const filtered = pool.filter((command) => matches(command, query.trim()));
    // A free-text search of the issues, offered whenever there is text -- after
    // the commands that match, so Enter still runs the command being typed.
    if (query.trim() && activeProject) {
      const q = query.trim();
      const target = activeProject;
      filtered.push({
        id: 'search-issues',
        group: 'Search',
        label: `Search issues for “${q}”`,
        icon: <IconSearch />,
        run: () => go(`${target.issuesHref}?tab=all&q=${encodeURIComponent(q)}`),
      });
    }
    return filtered;
  }, [activeProject, commands, composeOnly, go, query]);

  useEffect(() => setActiveIndex(0), [query, composeOnly, open]);

  function runCommand(command: Command) {
    setOpen(false);
    command.run();
  }

  /* ------------------------------------------------------------------------ */
  /* Global keys                                                               */
  /* ------------------------------------------------------------------------ */

  const shortcutTable = useMemo(() => {
    const table = new Map<string, Command>();
    for (const command of commands) {
      if (command.shortcut?.length === 2 && command.shortcut[0] === 'G') {
        table.set(command.shortcut[1].toLowerCase(), command);
      }
    }
    return table;
  }, [commands]);

  useEffect(() => {
    const onOpen = (event: Event) => {
      const detail = (event as CustomEvent<unknown>).detail;
      openMenu(detail === 'compose' ? 'compose' : undefined);
    };
    window.addEventListener(OPEN_COMMAND_MENU_EVENT, onOpen);
    return () => window.removeEventListener(OPEN_COMMAND_MENU_EVENT, onOpen);
  }, [openMenu]);

  useEffect(() => {
    let pendingG: number | null = null;

    function onKeyDown(event: KeyboardEvent) {
      // ⌘K / Ctrl+K works from anywhere, including inside a text field.
      if ((event.metaKey || event.ctrlKey) && !event.altKey && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        if (open) setOpen(false);
        else if (!overlayHasFocus()) openMenu();
        return;
      }

      if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey) return;
      if (open || helpOpen || isTypingTarget(event.target) || overlayHasFocus()) return;

      const key = event.key.toLowerCase();

      // A bare modifier keydown (reaching for Shift) neither ends a pending
      // `G` sequence nor is anything on its own.
      if (event.key === 'Shift' || event.key === 'Control' || event.key === 'Alt' || event.key === 'Meta') return;

      if (pendingG !== null) {
        window.clearTimeout(pendingG);
        pendingG = null;
        // Whatever follows a `G` belongs to the sequence, matched or not.
        event.preventDefault();
        shortcutTable.get(key)?.run();
        return;
      }

      if (key === 'g') {
        pendingG = window.setTimeout(() => {
          pendingG = null;
        }, 1200);
        return;
      }
      if (key === '/') {
        event.preventDefault();
        openMenu();
        return;
      }
      if (event.key === '?') {
        event.preventDefault();
        setHelpOpen(true);
        return;
      }
      if (key === 'c' && !event.shiftKey && projects.length > 0) {
        event.preventDefault();
        compose(null);
      }
    }

    // Capture phase, so a `G then K` reaches this before a list's own `K`
    // handler does, and the `preventDefault` below tells that handler to skip.
    window.addEventListener('keydown', onKeyDown, true);
    return () => {
      window.removeEventListener('keydown', onKeyDown, true);
      if (pendingG !== null) window.clearTimeout(pendingG);
    };
  }, [compose, helpOpen, open, openMenu, projects.length, shortcutTable]);

  // Keep the highlighted row in view while arrowing through a long list.
  useEffect(() => {
    const row = listRef.current?.querySelector<HTMLElement>(`[data-index="${activeIndex}"]`);
    row?.scrollIntoView({ block: 'nearest' });
  }, [activeIndex]);

  /* ------------------------------------------------------------------------ */

  let lastGroup = '';

  return (
    <>
      <ModalOverlay
        isOpen={open}
        onOpenChange={setOpen}
        isDismissable
        className={({ isEntering, isExiting }) =>
          cx(
            'fixed inset-0 z-50 flex justify-center bg-overlay px-4 pt-[12vh]',
            isEntering && 'duration-150 ease-out animate-in fade-in',
            isExiting && 'duration-100 ease-in animate-out fade-out',
          )
        }
      >
        <Modal
          className={({ isEntering, isExiting }) =>
            cx(
              'h-fit w-full max-w-[640px] overflow-hidden rounded-xl border border-secondary_alt bg-elevated shadow-2xl outline-hidden',
              isEntering && 'duration-150 ease-out animate-in zoom-in-[0.98] fade-in',
              isExiting && 'duration-100 ease-in animate-out zoom-out-[0.98] fade-out',
            )
          }
        >
          <Dialog aria-label="Command menu" className="outline-hidden">
            {activeProject || composeOnly ? (
              <div className="flex items-center gap-1.5 px-4 pt-3">
                <span className="flex h-6 items-center gap-1.5 rounded-md bg-tertiary px-2 text-xs font-medium text-secondary">
                  {composeOnly ? (
                    'New issue'
                  ) : activeProject ? (
                    <>
                      <ProjectGlyph projectKey={activeProject.key} className="size-3" />
                      {activeProject.name}
                    </>
                  ) : null}
                </span>
              </div>
            ) : null}
            <input
              autoFocus
              role="combobox"
              aria-expanded="true"
              aria-controls="command-menu-list"
              aria-activedescendant={visible[activeIndex] ? `command-${visible[activeIndex].id}` : undefined}
              aria-label="Type a command or search"
              placeholder={composeOnly ? 'Create a new issue in…' : 'Type a command or search…'}
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'ArrowDown') {
                  event.preventDefault();
                  setActiveIndex((index) => Math.min(index + 1, visible.length - 1));
                } else if (event.key === 'ArrowUp') {
                  event.preventDefault();
                  setActiveIndex((index) => Math.max(index - 1, 0));
                } else if (event.key === 'Enter') {
                  event.preventDefault();
                  const command = visible[activeIndex];
                  if (command) runCommand(command);
                }
              }}
              className="h-14 w-full border-b border-secondary bg-transparent px-5 text-md text-primary placeholder:text-quaternary focus:outline-none"
            />
            <div
              ref={listRef}
              id="command-menu-list"
              role="listbox"
              aria-label="Commands"
              className="max-h-[min(420px,60vh)] overflow-y-auto p-2"
            >
              {visible.length === 0 ? (
                <p className="px-3 py-6 text-center text-sm text-tertiary">No results</p>
              ) : (
                visible.map((command, index) => {
                  const heading = command.group !== lastGroup ? command.group : null;
                  lastGroup = command.group;
                  const active = index === activeIndex;
                  return (
                    <div key={command.id}>
                      {heading ? (
                        <div className="px-3 pt-2 pb-1 text-xs font-medium text-tertiary first:pt-1">
                          {heading}
                        </div>
                      ) : null}
                      <div
                        id={`command-${command.id}`}
                        role="option"
                        aria-selected={active}
                        data-index={index}
                        onMouseMove={() => setActiveIndex(index)}
                        onClick={() => runCommand(command)}
                        className={cx(
                          'flex h-10 cursor-pointer items-center gap-3 rounded-md px-3 text-sm',
                          active ? 'bg-elevated_hover text-primary' : 'text-secondary',
                        )}
                      >
                        <span className={cx('flex', active ? 'text-primary' : 'text-tertiary')}>
                          {command.icon}
                        </span>
                        <span className="min-w-0 flex-1 truncate">{command.label}</span>
                        {command.shortcut ? <Keys keys={command.shortcut} /> : null}
                      </div>
                    </div>
                  );
                })
              )}
            </div>
          </Dialog>
        </Modal>
      </ModalOverlay>

      <ShortcutsDialog open={helpOpen} onOpenChange={setHelpOpen} />
    </>
  );
}

/* -------------------------------------------------------------------------- */

export function Keys({ keys, className }: { keys: string[]; className?: string }) {
  return (
    <span className={cx('flex shrink-0 items-center gap-1', className)}>
      {keys.map((key, index) => (
        <span key={index} className="flex items-center gap-1">
          {index > 0 && keys.length === 2 && keys[0] === 'G' ? (
            <span className="text-[0.6875rem] text-quaternary">then</span>
          ) : null}
          <kbd className="grid h-5 min-w-5 place-items-center rounded border border-secondary_alt bg-tertiary px-1 font-body text-[0.6875rem] font-medium text-tertiary">
            {key}
          </kbd>
        </span>
      ))}
    </span>
  );
}

const SHORTCUT_GROUPS: Array<{ title: string; items: Array<{ label: string; keys: string[] }> }> = [
  {
    title: 'General',
    items: [
      { label: 'Open command menu', keys: ['⌘', 'K'] },
      { label: 'Search', keys: ['/'] },
      { label: 'Create new issue', keys: ['C'] },
      { label: 'Keyboard shortcuts', keys: ['?'] },
    ],
  },
  {
    title: 'Navigation',
    items: [
      { label: 'Go to active issues', keys: ['G', 'A'] },
      { label: 'Go to backlog', keys: ['G', 'B'] },
      { label: 'Go to all issues', keys: ['G', 'E'] },
      { label: 'Go to current cycle', keys: ['G', 'V'] },
      { label: 'Go to cycles', keys: ['G', 'C'] },
      { label: 'Go to boards', keys: ['G', 'K'] },
      { label: 'Go to documents', keys: ['G', 'D'] },
      { label: 'Go to project home', keys: ['G', 'H'] },
      { label: 'Go to workspaces', keys: ['G', 'W'] },
      { label: 'Go to daily challenges', keys: ['G', 'T'] },
      { label: 'Go to reminders', keys: ['G', 'R'] },
      { label: 'Go to settings', keys: ['G', 'S'] },
    ],
  },
  {
    title: 'Issue lists',
    items: [
      { label: 'Move down / up', keys: ['J', 'K'] },
      { label: 'Open focused issue', keys: ['Enter'] },
    ],
  },
  {
    title: 'Issue',
    items: [
      { label: 'Change status', keys: ['S'] },
      { label: 'Change priority', keys: ['P'] },
      { label: 'Assign', keys: ['A'] },
      { label: 'Add labels', keys: ['L'] },
    ],
  },
];

function ShortcutsDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  return (
    <ModalOverlay
      isOpen={open}
      onOpenChange={onOpenChange}
      isDismissable
      className="fixed inset-0 z-50 flex justify-end bg-transparent"
    >
      <Modal className="m-2 h-[calc(100dvh-16px)] w-full max-w-[360px] overflow-hidden rounded-lg border border-secondary_alt bg-elevated shadow-2xl outline-hidden duration-150 ease-out animate-in slide-in-from-right-4 fade-in">
        <Dialog aria-label="Keyboard shortcuts" className="flex h-full flex-col outline-hidden">
          <div className="flex h-11 shrink-0 items-center justify-between border-b border-secondary px-4">
            <h2 className="text-sm font-medium text-primary">Keyboard shortcuts</h2>
            <button
              type="button"
              onClick={() => onOpenChange(false)}
              className="rounded-md px-1.5 py-0.5 text-xs text-tertiary hover:bg-secondary hover:text-primary"
            >
              Esc
            </button>
          </div>
          <div className="flex-1 overflow-y-auto px-4 py-3">
            {SHORTCUT_GROUPS.map((group) => (
              <section key={group.title} className="mb-5">
                <h3 className="mb-2 text-xs font-medium text-tertiary">{group.title}</h3>
                <ul className="flex flex-col">
                  {group.items.map((item) => (
                    <li key={item.label} className="flex h-8 items-center justify-between gap-3 text-sm text-secondary">
                      <span className="truncate">{item.label}</span>
                      <Keys keys={item.keys} />
                    </li>
                  ))}
                </ul>
              </section>
            ))}
          </div>
        </Dialog>
      </Modal>
    </ModalOverlay>
  );
}
