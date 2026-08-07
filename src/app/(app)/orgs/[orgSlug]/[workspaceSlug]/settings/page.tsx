import { notFound } from 'next/navigation';
import { Role } from '@prisma/client';
import { prisma } from '@/lib/db';
import { atLeast, loadPage, requireWorkspaceBySlug } from '@/lib/authz';
import { Card, Field, Input, SubmitButton } from '@/components/ui';
import { ActionForm } from '../../../../action-form';
import { deleteWorkspace, renameWorkspace } from '../actions';

/**
 * Workspace settings: the name, and the door marked danger.
 *
 * ADMIN+ only. A MEMBER who reaches this URL gets a 404 rather than a 403 --
 * the same posture as every other authorization failure in the app, so nothing
 * here confirms what it is guarding.
 *
 * There is no slug field. The slug is the URL segment for this workspace AND
 * for every project inside it, so it is immutable for the same reason
 * `Project.key` is: rewriting it would break every link anyone has saved.
 */

type Params = { orgSlug: string; workspaceSlug: string };

export default async function WorkspaceSettingsPage({ params }: { params: Promise<Params> }) {
  const { orgSlug, workspaceSlug } = await params;
  const ctx = await loadPage(() => requireWorkspaceBySlug(orgSlug, workspaceSlug));

  if (!atLeast(ctx.role, Role.ADMIN)) notFound();
  const canDelete = atLeast(ctx.role, Role.OWNER);

  const projectCount = await prisma.project.count({
    where: {
      workspaceId: ctx.workspace.id,
      organization: { memberships: { some: { userId: ctx.user.id } } },
    },
  });

  return (
    <div className="flex flex-col gap-8">
      <div className="flex flex-col gap-1">
        <h1 className="text-sm font-medium text-primary">{ctx.workspace.name}</h1>
        <p className="text-xs text-tertiary">
          Workspace settings ·{' '}
          <span className="font-mono">
            /orgs/{ctx.org.slug}/{ctx.workspace.slug}
          </span>
        </p>
      </div>

      {/* ------------------------------------------------------------------ */}
      <section className="flex flex-col gap-3" aria-labelledby="general-heading">
        <h2 id="general-heading" className="text-sm font-medium text-primary">
          General
        </h2>
        <Card>
          <ActionForm
            action={renameWorkspace}
            className="flex flex-col gap-4"
            aria-label="Rename workspace"
          >
            <input type="hidden" name="orgSlug" value={ctx.org.slug} />
            <input type="hidden" name="workspaceSlug" value={ctx.workspace.slug} />
            <Field
              htmlFor="workspace-name"
              label="Name"
              hint="The URL does not change."
              className="max-w-sm"
            >
              <Input
                id="workspace-name"
                name="name"
                required
                maxLength={60}
                autoComplete="off"
                defaultValue={ctx.workspace.name}
              />
            </Field>
            <div className="flex">
              <SubmitButton pendingLabel="Saving...">Save</SubmitButton>
            </div>
          </ActionForm>
        </Card>
      </section>

      {/* ------------------------------------------------------------------ */}
      {canDelete ? (
        <section className="flex flex-col gap-3" aria-labelledby="danger-heading">
          <h2 id="danger-heading" className="text-sm font-medium text-error-primary">
            Danger zone
          </h2>
          <Card className="gap-0 p-0 ring-error_subtle">
            <details className="group">
              <summary className="flex cursor-pointer list-none items-center justify-between gap-3 rounded-xl px-5 py-4 text-sm font-medium text-error-primary">
                Delete this workspace
              </summary>
              <div className="flex flex-col gap-4 px-5 pb-5">
                {projectCount > 0 ? (
                  <p className="max-w-prose text-sm text-tertiary">
                    {projectCount === 1
                      ? 'This workspace still holds 1 project.'
                      : `This workspace still holds ${projectCount} projects.`}{' '}
                    Move them to another workspace, or delete them, first. Deleting a
                    workspace never deletes the work grouped under it.
                  </p>
                ) : (
                  <p className="max-w-prose text-sm text-tertiary">
                    This workspace is empty. Deleting it removes the grouping only.
                  </p>
                )}

                {projectCount === 0 ? (
                  <ActionForm
                    action={deleteWorkspace}
                    className="flex flex-col gap-3"
                    aria-label="Delete workspace"
                  >
                    <input type="hidden" name="orgSlug" value={ctx.org.slug} />
                    <input type="hidden" name="workspaceSlug" value={ctx.workspace.slug} />
                    <Field
                      htmlFor="workspace-confirm-name"
                      label={`Type ${ctx.workspace.name} to confirm`}
                      className="max-w-xs"
                    >
                      <Input
                        id="workspace-confirm-name"
                        name="confirmName"
                        required
                        maxLength={60}
                        autoComplete="off"
                        spellCheck={false}
                      />
                    </Field>
                    <div className="flex">
                      <SubmitButton color="primary-destructive" pendingLabel="Deleting...">
                        Delete workspace
                      </SubmitButton>
                    </div>
                  </ActionForm>
                ) : null}
              </div>
            </details>
          </Card>
        </section>
      ) : null}
    </div>
  );
}
