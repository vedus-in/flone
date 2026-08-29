import Link from 'next/link';
import { Prisma, Priority } from '@prisma/client';

import { challengesPath, loadPage, requireOrgBySlug, ticketPath, visibleProject } from '@/lib/authz';
import { columnForStateType } from '@/lib/challenges';
import { prisma } from '@/lib/db';
import { formatDay } from '@/lib/issues';
import { ISSUE_TABS, TAB_LABEL, TAB_STATE_TYPES, type IssueTab } from '@/lib/model';
import { PageHeader } from '@/components/ui';
import { PriorityIcon } from '@/components/issue-row';

import { AddChallengeButton } from './add-button';
import { ChallengePicker, type PickerFilters } from './challenge-picker';
import { ChallengeBoard, type ChallengeBoardData, type ChallengeCard } from './challenge-board';

/**
 * Daily Challenges: the signed-in user's own cherry-picked board, spanning every
 * project in this organization.
 *
 * PRIVATE by construction. Every query below is keyed on `ctx.user.id` from the
 * session, so there is no id anywhere on this page that could name another
 * person's picks -- no filter to forget and no role to check.
 *
 * The board changes real statuses; it never changes where an issue lives. An
 * issue stays in its project and on its board throughout, which is why each card
 * carries both.
 */

/** Enough to choose from, not enough to be a second issues list. */
const SUGGESTION_LIMIT = 12;

/** `VED-153`, the other way people name an issue. */
const ISSUE_KEY = /^([A-Za-z][A-Za-z0-9]{1,9})-(\d{1,9})$/;

/**
 * Most urgent first, then most recently touched.
 *
 * The `Priority` enum is declared NONE..URGENT, so `desc` really is "urgent at
 * the top" -- which is the whole point of the list you see before typing
 * anything. `position` is not usable here: it is dense per (project, state) and
 * says nothing across projects.
 */
const SUGGESTION_ORDER = [
  { priority: 'desc' as const },
  { updatedAt: 'desc' as const },
  { id: 'asc' as const },
];

/**
 * Written out rather than derived from `CHALLENGE_COLUMNS`, so that a fifth
 * column is a type error here instead of a column that renders empty forever.
 */
function emptyBoard(): ChallengeBoardData {
  return { todo: [], 'in-progress': [], done: [], completed: [] };
}

/** One URL parameter, bounded. Anything unrecognised is dropped, never rejected. */
function one(
  params: Record<string, string | string[] | undefined>,
  key: string,
): string {
  const raw = params[key];
  const value = Array.isArray(raw) ? raw[0] : raw;
  return typeof value === 'string' ? value.trim().slice(0, 100) : '';
}

