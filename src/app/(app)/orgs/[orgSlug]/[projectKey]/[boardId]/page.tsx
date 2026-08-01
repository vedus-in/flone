import Link from 'next/link';
import { notFound } from 'next/navigation';

import {
  boardPath,
  loadPage,
  orgPath,
  projectPath,
  requireBoardInPath,
} from '@/lib/authz';
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
 */

type BoardParams = {
  orgSlug: string;
  projectKey: string;
  boardId: string;
};

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
          assignee: { select: { id: true, name: true } },
          _count: { select: { comments: true } },
        },
      },
    },
  });

  const columns: BoardColumnData[] = columnRows.map((column) => ({
    id: column.id,
    name: column.name,
    tickets: column.tickets.map((ticket) => ({
      id: ticket.id,
      number: ticket.number,
      title: ticket.title,
      assigneeName: ticket.assignee?.name ?? null,
      commentCount: ticket._count.comments,
    })),
  }));

  const ticketCount = columns.reduce((total, column) => total + column.tickets.length, 0);
  const href = boardPath(ctx.org, ctx.project, ctx.board);

  return (
    <div className="stack">
      <nav className="breadcrumb" aria-label="Breadcrumb">
        <Link href={orgPath(ctx.org)}>{ctx.org.name}</Link>
        <span className="sep" aria-hidden="true">
          /
        </span>
        <Link href={projectPath(ctx.org, ctx.project)}>{ctx.project.name}</Link>
        <span className="sep" aria-hidden="true">
          /
        </span>
        <span aria-current="page">{ctx.board.name}</span>
      </nav>

      <div className="page-head">
        <div className="stack-sm">
          <h1>{ctx.board.name}</h1>
          <p className="faint">
            <span className="mono">{ctx.project.key}</span> &middot; {ticketCount}{' '}
            {ticketCount === 1 ? 'ticket' : 'tickets'}
          </p>
        </div>
      </div>

      <BoardView
        boardId={ctx.board.id}
        boardHref={href}
        projectKey={ctx.project.key}
        columns={columns}
      />

      {ticketCount === 0 ? (
        <p className="faint">Use the arrows on a card to move it between columns.</p>
      ) : null}
    </div>
  );
}
