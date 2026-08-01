import Link from 'next/link';
import { Role } from '@prisma/client';
import { prisma } from '@/lib/db';
import {
  atLeast,
  loadPage,
  orgPath,
  orgSettingsPath,
  projectPath,
  requireOrgBySlug,
} from '@/lib/authz';
import {
  Badge,
  EmptyState,
  Field,
  Input,
  SubmitButton,
  Textarea,
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
    <>
      <nav className="breadcrumb" aria-label="Breadcrumb">
        <Link href="/">Organizations</Link>
        <span className="sep">/</span>
        <span aria-current="page">{ctx.org.name}</span>
      </nav>

      <div className="page-head">
        <div className="stack-sm">
          <h1>{ctx.org.name}</h1>
          <p className="faint mono">/orgs/{ctx.org.slug}</p>
        </div>
        <Badge tone="accent">{ctx.role}</Badge>
      </div>

      <nav className="tabs" aria-label="Organization sections">
        <Link className="tab" aria-current="page" href={orgPath(ctx.org)}>
          Projects
        </Link>
        <Link className="tab" href={orgSettingsPath(ctx.org)}>
          Members &amp; settings
        </Link>
      </nav>

      <div className="stack">
        {empty ? (
          <EmptyState
            title="No projects yet"
            description={
              canManage
                ? 'A project groups boards for one piece of work. Create the first one below.'
                : 'Ask an owner or admin to create one.'
            }
          />
        ) : (
          <div className="grid">
            {projects.map((project) => (
              <Link
                key={project.id}
                href={projectPath(ctx.org, project)}
                className="card card-link"
              >
                <div className="stack-sm">
                  <div className="row">
                    <Badge>{project.key}</Badge>
                    <h2>{project.name}</h2>
                  </div>
                  {project.description ? (
                    <p className="muted">{preview(project.description)}</p>
                  ) : null}
                  <p className="faint">
                    {project._count.boards} {project._count.boards === 1 ? 'board' : 'boards'}
                  </p>
                </div>
              </Link>
            ))}
          </div>
        )}

        {/* Empty states never dangle an action the viewer's role cannot perform.
            The action re-checks the role regardless (SPEC 5). */}
        {canManage ? (
          <details className="card" open={empty}>
            <summary>New project</summary>
            <ActionForm action={createProject} className="stack" aria-label="New project">
              <input type="hidden" name="orgSlug" value={ctx.org.slug} />

              <Field htmlFor="project-name" label="Name">
                <Input
                  id="project-name"
                  name="name"
                  required
                  maxLength={80}
                  autoFocus={empty}
                  placeholder="Website Redesign"
                  autoComplete="off"
                />
              </Field>

              <Field
                htmlFor="project-key"
                label="Key"
                hint="Optional. 2 to 10 characters, a letter followed by letters or digits. We derive one from the name if you leave this blank."
              >
                <Input
                  id="project-key"
                  name="key"
                  maxLength={10}
                  pattern="[A-Za-z][A-Za-z0-9]{1,9}"
                  placeholder="WEB"
                  autoComplete="off"
                  spellCheck={false}
                />
              </Field>

              <Field htmlFor="project-description" label="Description" hint="Optional.">
                <Textarea id="project-description" name="description" maxLength={2000} />
              </Field>

              <div className="row">
                <SubmitButton pendingLabel="Creating...">Create project</SubmitButton>
              </div>
            </ActionForm>
          </details>
        ) : null}
      </div>
    </>
  );
}