export default async function ChallengesPage({
  params,
  searchParams,
}: {
  params: Promise<{ orgSlug: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { orgSlug } = await params;
  const search = await searchParams;
  const ctx = await loadPage(() => requireOrgBySlug(orgSlug));

  /**
   * A stale link naming a deleted project or a priority that no longer parses
   * should show the unfiltered list, not a 400. A filter is not a command.
   */
  const rawTab = one(search, 'tab');
  const rawPriority = one(search, 'priority');
  const filters: PickerFilters = {
    q: one(search, 'q'),
    project: one(search, 'project'),
    priority: rawPriority in Priority ? rawPriority : '',
    tab: (ISSUE_TABS as readonly string[]).includes(rawTab) ? rawTab : 'active',
    mine: one(search, 'mine') === '1',
  };

  const startOfToday = new Date();
  startOfToday.setUTCHours(0, 0, 0, 0);

  /**
   * The picks, scoped twice over: to this user, and to tickets inside this
   * organization. A pick naming an issue in another of the user's organizations
   * belongs on that organization's board, not this one.
   */
  const picks = await prisma.challengePick.findMany({
    where: {
      userId: ctx.user.id,
      // A pick survives on the board only while the project is still visible.
      // Closing a project therefore takes its cards off the daily boards of
      // everyone who is not on it, without a sweep and without a stale row.
      // The project filter scopes the BOARD too, not just the picker below:
      // one `?project=` means one thing everywhere on this page.
      ticket: {
        project: visibleProject(ctx.user.id, {
          organizationId: ctx.org.id,
          ...(filters.project ? { id: filters.project } : {}),
        }),
      },
    },
    // The arrangement first, then the default for a board nobody has dragged:
    // every `position` is 0 until the first drop, so the fallback IS the order
    // until someone expresses a preference.
    orderBy: [
      { position: 'asc' },
      { ticket: { priority: 'desc' } },
      { ticket: { updatedAt: 'desc' } },
      { id: 'asc' },
    ],
    select: {
      ticket: {
        select: {
          id: true,
          number: true,
          title: true,
          priority: true,
          dueDate: true,
          state: { select: { name: true, type: true, color: true } },
          assignee: { select: { name: true } },
          project: {
            select: { id: true, name: true, key: true, workspace: { select: { slug: true } } },
          },
        },
      },
    },
  });

  const board = emptyBoard();
  for (const { ticket } of picks) {
    const project = {
      id: ticket.project.id,
      name: ticket.project.name,
      key: ticket.project.key,
      description: null,
      workspaceSlug: ticket.project.workspace.slug,
    };
    const card: ChallengeCard = {
      id: ticket.id,
      key: `${ticket.project.key}-${ticket.number}`,
      title: ticket.title,
      href: ticketPath(ctx.org, project, ticket.number),
      projectName: ticket.project.name,
      stateName: ticket.state.name,
      stateColor: ticket.state.color,
      priority: ticket.priority,
      assigneeName: ticket.assignee?.name ?? null,
      dueDateLabel: ticket.dueDate ? formatDay(ticket.dueDate) : null,
      overdue: ticket.dueDate ? ticket.dueDate < startOfToday : false,
    };
    // The Completed column is a gesture, not a resting place: nothing is ever
    // read into it, because a pick that reaches it has already been deleted.
    board[columnForStateType(ticket.state.type)].push(card);
  }

  /**
   * The picker's list. This runs with or without a search term -- an empty box
   * shows the highest-priority work you could pick up right now, which is the
   * whole reason to open this page in the morning.
   *
   * The status filter defaults to Active, so finished and cancelled issues stay
   * out of the suggestions unless you ask for them. Without that the list fills
   * with whatever was closed most recently, which is the last thing you want to
   * start your day on.
   */
  const keyMatch = ISSUE_KEY.exec(filters.q);
  const [projects, results] = await Promise.all([
    prisma.project.findMany({
      where: visibleProject(ctx.user.id, { organizationId: ctx.org.id }),
      orderBy: [{ name: 'asc' }, { id: 'asc' }],
      select: { id: true, name: true, key: true },
    }),
    prisma.ticket.findMany({
      where: {
        project: visibleProject(ctx.user.id, {
          organizationId: ctx.org.id,
          ...(keyMatch ? { key: keyMatch[1].toUpperCase() } : {}),
          ...(filters.project ? { id: filters.project } : {}),
        }),
        // Never offer something already on the board -- the row would be a no-op.
        challengePicks: { none: { userId: ctx.user.id } },
        state: { type: { in: [...TAB_STATE_TYPES[filters.tab as IssueTab]] } },
        ...(filters.mine ? { assigneeId: ctx.user.id } : {}),
        ...(filters.priority ? { priority: filters.priority as Priority } : {}),
        ...(keyMatch
          ? { number: Number(keyMatch[2]) }
          : filters.q
            ? // A filter box, not full-text search -- the same call the issues
              // list makes, and a trigram index is not worth carrying for it.
              { title: { contains: filters.q, mode: Prisma.QueryMode.insensitive } }
            : {}),
      },
      orderBy: SUGGESTION_ORDER,
      take: SUGGESTION_LIMIT,
      select: {
        id: true,
        number: true,
        title: true,
        priority: true,
        state: { select: { name: true } },
        assignee: { select: { name: true } },
        project: {
          select: { id: true, name: true, key: true, workspace: { select: { slug: true } } },
        },
      },
    }),
  ]);

  const searching = filters.q.length > 0;

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Daily Challenges"
        description="Issues you have picked to work on today, from any project in this organization. Moving a card changes the issue's real status everywhere; the Completed column only clears it from here."
      />

      {filters.project ? (
        <p className="-mt-2 text-sm text-tertiary">
          Showing only{' '}
          <span className="font-medium text-primary">
            {projects.find((p) => p.id === filters.project)?.name ?? 'a project you can no longer see'}
          </span>
          {' '}&mdash; the project filter below scopes the whole page.
        </p>
      ) : null}

      <ChallengeBoard data={board} />

      <section aria-labelledby="add-challenge-heading" className="flex flex-col gap-3">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 id="add-challenge-heading" className="text-sm font-medium text-primary">
            {searching ? 'Matching issues' : 'Pick something up'}
          </h2>
          {searching ? null : (
            <p className="text-xs text-tertiary">Highest priority first</p>
          )}
        </div>

        <ChallengePicker
          basePath={challengesPath(ctx.org)}
          value={filters}
          projects={projects}
          tabs={ISSUE_TABS.map((tab) => ({ id: tab, label: TAB_LABEL[tab] }))}
        />

        {/* The status filter defaults to Active, so an empty result is far more
            often "it is filtered out" than "it does not exist". Saying "nothing
            matched" there sends people looking for a typo that isn't. */}
        {results.length === 0 ? (
          <p className="text-sm text-tertiary">
            {filters.tab === 'all'
              ? searching
                ? 'Nothing matched, or everything that did is already on your board.'
                : 'Nothing left to pick up under these filters.'
              : `No ${TAB_LABEL[filters.tab as IssueTab].toLowerCase()} issues${searching ? ' matched' : ' left to pick up'}. Set the status filter to All issues to look wider.`}
          </p>
        ) : (
          <ul className="flex flex-col">
            {results.map((ticket) => {
              const project = {
                id: ticket.project.id,
                name: ticket.project.name,
                key: ticket.project.key,
                description: null,
                workspaceSlug: ticket.project.workspace.slug,
              };
              const label = `${ticket.project.key}-${ticket.number}`;
              return (
                <li
                  key={ticket.id}
                  className="flex items-center gap-3 border-b border-secondary/60 py-2.5 text-sm"
                >
                  {/* The list is sorted by priority, so it has to be visible --
                      otherwise the order looks arbitrary. */}
                  <PriorityIcon priority={ticket.priority} className="size-3.5 shrink-0" />
                  <span className="min-w-0 flex-1">
                    <Link
                      href={ticketPath(ctx.org, project, ticket.number)}
                      className="truncate font-medium text-primary no-underline hover:underline"
                    >
                      {ticket.title}
                    </Link>
                    <span className="block truncate text-xs text-tertiary">
                      <span className="font-mono">{label}</span> &middot; {ticket.project.name}{' '}
                      &middot; {ticket.state.name}
                      {ticket.assignee ? <> &middot; {ticket.assignee.name}</> : null}
                    </span>
                  </span>
                  <AddChallengeButton ticketId={ticket.id} label={label} />
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </div>
  );
}
