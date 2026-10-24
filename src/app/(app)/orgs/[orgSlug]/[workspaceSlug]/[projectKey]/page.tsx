import Link from 'next/link';
import { Role } from '@prisma/client';

import { IconSettings } from '@/components/icons';
import { Assignee, IssueListView } from '@/components/issue-row';
import { PageBar, ProjectGlyph, ToolbarIconLink } from '@/components/page-bar';
import {
  atLeast,
  boardsPath,
  cyclePath,
  cyclesPath,
  docsPath,
  issuesPath,
  loadPage,
  orgSettingsPath,
  projectSettingsPath,
  requireProjectByKey,
  viewsPath,
} from '@/lib/authz';
import { ensureCycles } from '@/lib/cycles';
import { prisma } from '@/lib/db';
import { loadCycleProgress, loadIssues, parseIssueFilters } from '@/lib/issues';
import { defaultComposeState } from '@/lib/states';
import { loadWorkspace } from '@/lib/workspace';

import { IssueComposer } from './issue-composer';
import { RowBoardMenu } from './row-board-menu';

/**
 * The project overview -- Linear's team home.
 *
 * Description, where to go next, who is in the team, and the one thing anybody
 * actually opens this page for: what is in flight right now.
 */

type Params = { orgSlug: string; workspaceSlug: string; projectKey: string };

const RANGE = new Intl.DateTimeFormat('en-US', { day: 'numeric', month: 'short', timeZone: 'UTC' });

const GO_TO = [
  { key: 'issues', label: 'Issues', icon: 'M2.5 4h11M2.5 8h11M2.5 12h7' },
  { key: 'cycles', label: 'Cycles', icon: 'M8 14.5A6.5 6.5 0 1 0 8 1.5a6.5 6.5 0 0 0 0 13ZM8 4.5v3.7l2.2 1.6' },
  { key: 'boards', label: 'Boards', icon: 'M2.5 2.5h11v11h-11zM6 2.5v11M10 2.5v11' },
  { key: 'views', label: 'Views', icon: 'M1.5 8S4 3.5 8 3.5 14.5 8 14.5 8 12 12.5 8 12.5 1.5 8 1.5 8Z' },
  { key: 'docs', label: 'Documents', icon: 'M4 1.5h5l3 3v10H4zM9 1.5v3h3M6 8h4M6 11h4' },
] as const;

