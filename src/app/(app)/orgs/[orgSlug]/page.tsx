import Link from 'next/link';
import { Role } from '@prisma/client';
import { Card } from '@heroui/react/card';
import { Description } from '@heroui/react/description';
import { Disclosure } from '@heroui/react/disclosure';
import { prisma } from '@/lib/db';
import {
  atLeast,
  loadPage,
  projectPath,
  requireOrgBySlug,
} from '@/lib/authz';
import {
  EmptyState,
  Input,
  Label,
  SubmitButton,
  Textarea,
  TextField,
} from '@/components/ui';
import { ActionForm } from '../../action-form';
import { createProject } from './actions';

/**
 * One grid definition shared by the header row and every project row, so the
 * columns cannot drift apart. Below `sm` only the name and the ticket count
 * survive -- the rest are `hidden`, and grid simply does not place them.
 */
const ROW =
  'grid grid-cols-[minmax(0,1fr)_3.5rem] items-center gap-3 px-3 sm:grid-cols-[minmax(0,1fr)_5rem_4.5rem_4.5rem_5.5rem]';

const UPDATED = new Intl.DateTimeFormat('en', { month: 'short', day: 'numeric' });

function ProjectIcon() {
  return (
    <svg viewBox="0 0 16 16" fill="none" aria-hidden="true" className="size-4 shrink-0 text-muted">
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

export default async function OrganizationPage({
  params,
}: {
  params: Promise<{ orgSlug: string }>;
}) {
  const { orgSlug } = await params;
  const ctx = await loadPage(() => requireOrgBySlug(orgSlug));

  // `organizationId` comes from the upward walk, never from the URL. The nested
  // membership predicate is belt-and-braces: it makes the tenant boundary part
  // of this query too, so the read is safe when read in isolation (SPEC 3).
  //
  // Ticket totals ride along on the boards selection rather than a second
  // query: `_count` cannot reach across two relations, and a project has a
  // handful of boards, not thousands.
  const projects = await prisma.project.findMany({
    where: {
      organizationId: ctx.org.id,
      organization: { memberships: { some: { userId: ctx.user.id } } },
    },
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
        <h1 className="text-sm font-medium text-foreground">Projects</h1>
        {canManage ? (
          <a
            href="#new-project"
            aria-label="New project"
            title="New project"
            className="grid size-6 place-items-center rounded-md text-muted no-underline transition-colors hover:bg-surface-secondary hover:text-foreground"
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

      {empty ? (
        <EmptyState
          title="No projects yet"
          description={
            canManage
              ? 'A project groups the boards for one piece of work. Create the first one below.'
              : 'Ask an owner or admin to create one.'
          }
        />
      ) : (
        <section className="flex flex-col" aria-label="Projects">
          <div className="flex items-center gap-2 px-3 pb-2">
            <span className="rounded-md bg-surface-secondary px-2 py-1 text-xs font-medium text-foreground">
              All projects
            </span>
            <span className="text-xs text-muted tabular-nums">{projects.length}</span>
          </div>

          <div
            className={`${ROW} border-b border-border py-2 text-xs text-muted`}
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
                  className={`${ROW} relative border-b border-border/60 py-2.5 text-sm transition-colors hover:bg-surface-hover has-[a:focus-visible]:focus-ring`}
                >
                  <span className="flex min-w-0 items-center gap-2">
                    <ProjectIcon />
                    <Link
                      href={projectPath(ctx.org, project)}
                      className="truncate font-medium text-foreground no-underline outline-none after:absolute after:inset-0 after:content-['']"
                    >
                      {project.name}
                    </Link>
                  </span>
                  <span className="hidden truncate font-mono text-xs text-muted sm:block">
                    {project.key}
                  </span>
                  <span className="hidden text-end text-xs text-muted tabular-nums sm:block">
                    {project.boards.length}
                  </span>
                  <span className="text-end text-xs text-muted tabular-nums">{tickets}</span>
                  <span className="hidden text-end text-xs text-muted sm:block">
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
            <Disclosure defaultExpanded={empty}>
              <Disclosure.Heading level={2} id="new-project-heading">
                <Disclosure.Trigger className="flex w-full items-center justify-between gap-3 rounded-2xl px-5 py-4 text-sm font-medium text-foreground">
                  New project
                  <Disclosure.Indicator />
                </Disclosure.Trigger>
              </Disclosure.Heading>
              <Disclosure.Content>
                <div className="px-5 pb-5">
                  <ActionForm
                    action={createProject}
                    className="flex flex-col gap-5"
                    aria-label="New project"
                  >
                    <input type="hidden" name="orgSlug" value={ctx.org.slug} />

                    <div className="grid gap-5 sm:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
                      <TextField isRequired maxLength={80} autoComplete="off" fullWidth>
                        <Label>Name</Label>
                        <Input
                          name="name"
                          autoFocus={empty}
                          placeholder="Website Redesign"
                        />
                      </TextField>

                      <TextField
                        maxLength={10}
                        pattern="[A-Za-z][A-Za-z0-9]{1,9}"
                        autoComplete="off"
                        fullWidth
                      >
                        <Label>Key</Label>
                        <Input name="key" placeholder="WEB" spellCheck={false} />
                        <Description>Optional. Derived from the name if blank.</Description>
                      </TextField>
                    </div>

                    <TextField maxLength={2000} fullWidth>
                      <Label>Description</Label>
                      <Textarea name="description" rows={3} />
                      <Description>Optional.</Description>
                    </TextField>

                    <div className="flex flex-wrap items-center gap-2">
                      <SubmitButton pendingLabel="Creating...">Create project</SubmitButton>
                    </div>
                  </ActionForm>
                </div>
              </Disclosure.Content>
            </Disclosure>
          </Card>
        </section>
      ) : null}
    </div>
  );
}
