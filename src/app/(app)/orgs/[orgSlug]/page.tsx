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
  Badge,
  EmptyState,
  Input,
  Label,
  PageHeader,
  SubmitButton,
  Textarea,
  TextField,
} from '@/components/ui';
import { ActionForm } from '../../action-form';
import { createProject } from './actions';

const DESCRIPTION_PREVIEW = 140;

function preview(text: string): string {
  const single = text.replace(/\s+/g, ' ').trim();
  return single.length > DESCRIPTION_PREVIEW
    ? `${single.slice(0, DESCRIPTION_PREVIEW)}...`
    : single;
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
  const projects = await prisma.project.findMany({
    where: {
      organizationId: ctx.org.id,
      organization: { memberships: { some: { userId: ctx.user.id } } },
    },
    select: {
      id: true,
      name: true,
      key: true,
      description: true,
      _count: { select: { boards: true } },
    },
    orderBy: [{ key: 'asc' }, { id: 'asc' }],
  });

  const canManage = atLeast(ctx.role, Role.ADMIN);
  const empty = projects.length === 0;

  return (
    <div className="flex flex-col gap-8">
      {/* No section tabs here: the sidebar already carries "Members & settings"
          for this organization, and duplicating navigation in two places just
          makes it ambiguous which one is authoritative. */}
      <PageHeader title={ctx.org.name}>
        <Badge tone="accent">{ctx.role}</Badge>
        <span className="font-mono text-xs text-muted">/orgs/{ctx.org.slug}</span>
      </PageHeader>

      <section className="flex flex-col gap-4" aria-labelledby="projects-heading">
        <div className="flex items-baseline justify-between gap-3">
          <h2 id="projects-heading" className="text-sm font-medium text-foreground">
            Projects
          </h2>
          {!empty ? (
            <span className="text-xs text-muted">
              {projects.length} {projects.length === 1 ? 'project' : 'projects'}
            </span>
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
          <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {projects.map((project) => (
              <li key={project.id}>
                {/* The title's `::after` covers the card, so the whole tile is
                    one link -- one tab stop, one accessible name. */}
                <Card className="h-full gap-2 transition-colors hover:bg-surface-hover has-[a:focus-visible]:focus-ring">
                  <Card.Header className="flex-row items-center justify-between gap-3">
                    <Badge>{project.key}</Badge>
                    <span className="text-xs text-muted">
                      {project._count.boards}{' '}
                      {project._count.boards === 1 ? 'board' : 'boards'}
                    </span>
                  </Card.Header>
                  <Card.Content>
                    <Card.Title className="text-base">
                      <Link
                        href={projectPath(ctx.org, project)}
                        className="rounded-sm outline-none after:absolute after:inset-0 after:content-['']"
                      >
                        {project.name}
                      </Link>
                    </Card.Title>
                    {project.description ? (
                      <Card.Description className="line-clamp-2">
                        {preview(project.description)}
                      </Card.Description>
                    ) : null}
                  </Card.Content>
                </Card>
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* Empty states never dangle an action the viewer's role cannot perform.
          The action re-checks the role regardless (SPEC 5). */}
      {canManage ? (
        <section aria-labelledby="new-project-heading">
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