export default async function ProjectPage({ params }: { params: Promise<Params> }) {
  const { orgSlug, workspaceSlug, projectKey } = await params;

  // SPEC 5: the project segment is the uppercase key, normalized before it ever
  // reaches Prisma so a lowercase deep link still resolves.
  const ctx = await loadPage(() => requireProjectByKey(orgSlug, workspaceSlug, projectKey.toUpperCase()));

  const workspace = await loadWorkspace(ctx);
  const cycleState = await ensureCycles(ctx.project.id);

  const current = cycleState
    ? await prisma.cycle.findFirst({
        where: { projectId: ctx.project.id, number: cycleState.current },
        select: { id: true, number: true, name: true, startsAt: true, endsAt: true },
      })
    : null;

  const [inFlight, progress, memberships] = await Promise.all([
    loadIssues(ctx, {
      filters: parseIssueFilters({}, 'active'),
      ...(current ? { scope: { cycleId: current.id } } : {}),
      take: 25,
    }),
    current ? loadCycleProgress(ctx.project.id, current.id) : null,
    prisma.membership.findMany({
      where: { organizationId: ctx.org.id },
      orderBy: [{ role: 'asc' }, { user: { name: 'asc' } }, { id: 'asc' }],
      select: { id: true, role: true, user: { select: { id: true, name: true } } },
    }),
  ]);

  const paths: Record<(typeof GO_TO)[number]['key'], string> = {
    issues: issuesPath(ctx.org, ctx.project),
    cycles: cyclesPath(ctx.org, ctx.project),
    boards: boardsPath(ctx.org, ctx.project),
    views: viewsPath(ctx.org, ctx.project),
    docs: docsPath(ctx.org, ctx.project),
  };

  const composeState = defaultComposeState(workspace.states);
  const canManage = atLeast(ctx.role, Role.ADMIN);

  return (
    <>
      <PageBar
        crumbs={[
          {
            label: ctx.project.name,
            icon: <ProjectGlyph projectKey={ctx.project.key} />,
          },
        ]}
        actions={
          <>
            {canManage ? (
              <ToolbarIconLink href={projectSettingsPath(ctx.org, ctx.project)} label="Project settings">
                <IconSettings />
              </ToolbarIconLink>
            ) : null}
            {composeState ? (
              <IssueComposer
                projectId={ctx.project.id}
                projectKey={ctx.project.key}
                states={workspace.states}
                boards={workspace.boards}
                cycles={workspace.cycles}
                labels={workspace.labels}
                members={workspace.members}
                defaultStateId={composeState.id}
                defaultCycleId={current?.id ?? ''}
              />
            ) : null}
          </>
        }
      >
        <span className="rounded bg-tertiary px-1.5 py-0.5 font-mono text-[0.6875rem] text-tertiary">
          {ctx.project.key}
        </span>
      </PageBar>

      <div className="flex items-start">
        <section className="flex min-w-0 flex-1 flex-col py-2">
          <header className="flex h-10 flex-wrap items-center justify-between gap-2 px-4.5">
            <h2 className="text-sm font-medium text-primary">
              {current ? `In flight — ${current.name ?? `Cycle ${current.number}`}` : 'In flight'}
            </h2>
            {current ? (
              <Link
                href={cyclePath(ctx.org, ctx.project, current.number)}
                className="text-xs text-tertiary no-underline tabular-nums hover:text-primary"
              >
                {RANGE.format(current.startsAt)} – {RANGE.format(current.endsAt)}
                {progress ? ` · ${progress.completed}/${progress.scope} done` : null}
              </Link>
            ) : null}
          </header>

          <IssueListView
            groups={inFlight.groups}
            renderAction={(row) => (
              <RowBoardMenu
                ticketId={row.id}
                issueLabel={row.label}
                boardId={row.board?.id ?? null}
                boards={workspace.boards}
              />
            )}
            emptyMessage={
              current
                ? 'Nothing active in this cycle yet.'
                : 'Nothing active right now.'
            }
          />

          {inFlight.total > 25 ? (
            <Link
              href={issuesPath(ctx.org, ctx.project)}
              className="mx-4.5 mt-2 w-fit text-sm text-tertiary no-underline hover:text-primary"
            >
              See all {inFlight.total} active issues
            </Link>
          ) : null}
        </section>

        <aside className="sticky top-13 m-2 hidden w-[300px] shrink-0 flex-col gap-6 rounded-lg border border-secondary_alt bg-secondary p-4 lg:flex">
          <section className="flex flex-col gap-1.5">
            <h2 className="text-xs font-medium text-tertiary">About</h2>
            <p className="text-sm text-pretty text-secondary">
              {ctx.project.description ?? 'No description yet.'}
            </p>
          </section>

          <section className="flex flex-col gap-1">
            <h2 className="pb-1 text-xs font-medium text-tertiary">Go to</h2>
            <ul className="-mx-2 flex flex-col gap-px">
              {GO_TO.map((entry) => (
                <li key={entry.key}>
                  <Link
                    href={paths[entry.key]}
                    className="flex h-8 items-center gap-2 rounded-md px-2 text-sm text-secondary no-underline transition-colors hover:bg-quaternary hover:text-primary"
                  >
                    <svg viewBox="0 0 16 16" fill="none" aria-hidden="true" className="size-4 text-tertiary">
                      <path
                        d={entry.icon}
                        stroke="currentColor"
                        strokeWidth="1.5"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      />
                    </svg>
                    {entry.label}
                  </Link>
                </li>
              ))}
            </ul>
          </section>

          <section className="flex flex-col gap-1">
            <div className="flex items-center justify-between pb-1">
              <h2 className="text-xs font-medium text-tertiary">Members</h2>
              <Link
                href={orgSettingsPath(ctx.org)}
                className="text-xs text-tertiary no-underline hover:text-primary"
              >
                Manage
              </Link>
            </div>
            <ul className="flex flex-col">
              {memberships.map((membership) => (
                <li key={membership.id} className="flex h-8 items-center gap-2">
                  <Assignee name={membership.user.name} />
                  <span className="min-w-0 flex-1 truncate text-sm text-secondary">
                    {membership.user.name}
                  </span>
                  <span className="shrink-0 text-xs text-tertiary capitalize">
                    {membership.role.toLowerCase()}
                  </span>
                </li>
              ))}
            </ul>
          </section>
        </aside>
      </div>
    </>
  );
}
