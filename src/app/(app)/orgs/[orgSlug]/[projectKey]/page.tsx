import Link from 'next/link';
import { Role } from '@prisma/client';

import { Assignee, IssueListView } from '@/components/issue-row';
import {
  atLeast,
  boardsPath,
  cyclePath,
  cyclesPath,
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

type Params = { orgSlug: string; projectKey: string };

const RANGE = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' });

const GO_TO = [
  { key: 'issues', label: 'Issues', icon: 'M2.5 4h11M2.5 8h11M2.5 12h7' },
  { key: 'cycles', label: 'Cycles', icon: 'M8 14.5A6.5 6.5 0 1 0 8 1.5a6.5 6.5 0 0 0 0 13ZM8 4.5v3.7l2.2 1.6' },
  { key: 'boards', label: 'Boards', icon: 'M2.5 2.5h11v11h-11zM6 2.5v11M10 2.5v11' },
  { key: 'views', label: 'Views', icon: 'M1.5 8S4 3.5 8 3.5 14.5 8 14.5 8 12 12.5 8 12.5 1.5 8 1.5 8Z' },
] as const;

export default async function ProjectPage({ params }: { params: Promise<Params> }) {
  const { orgSlug, projectKey } = await params;

  // SPEC 5: the project segment is the uppercase key, normalized before it ever
  // reaches Prisma so a lowercase deep link still resolves.
  const ctx = await loadPage(() => requireProjectByKey(orgSlug, projectKey.toUpperCase()));

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
  };

  const composeState = defaultComposeState(workspace.states);
  const canManage = atLeast(ctx.role, Role.ADMIN);

  return (
    <div className="flex flex-col gap-8">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div className="flex min-w-0 flex-col gap-2">
          <div className="flex items-center gap-2.5">
            <span
              aria-hidden="true"
              className="grid size-7 shrink-0 place-items-center rounded-md bg-brand-solid text-[0.6875rem] font-semibold text-white"
            >
              {ctx.project.key.slice(0, 2)}
            </span>
            <h1 className="text-xl font-semibold text-primary">{ctx.project.name}</h1>
            <span className="rounded bg-secondary px-1.5 py-0.5 font-mono text-[0.6875rem] text-tertiary">
              {ctx.project.key}
            </span>
          </div>
          <p className="max-w-prose text-sm text-tertiary">
            {ctx.project.description ?? 'No description yet.'}
          </p>
        </div>

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
      </header>

      <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,1fr)_16rem]">
        <section className="flex min-w-0 flex-col gap-3">
          <header className="flex flex-wrap items-baseline justify-between gap-2">
            <h2 className="text-sm font-medium text-primary">
              {current ? `In flight — ${current.name ?? `Cycle ${current.number}`}` : 'In flight'}
            </h2>
            {current ? (
              <Link
                href={cyclePath(ctx.org, ctx.project, current.number)}
                className="text-[0.6875rem] text-tertiary no-underline tabular-nums hover:text-primary"
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
              className="w-fit text-[0.8125rem] text-tertiary no-underline hover:text-primary"
            >
              See all {inFlight.total} active issues
            </Link>
          ) : null}
        </section>

        <aside className="flex flex-col gap-6">
          <section className="flex flex-col gap-2">
            <h2 className="text-[0.6875rem] font-medium tracking-wide text-tertiary uppercase">
              Go to
            </h2>
            <ul className="flex flex-col gap-px">
              {GO_TO.map((entry) => (
                <li key={entry.key}>
                  <Link
                    href={paths[entry.key]}
                    className="flex h-8 items-center gap-2 rounded-md px-2 text-[0.8125rem] text-tertiary no-underline transition-colors hover:bg-secondary hover:text-primary"
                  >
                    <svg viewBox="0 0 16 16" fill="none" aria-hidden="true" className="size-3.5">
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
              {canManage ? (
                <li>
                  <Link
                    href={projectSettingsPath(ctx.org, ctx.project)}
                    className="flex h-8 items-center gap-2 rounded-md px-2 text-[0.8125rem] text-tertiary no-underline transition-colors hover:bg-secondary hover:text-primary"
                  >
                    <svg viewBox="0 0 16 16" fill="none" aria-hidden="true" className="size-3.5">
                      <path
                        d="M8 10.25a2.25 2.25 0 1 0 0-4.5 2.25 2.25 0 0 0 0 4.5ZM13 8a5 5 0 0 0-.1-1l1.3-1-1.5-2.6-1.5.6a5 5 0 0 0-1.7-1L9.2 1.5H6.8l-.3 1.6a5 5 0 0 0-1.7 1l-1.5-.6L1.8 6l1.3 1a5 5 0 0 0 0 2l-1.3 1 1.5 2.6 1.5-.6a5 5 0 0 0 1.7 1l.3 1.6h2.4l.3-1.6a5 5 0 0 0 1.7-1l1.5.6 1.5-2.6-1.3-1c.06-.33.1-.66.1-1Z"
                        stroke="currentColor"
                        strokeWidth="1.3"
                        strokeLinejoin="round"
                      />
                    </svg>
                    Project settings
                  </Link>
                </li>
              ) : null}
            </ul>
          </section>

          <section className="flex flex-col gap-2">
            <div className="flex items-center justify-between">
              <h2 className="text-[0.6875rem] font-medium tracking-wide text-tertiary uppercase">
                Members
              </h2>
              <Link
                href={orgSettingsPath(ctx.org)}
                className="text-[0.6875rem] text-tertiary no-underline hover:text-primary"
              >
                Manage
              </Link>
            </div>
            <ul className="flex flex-col gap-1.5">
              {memberships.map((membership) => (
                <li key={membership.id} className="flex items-center gap-2">
                  <Assignee name={membership.user.name} />
                  <span className="min-w-0 flex-1 truncate text-[0.8125rem] text-tertiary">
                    {membership.user.name}
                  </span>
                  <span className="shrink-0 text-[0.625rem] tracking-wide text-tertiary uppercase">
                    {membership.role}
                  </span>
                </li>
              ))}
            </ul>
          </section>
        </aside>
      </div>
    </div>
  );
}
