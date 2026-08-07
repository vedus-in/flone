import { redirect } from 'next/navigation';

import { cyclePath, cyclesPath, loadPage, requireProjectByKey } from '@/lib/authz';
import { ensureCycles } from '@/lib/cycles';

/**
 * `/cycles/current` -- a stable link to whichever cycle is running today.
 *
 * A redirect rather than a copy of the detail page: the sidebar wants one URL
 * that keeps working every fortnight, and the cycle's own page is already the
 * thing to show. `ensureCycles` materializes the row if this is the first time
 * anyone has looked since it began.
 */

type Params = { orgSlug: string; workspaceSlug: string; projectKey: string };

export default async function CurrentCyclePage({ params }: { params: Promise<Params> }) {
  const { orgSlug, workspaceSlug, projectKey } = await params;
  const ctx = await loadPage(() => requireProjectByKey(orgSlug, workspaceSlug, projectKey.toUpperCase()));

  const state = await ensureCycles(ctx.project.id);
  // Cycles switched off: the list page owns that message, so send them there
  // rather than duplicating it.
  if (!state) redirect(cyclesPath(ctx.org, ctx.project));

  redirect(cyclePath(ctx.org, ctx.project, state.current));
}
