import Link from 'next/link';
import { Role } from '@prisma/client';
import { ChevronDown } from '@untitledui/icons';
import { prisma } from '@/lib/db';
import { atLeast, loadPage, requireOrgBySlug, workspacePath } from '@/lib/authz';
import { Card, EmptyState, Field, Input, SubmitButton } from '@/components/ui';
import { ActionForm } from '../../action-form';
import { createWorkspace } from './actions';

/**
 * The organization root: its workspaces.
 *
 * This used to be the project list, which now lives one level down under the
 * workspace that owns it. Every project has exactly one workspace, so nothing is
 * reachable from here that is not reachable through one of these rows.
 */
const ROW =
  'grid grid-cols-[minmax(0,1fr)_4.5rem] items-center gap-3 px-3 sm:grid-cols-[minmax(0,1fr)_8rem_4.5rem]';

function WorkspaceIcon() {
  return (
    <svg viewBox="0 0 16 16" fill="none" aria-hidden="true" className="size-4 shrink-0 text-tertiary">
      <path
        d="M2.25 5.25A1.5 1.5 0 0 1 3.75 3.75h2.19c.4 0 .78.16 1.06.44l.81.81h4.44a1.5 1.5 0 0 1 1.5 1.5v5.25a1.5 1.5 0 0 1-1.5 1.5h-8.5a1.5 1.5 0 0 1-1.5-1.5z"
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
  const workspaces = await prisma.workspace.findMany({
    where: {
      organizationId: ctx.org.id,
      organization: { memberships: { some: { userId: ctx.user.id } } },
    },
    select: {
      id: true,
      name: true,
      slug: true,
      _count: { select: { projects: true } },
    },
    orderBy: [{ name: 'asc' }, { id: 'asc' }],
  });

  const canManage = atLeast(ctx.role, Role.ADMIN);
  const empty = workspaces.length === 0;

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-center justify-between gap-3">
        <h1 className="text-sm font-medium text-primary">Workspaces</h1>
        {canManage ? (
          <a
            href="#new-workspace"
            aria-label="New workspace"
            title="New workspace"
            className="grid size-6 place-items-center rounded-md text-tertiary no-underline transition-colors hover:bg-secondary hover:text-primary"
          >
            <svg viewBox="0 0 16 16" fill="none" aria-hidden="true" className="size-4">
              <path d="M8 3.5v9M3.5 8h9" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
            </svg>
          </a>
        ) : null}
      </div>

      {empty ? (
        <EmptyState
          title="No workspaces yet"
          description={
            canManage
              ? 'A workspace groups related projects. Create the first one below.'
              : 'Ask an owner or admin to create one.'
          }
        />
      ) : (
        <section className="flex flex-col" aria-label="Workspaces">
          <div
            className={`${ROW} border-b border-secondary py-2 text-xs text-tertiary`}
            aria-hidden="true"
          >
            <span>Name</span>
            <span className="hidden sm:block">URL</span>
            <span className="text-end">Projects</span>
          </div>

          <ul className="flex flex-col">
            {workspaces.map((workspace) => (
              <li
                key={workspace.id}
                /* The name link's `::after` covers the row, so the whole row is
                   one link -- one tab stop, one accessible name. */
                className={`${ROW} relative border-b border-secondary/60 py-2.5 text-sm transition-colors hover:bg-primary_hover has-[a:focus-visible]:outline-2 has-[a:focus-visible]:outline-offset-2 has-[a:focus-visible]:outline-focus-ring`}
              >
                <span className="flex min-w-0 items-center gap-2">
                  <WorkspaceIcon />
                  <Link
                    href={workspacePath(ctx.org, workspace)}
                    className="truncate font-medium text-primary no-underline outline-none after:absolute after:inset-0 after:content-['']"
                  >
                    {workspace.name}
                  </Link>
                </span>
                <span className="hidden truncate font-mono text-xs text-tertiary sm:block">
                  /{workspace.slug}
                </span>
                <span className="text-end text-xs text-tertiary tabular-nums">
                  {workspace._count.projects}
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}

      {/* Empty states never dangle an action the viewer's role cannot perform.
          The action re-checks the role regardless (SPEC 5). */}
      {canManage ? (
        <section id="new-workspace" aria-labelledby="new-workspace-heading">
          <Card className="gap-0 p-0">
            <details className="group" open={empty}>
              <summary
                id="new-workspace-heading"
                className="flex cursor-pointer list-none items-center justify-between gap-3 rounded-xl px-5 py-4 text-sm font-medium text-primary"
              >
                New workspace
                <ChevronDown
                  aria-hidden="true"
                  className="size-4 transition-transform duration-100 group-open:rotate-180"
                />
              </summary>
              <div className="px-5 pb-5">
                <ActionForm
                  action={createWorkspace}
                  className="flex flex-col gap-5"
                  aria-label="New workspace"
                >
                  <input type="hidden" name="orgSlug" value={ctx.org.slug} />

                  <Field htmlFor="workspace-name" label="Name">
                    <Input
                      id="workspace-name"
                      name="name"
                      required
                      maxLength={60}
                      autoComplete="off"
                      autoFocus={empty}
                      placeholder="Platform"
                    />
                  </Field>

                  <details className="group/adv">
                    <summary className="cursor-pointer list-none text-xs text-tertiary">
                      Advanced: choose a URL
                    </summary>
                    <div className="pt-3">
                      <Field
                        htmlFor="workspace-slug"
                        label="URL"
                        hint={`/orgs/${ctx.org.slug}/…  Derived from the name if blank.`}
                      >
                        <Input
                          id="workspace-slug"
                          name="slug"
                          maxLength={40}
                          pattern="[a-z0-9][a-z0-9-]{0,38}[a-z0-9]"
                          autoComplete="off"
                          placeholder="platform"
                          spellCheck={false}
                        />
                      </Field>
                    </div>
                  </details>

                  <div className="flex flex-wrap items-center gap-2">
                    <SubmitButton pendingLabel="Creating...">Create workspace</SubmitButton>
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
