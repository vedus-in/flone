import Link from 'next/link';
import { Prisma } from '@prisma/client';

import { loadPage, requireOrgBySlug, ticketPath } from '@/lib/authz';
import { columnForStateType } from '@/lib/challenges';
import { prisma } from '@/lib/db';
import { formatDay } from '@/lib/issues';
import { PageHeader } from '@/components/ui';

import { AddChallengeButton } from './add-button';
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

/** Enough to name an issue, not enough to be a second issues list. */
const SEARCH_LIMIT = 10;

/** `VED-153`, the other way people name an issue. */
const ISSUE_KEY = /^([A-Za-z][A-Za-z0-9]{1,9})-(\d{1,9})$/;

/**
 * Written out rather than derived from `CHALLENGE_COLUMNS`, so that a fifth
 * column is a type error here instead of a column that renders empty forever.
 */
function emptyBoard(): ChallengeBoardData {
  return { todo: [], 'in-progress': [], done: [], completed: [] };
}

export default async function ChallengesPage({
  params,
  searchParams,
}: {
  params: Promise<{ orgSlug: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { orgSlug } = await params;
  const rawQuery = (await searchParams).q;
  const ctx = await loadPage(() => requireOrgBySlug(orgSlug));

  const query = (typeof rawQuery === 'string' ? rawQuery : '').trim().slice(0, 100);

  const startOfToday = new Date();
  startOfToday.setUTCHours(0, 0, 0, 0);

  /**
   * The picks, scoped twice over: to this user, and to tickets inside this
   * organization. A pick naming an issue in another of the user's organizations
   * belongs on that organization's board, not this one.
   *
   * Ordered by priority (the enum is declared NONE..URGENT, so `desc` is most
   * urgent first) and then by recency, because position is per (project, state)
   * and means nothing across projects.
   */
  const picks = await prisma.challengePick.findMany({
    where: {
      userId: ctx.user.id,
      ticket: {
        project: {
          organizationId: ctx.org.id,
          organization: { memberships: { some: { userId: ctx.user.id } } },
        },
      },
    },
    orderBy: [{ ticket: { priority: 'desc' } }, { ticket: { updatedAt: 'desc' } }, { id: 'asc' }],
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
   * The picker. Matches an exact `KEY-123` if the query looks like one, and
   * otherwise does a case-insensitive title contains -- the same choice the
   * issues list makes, and for the same reason: this is a filter box, not
   * full-text search.
   *
   * `challengePicks: { none: ... }` hides anything already on the board, so the
   * list never offers a no-op.
   */
  const keyMatch = ISSUE_KEY.exec(query);
  const results =
    query.length === 0
      ? []
      : await prisma.ticket.findMany({
          where: {
            project: {
              organizationId: ctx.org.id,
              organization: { memberships: { some: { userId: ctx.user.id } } },
              ...(keyMatch ? { key: keyMatch[1].toUpperCase() } : {}),
            },
            challengePicks: { none: { userId: ctx.user.id } },
            ...(keyMatch
              ? { number: Number(keyMatch[2]) }
              : { title: { contains: query, mode: Prisma.QueryMode.insensitive } }),
          },
          orderBy: [{ updatedAt: 'desc' }, { id: 'asc' }],
          take: SEARCH_LIMIT,
          select: {
            id: true,
            number: true,
            title: true,
            state: { select: { name: true } },
            project: {
              select: { id: true, name: true, key: true, workspace: { select: { slug: true } } },
            },
          },
        });

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Daily Challenges"
        description="Issues you have picked to work on today, from any project in this organization. Moving a card changes the issue's real status everywhere; the Completed column only clears it from here."
      />

      <ChallengeBoard data={board} />

      <section aria-labelledby="add-challenge-heading" className="flex flex-col gap-3">
        <h2 id="add-challenge-heading" className="text-sm font-medium text-primary">
          Add an issue
        </h2>

        {/* A plain GET form. No client state, shareable, and correct under
            back/forward -- the same reasoning as every other filter here. */}
        <form method="get" className="flex flex-wrap items-center gap-2">
          <input
            type="search"
            name="q"
            defaultValue={query}
            maxLength={100}
            autoComplete="off"
            placeholder="Search by title, or paste an issue ID like VED-153"
            aria-label="Search issues to add"
            className="h-9 min-w-0 flex-1 rounded-lg border border-secondary bg-primary px-3 text-sm text-primary placeholder:text-tertiary focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-focus-ring"
          />
          <button
            type="submit"
            className="h-9 rounded-lg border border-secondary px-3 text-sm font-medium text-primary transition-colors hover:bg-secondary focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring"
          >
            Search
          </button>
        </form>

        {query.length > 0 ? (
          results.length === 0 ? (
            <p className="text-sm text-tertiary">
              Nothing matched, or everything that did is already on your board.
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
                      </span>
                    </span>
                    <AddChallengeButton ticketId={ticket.id} label={label} />
                  </li>
                );
              })}
            </ul>
          )
        ) : null}
      </section>
    </div>
  );
}
