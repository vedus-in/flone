import Link from 'next/link';
import { notFound, permanentRedirect } from 'next/navigation';
import { Role } from '@prisma/client';
import { ChevronDown } from '@untitledui/icons';
import { prisma } from '@/lib/db';
import {
  atLeast,
  findProjectByKeyInOrg,
  findWorkspaceBySlug,
  loadPage,
  projectPath,
  workspaceSettingsPath,
  visibleProject,
} from '@/lib/authz';
import {
  Card,
  EmptyState,
  Field,
  Input,
  SubmitButton,
  Textarea,
} from '@/components/ui';
import { ActionForm } from '../../../action-form';
import { createProject } from './actions';

/**
 * A workspace's project list. This is the page the organization root used to be,
 * moved down one level now that projects are grouped.
 *
 * One grid definition shared by the header row and every project row, so the
 * columns cannot drift apart. Below `sm` only the name and the ticket count
 * survive -- the rest are `hidden`, and grid simply does not place them.
 */
const ROW =
  'grid grid-cols-[minmax(0,1fr)_3.5rem] items-center gap-3 px-3 sm:grid-cols-[minmax(0,1fr)_5rem_4.5rem_4.5rem_5.5rem]';

const UPDATED = new Intl.DateTimeFormat('en', { month: 'short', day: 'numeric' });

type Params = { orgSlug: string; workspaceSlug: string };

