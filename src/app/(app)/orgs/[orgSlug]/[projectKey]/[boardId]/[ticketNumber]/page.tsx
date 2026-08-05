import { notFound, permanentRedirect } from 'next/navigation';

import { loadPage, requireBoardInPath, ticketPath } from '@/lib/authz';
import { prisma } from '@/lib/db';
import { ticketNumberSchema } from '@/lib/validation';

/**
 * The old issue URL: `/orgs/<org>/<KEY>/<boardId>/<number>`.
 *
 * Issue numbers are unique per PROJECT now, not per board. The migration only
 * renumbered projects that actually collided, so for a single-board project --
 * the common case — the old number is still the right one and this redirect is
 * exact. Where a project did collide, the number in an old link may now belong
 * to a different issue, so the lookup is constrained to the ORIGINAL board as
 * well; a number that no longer names an issue of that board 404s instead of
 * silently landing somebody on the wrong ticket.
 */

type Params = {
  orgSlug: string;
  projectKey: string;
  boardId: string;
  ticketNumber: string;
};

export default async function LegacyTicketPage({ params }: { params: Promise<Params> }) {
  const { orgSlug, projectKey, boardId, ticketNumber } = await params;

  const parsedNumber = ticketNumberSchema.safeParse(ticketNumber);
  if (!parsedNumber.success) notFound();

  const ctx = await loadPage(() => requireBoardInPath(orgSlug, projectKey.toUpperCase(), boardId));

  const issue = await prisma.ticket.findFirst({
    where: {
      number: parsedNumber.data,
      projectId: ctx.project.id,
      boardId: ctx.board.id,
      project: { organization: { memberships: { some: { userId: ctx.user.id } } } },
    },
    select: { number: true },
  });
  if (!issue) notFound();

  permanentRedirect(ticketPath(ctx.org, ctx.project, issue.number));
}
