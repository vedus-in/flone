import { permanentRedirect } from 'next/navigation';

import { boardPath, loadPage, requireBoardInPath } from '@/lib/authz';

/**
 * The old board URL: `/orgs/<org>/<KEY>/<boardId>`.
 *
 * Boards moved under `/boards/` so a cuid can never shadow a literal segment --
 * `issues`, `cycles`, `views` and `settings` all sit at this level now. Next
 * matches static segments before dynamic ones, so this route only ever catches
 * what is left over, which is exactly the old links.
 *
 * `requireBoardInPath` still authorizes before redirecting: an unknown or
 * cross-tenant id must 404 here rather than bounce to a URL that then 404s, or
 * the redirect itself becomes an existence oracle.
 */

type Params = { orgSlug: string; projectKey: string; boardId: string };

export default async function LegacyBoardPage({ params }: { params: Promise<Params> }) {
  const { orgSlug, projectKey, boardId } = await params;
  const ctx = await loadPage(() => requireBoardInPath(orgSlug, projectKey.toUpperCase(), boardId));
  permanentRedirect(boardPath(ctx.org, ctx.project, ctx.board));
}