function ProjectIcon() {
  return (
    <svg viewBox="0 0 16 16" fill="none" aria-hidden="true" className="size-4 shrink-0 text-tertiary">
      <path
        d="M8 1.75 13.75 5v6L8 14.25 2.25 11V5zM2.25 5 8 8.25 13.75 5M8 8.25v6"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export default async function WorkspacePage({ params }: { params: Promise<Params> }) {
  const { orgSlug, workspaceSlug } = await params;

  // A pre-workspace project URL -- `/orgs/acme/VED` -- lands here, because the
  // project key now sits one segment deeper. Spelling cannot tell the two apart
  // at the routing layer (see the note in next.config.ts), so the database does:
  // a workspace by that slug wins, and only if there is none is the segment
  // tried as a project key. Both lookups carry the membership predicate, so this
  // reveals nothing a member could not already see.
  //
  // Only the BARE project URL is recovered this way. `/orgs/acme/VED/issues` and
  // deeper resolve to routes below this one and 404 there.
  const ctx = await loadPage(() => findWorkspaceBySlug(orgSlug, workspaceSlug));
  if (!ctx) {
    const legacy = await loadPage(() => findProjectByKeyInOrg(orgSlug, workspaceSlug.toUpperCase()));
    if (legacy) permanentRedirect(projectPath(legacy.org, legacy.project));
    notFound();
  }

  // `workspaceId` comes from the upward walk, never from the URL. The nested
  // membership predicate is belt-and-braces: it makes the tenant boundary part
  // of this query too, so the read is safe when read in isolation (SPEC 3).
  //
  // Ticket totals ride along on the boards selection rather than a second
  // query: `_count` cannot reach across two relations, and a project has a
  // handful of boards, not thousands.
  const projects = await prisma.project.findMany({
    where: visibleProject(ctx.user.id, { workspaceId: ctx.workspace.id }),
    select: {
      id: true,
      name: true,
      key: true,
      // Unused by the row, but `ProjectRef` (and so `projectPath`) requires it.
      description: true,
      updatedAt: true,
      boards: { select: { _count: { select: { tickets: true } } } },
    },
    orderBy: [{ key: 'asc' }, { id: 'asc' }],
  });

  const canManage = atLeast(ctx.role, Role.ADMIN);
  const empty = projects.length === 0;

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-center justify-between gap-3">
        <h1 className="text-sm font-medium text-primary">{ctx.workspace.name}</h1>
        <div className="flex items-center gap-1">
          {canManage ? (
            <Link
              href={workspaceSettingsPath(ctx.org, ctx.workspace)}
              className="rounded-md px-2 py-1 text-xs text-tertiary no-underline transition-colors hover:bg-secondary hover:text-primary"
            >
              Settings
            </Link>
          ) : null}
          {canManage ? (
            <a
              href="#new-project"
              aria-label="New project"
              title="New project"
              className="grid size-6 place-items-center rounded-md text-tertiary no-underline transition-colors hover:bg-secondary hover:text-primary"
            >
              <svg viewBox="0 0 16 16" fill="none" aria-hidden="true" className="size-4">
                <path
                  d="M8 3.5v9M3.5 8h9"
                  stroke="currentColor"
                  strokeWidth="1.5"
                  strokeLinecap="round"
                />
              </svg>
            </a>
          ) : null}
        </div>
      </div>

      {empty ? (
        <EmptyState
          title="No projects in this workspace"
          description={
            canManage
              ? 'A project owns its issue key, its workflow and its cycles. Create the first one below.'
              : 'Ask an owner or admin to create one.'
          }
        />
      ) : (
        <section className="flex flex-col" aria-label="Projects">
          <div className="flex items-center gap-2 px-3 pb-2">
            <span className="rounded-md bg-secondary px-2 py-1 text-xs font-medium text-primary">
              Projects
            </span>
            <span className="text-xs text-tertiary tabular-nums">{projects.length}</span>
          </div>

          <div
            className={`${ROW} border-b border-secondary py-2 text-xs text-tertiary`}
            aria-hidden="true"
          >
            <span>Name</span>
            <span className="hidden sm:block">Key</span>
            <span className="hidden text-end sm:block">Boards</span>
            <span className="text-end">Tickets</span>
            <span className="hidden text-end sm:block">Updated</span>
          </div>

          <ul className="flex flex-col">
            {projects.map((project) => {
              const tickets = project.boards.reduce(
                (total, board) => total + board._count.tickets,
                0,
              );
              return (
                <li
                  key={project.id}
                  /* The name link's `::after` covers the row, so the whole row is
                     one link -- one tab stop, one accessible name. */
                  className={`${ROW} relative border-b border-secondary/60 py-2.5 text-sm transition-colors hover:bg-primary_hover has-[a:focus-visible]:outline-2 has-[a:focus-visible]:outline-offset-2 has-[a:focus-visible]:outline-focus-ring`}
                >
                  <span className="flex min-w-0 items-center gap-2">
                    <ProjectIcon />
                    <Link
                      href={projectPath(ctx.org, {
                        ...project,
                        workspaceSlug: ctx.workspace.slug,
                      })}
                      className="truncate font-medium text-primary no-underline outline-none after:absolute after:inset-0 after:content-['']"
                    >
                      {project.name}
                    </Link>
                  </span>
                  <span className="hidden truncate font-mono text-xs text-tertiary sm:block">
                    {project.key}
                  </span>
                  <span className="hidden text-end text-xs text-tertiary tabular-nums sm:block">
                    {project.boards.length}
                  </span>
                  <span className="text-end text-xs text-tertiary tabular-nums">{tickets}</span>
                  <span className="hidden text-end text-xs text-tertiary sm:block">
                    {UPDATED.format(project.updatedAt)}
                  </span>
                </li>
              );
            })}
          </ul>
        </section>
      )}

      {/* Empty states never dangle an action the viewer's role cannot perform.
          The action re-checks the role regardless (SPEC 5). */}
      {canManage ? (
        <section id="new-project" aria-labelledby="new-project-heading">
          <Card className="gap-0 p-0">
            <details className="group" open={empty}>
              <summary
                id="new-project-heading"
                className="flex cursor-pointer list-none items-center justify-between gap-3 rounded-xl px-5 py-4 text-sm font-medium text-primary"
              >
                New project
                <ChevronDown
                  aria-hidden="true"
                  className="size-4 transition-transform duration-100 group-open:rotate-180"
                />
              </summary>
              <div className="px-5 pb-5">
                <ActionForm
                  action={createProject}
                  className="flex flex-col gap-5"
                  aria-label="New project"
                >
                  <input type="hidden" name="orgSlug" value={ctx.org.slug} />
                  <input type="hidden" name="workspaceSlug" value={ctx.workspace.slug} />

                  <div className="grid gap-5 sm:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
                    <Field htmlFor="project-name" label="Name">
                      <Input
                        id="project-name"
                        name="name"
                        required
                        maxLength={80}
                        autoComplete="off"
                        autoFocus={empty}
                        placeholder="Website Redesign"
                      />
                    </Field>

                    <Field
                      htmlFor="project-key"
                      label="Key"
                      hint="Optional. Derived from the name if blank. Unique across the organization."
                    >
                      <Input
                        id="project-key"
                        name="key"
                        maxLength={10}
                        pattern="[A-Za-z][A-Za-z0-9]{1,9}"
                        autoComplete="off"
                        placeholder="WEB"
                        spellCheck={false}
                      />
                    </Field>
                  </div>

                  <Field htmlFor="project-description" label="Description" hint="Optional.">
                    <Textarea
                      id="project-description"
                      name="description"
                      rows={3}
                      maxLength={2000}
                    />
                  </Field>

                  <div className="flex flex-wrap items-center gap-2">
                    <SubmitButton pendingLabel="Creating...">Create project</SubmitButton>
                  </div>
                </ActionForm>
              </div>
            </details>
          </Card>
        </section>
      ) : null}
    </div>
  );
}
