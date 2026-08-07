import { permanentRedirect } from 'next/navigation';
import { loadPage, projectPath, requireProjectByKeyInOrg } from '@/lib/authz';

/**
 * A workspace-independent permalink into a project: `/orgs/acme/go/VED/issue/153`
 * resolves the key, then 308s to wherever that project currently lives.
 *
 * It works permanently, not just across the workspace migration, because
 * `Project.key` is unique per ORGANIZATION: `VED` names exactly one project in
 * `acme` however the workspaces are later rearranged. That makes it the one
 * shape worth pasting into a ticket or a wiki, since it survives a project being
 * moved between workspaces -- which the canonical URL does not.
 *
 * `go` is in RESERVED_SLUGS, so no workspace can ever occupy this segment.
 *
 * NOT wired to a rewrite. Catching bare `/orgs/acme/VED/...` automatically would
 * need a route pattern that distinguishes an uppercase key from a lowercase
 * workspace slug, and Next matches rewrite sources case-insensitively with no
 * way to opt out (see `next.config.ts`). Bare `/orgs/acme/VED` is recovered in
 * `[workspaceSlug]/page.tsx` by asking the database instead; deeper pre-workspace
 * URLs 404 unless rewritten to this shape by hand.
 */

type Params = { orgSlug: string; projectKey: string; rest?: string[] };

export default async function LegacyProjectPage({
  params,
  searchParams,
}: {
  params: Promise<Params>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { orgSlug, projectKey, rest } = await params;
  const search = await searchParams;

  const ctx = await loadPage(() => requireProjectByKeyInOrg(orgSlug, projectKey.toUpperCase()));

  // The tail is user-controlled. Every segment is re-encoded rather than
  // concatenated raw: `projectPath` guarantees the target starts at
  // `/orgs/<org>/<workspace>/<key>`, and encoding keeps a crafted segment from
  // adding path structure of its own to it. Normal segments are unchanged by it.
  const tail = (rest ?? []).map((segment) => encodeURIComponent(segment)).join('/');

  // Filters and saved-view state live in the query string, so dropping it would
  // land the visitor on the right page with the wrong contents.
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(search)) {
    if (Array.isArray(value)) for (const item of value) query.append(key, item);
    else if (value !== undefined) query.append(key, value);
  }
  const suffix = query.toString();

  const base = projectPath(ctx.org, ctx.project);
  permanentRedirect(`${base}${tail ? `/${tail}` : ''}${suffix ? `?${suffix}` : ''}`);
}
