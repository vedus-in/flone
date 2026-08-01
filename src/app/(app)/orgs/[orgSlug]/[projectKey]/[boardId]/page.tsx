import type { ReactNode } from 'react';
import Link from 'next/link';
import { notFound } from 'next/navigation';

import { Badge, PageHeader } from '@/components/ui';
import { boardPath, loadPage, orgPath, projectPath, requireBoardInPath } from '@/lib/authz';
import { prisma } from '@/lib/db';
import { COLUMN_ORDER, TICKET_ORDER } from '@/lib/validation';
import { BoardView, type BoardColumnData } from './board-view';

/**
 * THE BOARD (SPEC 5).
 *
 * Authorization: `requireBoardInPath` puts EVERY ancestor segment of the URL
 * into the same `where` clause, so a mismatched org slug or project key yields
 * `null` -- indistinguishable from "does not exist". `loadPage` turns that into
 * `notFound()`; there is no separate 403 to leak from.
 *
 * The column/ticket read below is rooted at `ctx.board.id`, an id that only
 * exists because the membership predicate above already matched. It is never
 * built from a client-supplied board id.
 *
 * This stays a Server Component: every HeroUI module carries its own
 * `'use client'`, so the only client code shipped from this route is
 * `board-view.tsx`, which genuinely needs hooks.
 */

type BoardParams = {
  orgSlug: string;
  projectKey: string;
  boardId: string;
};

/**
 * Breadcrumb trail. Plain `next/link` anchors rather than a widget: these are
 * navigation, they must keep client-side routing, and the separator is inert
 * decoration.
 */
function CrumbSeparator() {
  return (
    <svg viewBox="0 0 16 16" fill="none" aria-hidden="true" className="size-3 shrink-0 opacity-50">
      <path
        d="M6 3.5 10.5 8 6 12.5"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function Crumb({ href, children }: { href: string; children: ReactNode }) {
  return (
    <Link
      href={href}
      className="rounded-sm px-0.5 font-medium no-underline hover:text-foreground hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
    >
      {children}
    </Link>
  );
}

export default async function BoardPage({ params }: { params: Promise<BoardParams> }) {
  // Next 15: params is a Promise. A query must never be built from an undefined
  // segment -- that would turn the membership predicate into match-anything.
  const { orgSlug, projectKey, boardId } = await params;
  if (!orgSlug || !projectKey || !boardId) notFound();

  const ctx = await loadPage(() => requireBoardInPath(orgSlug, projectKey.toUpperCase(), boardId));

  const columnRows = await prisma.boardColumn.findMany({
    where: { boardId: ctx.board.id },
    orderBy: COLUMN_ORDER,
    select: {
      id: true,
      name: true,
      tickets: {
        // Belt and braces against a divergent `boardId`/`columnId` pair
        // (SPEC 8.7): a ticket only renders here if it belongs to this board.
        where: { boardId: ctx.board.id },
        orderBy: TICKET_ORDER,
        select: {
          id: true,
          number: true,
          title: true,
          priority: true,
          dueDate: true,
          updatedAt: true,
          assignee: { select: { id: true, name: true } },
          _count: { select: { comments: true } },
        },
      },
    },
  });

  /**
   * Assignee candidates for the card context menu.
   *
   * Rooted at `ctx.org.id`, which came from the upward walk -- so this only ever
   * lists people who are members of THIS organization. `assignTicket` re-checks
   * membership server-side regardless; this just avoids offering a name the
   * action would then reject.
   */
  const memberRows = await prisma.membership.findMany({
    where: { organizationId: ctx.org.id },
    orderBy: [{ user: { name: 'asc' } }, { userId: 'asc' }],
    select: { user: { select: { id: true, name: true } } },
  });
  const members = memberRows.map((row) => ({ id: row.user.id, name: row.user.name }));

  /**
   * Dates are formatted HERE, with a fixed locale and UTC, so the server-rendered
   * markup and the client's first render agree. Deriving them in the browser
   * would produce a hydration mismatch on any machine not on this locale.
   */
  const dayFormat = new Intl.DateTimeFormat('en-GB', {
    day: 'numeric',
    month: 'short',
    timeZone: 'UTC',
  });
  const stampFormat = new Intl.DateTimeFormat('en-GB', {
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
    timeZone: 'UTC',
  });
  const startOfToday = new Date();
  startOfToday.setUTCHours(0, 0, 0, 0);

  const columns: BoardColumnData[] = columnRows.map((column) => ({
    id: column.id,
    name: column.name,
    tickets: column.tickets.map((ticket) => ({
      id: ticket.id,
      number: ticket.number,
      title: ticket.title,
      assigneeName: ticket.assignee?.name ?? null,
      commentCount: ticket._count.comments,
      priority: ticket.priority,
      dueDateLabel: ticket.dueDate ? dayFormat.format(ticket.dueDate) : null,
      overdue: ticket.dueDate ? ticket.dueDate < startOfToday : false,
      updatedAtLabel: stampFormat.format(ticket.updatedAt),
    })),
  }));

  /** Sibling boards in this project, for the context menu's "Move to board". */
  const boardRows = await prisma.board.findMany({
    where: { projectId: ctx.project.id },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    select: { id: true, name: true },
  });

  const ticketCount = columns.reduce((total, column) => total + column.tickets.length, 0);
  const href = boardPath(ctx.org, ctx.project, ctx.board);

  return (
    <div className="flex flex-col gap-6">
      {/* The header already carries org > project, so this trail is redundant
          on a phone where every row of chrome costs real estate. */}
      <nav
        aria-label="Breadcrumb"
        className="hidden flex-wrap items-center gap-1 text-sm text-muted md:flex"
      >
        <Crumb href={orgPath(ctx.org)}>{ctx.org.name}</Crumb>
        <CrumbSeparator />
        <Crumb href={projectPath(ctx.org, ctx.project)}>{ctx.project.name}</Crumb>
        <CrumbSeparator />
        <span aria-current="page" className="px-0.5 font-medium text-foreground">
          {ctx.board.name}
        </span>
      </nav>

      <PageHeader title={ctx.board.name}>
        <Badge className="font-mono">{ctx.project.key}</Badge>
        <span className="text-sm text-muted tabular-nums">
          {ticketCount} {ticketCount === 1 ? 'ticket' : 'tickets'}
        </span>
        <span className="text-sm text-muted">
          &middot; {columns.length} {columns.length === 1 ? 'column' : 'columns'}
        </span>
      </PageHeader>

      <BoardView
        boardId={ctx.board.id}
        boardHref={href}
        projectKey={ctx.project.key}
        columns={columns}
        members={members}
        boards={boardRows}
      />

      {ticketCount === 0 ? (
        <p className="text-sm text-muted">
          Add a card to any column to get started, then drag cards between columns as work moves
          along.
        </p>
      ) : null}
    </div>
  );
}
