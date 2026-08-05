import Link from 'next/link';
import { Role } from '@prisma/client';
import { ChevronDown } from '@untitledui/icons';
import { prisma } from '@/lib/db';
import {
  atLeast,
  boardPath,
  loadPage,
  orgPath,
  requireProjectByKey,
} from '@/lib/authz';
import {
  Badge,
  Breadcrumbs,
  ButtonLink,
  Card,
  EmptyState,
  Field,
  Input,
  PageHeader,
  Prose,
  Separator,
  SubmitButton,
  Textarea,
} from '@/components/ui';
import { ActionForm } from '../../../action-form';
import { createBoard, deleteBoard, deleteProject, renameBoard, updateProject } from './actions';

export default async function ProjectPage({
  params,
}: {
  params: Promise<{ orgSlug: string; projectKey: string }>;
}) {
  const { orgSlug, projectKey } = await params;

  // SPEC 5: the project segment is the uppercase key, normalized before it ever
  // reaches Prisma so a lowercase deep link still resolves.
  const ctx = await loadPage(() => requireProjectByKey(orgSlug, projectKey.toUpperCase()));

  const boards = await prisma.board.findMany({
    where: {
      projectId: ctx.project.id,
      project: { organization: { memberships: { some: { userId: ctx.user.id } } } },
    },
    select: {
      id: true,
      name: true,
      _count: { select: { tickets: true } },
    },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
  });

  const canManage = atLeast(ctx.role, Role.ADMIN);
  const empty = boards.length === 0;

  return (
    <div className="flex flex-col gap-8">
      <div className="flex flex-col gap-5">
        <Breadcrumbs>
          <Breadcrumbs.Item href="/">Organizations</Breadcrumbs.Item>
          <Breadcrumbs.Item href={orgPath(ctx.org)}>{ctx.org.name}</Breadcrumbs.Item>
          <Breadcrumbs.Item>{ctx.project.key}</Breadcrumbs.Item>
        </Breadcrumbs>

        <PageHeader title={ctx.project.name}>
          <Badge>{ctx.project.key}</Badge>
          <span className="text-xs text-tertiary">
            {boards.length} {boards.length === 1 ? 'board' : 'boards'}
          </span>
        </PageHeader>

        {ctx.project.description ? (
          <Prose className="max-w-prose text-tertiary">{ctx.project.description}</Prose>
        ) : null}
      </div>

      {/* ------------------------------------------------------------------ */}
      {/* Boards                                                              */}
      {/* ------------------------------------------------------------------ */}
      <section className="flex flex-col gap-4" aria-labelledby="boards-heading">
        <h2 id="boards-heading" className="text-sm font-medium text-primary">
          Boards
        </h2>

        {empty ? (
          <EmptyState
            title={`No boards in ${ctx.project.key}`}
            description={
              canManage
                ? 'A board holds the To Do / In Progress / Done columns for this project.'
                : 'Ask an owner or admin to create one.'
            }
          />
        ) : (
          <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {boards.map((board) => (
              <li key={board.id}>
                <Card className="flex h-full flex-col">
                  <Card.Header className="flex-row items-center justify-between gap-3">
                    <Card.Title className="min-w-0 text-base">
                      <Link
                        href={boardPath(ctx.org, ctx.project, board)}
                        className="rounded-sm outline-none hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring"
                      >
                        {board.name}
                      </Link>
                    </Card.Title>
                    <span className="shrink-0 text-xs text-tertiary">
                      {board._count.tickets}{' '}
                      {board._count.tickets === 1 ? 'ticket' : 'tickets'}
                    </span>
                  </Card.Header>

                  <Card.Footer className="mt-auto">
                    <ButtonLink
                      href={boardPath(ctx.org, ctx.project, board)}
                      color="secondary"
                      size="sm"
                    >
                      Open board
                    </ButtonLink>
                  </Card.Footer>

                  {canManage ? (
                    <details className="group border-t border-secondary pt-2">
                      <summary className="flex cursor-pointer list-none items-center justify-between gap-2 rounded-lg text-xs font-medium text-tertiary transition-colors hover:text-primary">
                        Manage board
                        <ChevronDown
                          aria-hidden="true"
                          className="size-4 transition-transform duration-100 group-open:rotate-180"
                        />
                      </summary>
                      <div className="flex flex-col gap-4 pt-3">
                        <ActionForm
                          action={renameBoard}
                          className="flex flex-col gap-3"
                          aria-label={`Rename ${board.name}`}
                        >
                          <input type="hidden" name="boardId" value={board.id} />
                          <Field htmlFor={`board-name-${board.id}`} label="Board name">
                            <Input
                              id={`board-name-${board.id}`}
                              name="name"
                              required
                              maxLength={80}
                              autoComplete="off"
                              defaultValue={board.name}
                            />
                          </Field>
                          <div className="flex">
                            <SubmitButton color="secondary" size="sm">
                              Rename
                            </SubmitButton>
                          </div>
                        </ActionForm>

                        <Separator />

                        <ActionForm
                          action={deleteBoard}
                          className="flex flex-col gap-3"
                          aria-label={`Delete ${board.name}`}
                        >
                          <input type="hidden" name="boardId" value={board.id} />
                          <p className="text-xs text-tertiary">
                            Deleting a board removes its tickets and comments permanently.
                          </p>
                          <div className="flex">
                            <SubmitButton
                              color="secondary-destructive"
                              size="sm"
                              pendingLabel="Deleting..."
                            >
                              Delete board
                            </SubmitButton>
                          </div>
                        </ActionForm>
                      </div>
                    </details>
                  ) : null}
                </Card>
              </li>
            ))}
          </ul>
        )}

        {canManage ? (
          <Card className="gap-0 p-0">
            <details className="group" open={empty}>
              <summary className="flex cursor-pointer list-none items-center justify-between gap-3 rounded-xl px-5 py-4 text-sm font-medium text-primary">
                New board
                <ChevronDown
                  aria-hidden="true"
                  className="size-4 transition-transform duration-100 group-open:rotate-180"
                />
              </summary>
              <div className="px-5 pb-5">
                <ActionForm
                  action={createBoard}
                  className="flex flex-col gap-4"
                  aria-label="New board"
                >
                  <input type="hidden" name="orgSlug" value={ctx.org.slug} />
                  <input type="hidden" name="projectKey" value={ctx.project.key} />
                  <Field htmlFor="board-name" label="Name" className="max-w-md">
                    <Input
                      id="board-name"
                      name="name"
                      required
                      maxLength={80}
                      autoComplete="off"
                      autoFocus={empty}
                      placeholder="Sprint 1"
                    />
                  </Field>
                  <div className="flex flex-wrap items-center gap-2">
                    <SubmitButton pendingLabel="Creating...">Create board</SubmitButton>
                  </div>
                </ActionForm>
              </div>
            </details>
          </Card>
        ) : null}
      </section>

      {/* ------------------------------------------------------------------ */}
      {/* Project settings                                                    */}
      {/* ------------------------------------------------------------------ */}
      {canManage ? (
        <section className="flex flex-col gap-4" aria-labelledby="project-settings-heading">
          <h2 id="project-settings-heading" className="text-sm font-medium text-primary">
            Project settings
          </h2>

          <Card className="gap-4 p-6">
            <ActionForm
              action={updateProject}
              className="flex flex-col gap-5"
              aria-label="Update project"
            >
              <input type="hidden" name="orgSlug" value={ctx.org.slug} />
              <input type="hidden" name="projectKey" value={ctx.project.key} />

              <Field
                htmlFor="project-name"
                label="Name"
                hint={`The key ${ctx.project.key} is part of every link and cannot be changed.`}
                className="max-w-md"
              >
                <Input
                  id="project-name"
                  name="name"
                  required
                  maxLength={80}
                  autoComplete="off"
                  defaultValue={ctx.project.name}
                />
              </Field>

              <Field htmlFor="project-description" label="Description" hint="Optional.">
                <Textarea
                  id="project-description"
                  name="description"
                  rows={4}
                  maxLength={2000}
                  defaultValue={ctx.project.description ?? ''}
                />
              </Field>

              <div className="flex flex-wrap items-center gap-2">
                <SubmitButton color="secondary">Save project</SubmitButton>
              </div>
            </ActionForm>
          </Card>

          <Card className="gap-0 p-0 ring-error_subtle">
            <details className="group">
              <summary className="flex cursor-pointer list-none items-center justify-between gap-3 rounded-xl px-6 py-4 text-sm font-medium text-error-primary">
                Delete this project
                <ChevronDown
                  aria-hidden="true"
                  className="size-4 transition-transform duration-100 group-open:rotate-180"
                />
              </summary>
              <div className="flex flex-col gap-4 px-6 pb-6">
                  <p className="max-w-prose text-sm text-tertiary">
                    Every board, ticket and comment in {ctx.project.key} is deleted
                    permanently. This cannot be undone.
                  </p>
                  <ActionForm
                    action={deleteProject}
                    className="flex flex-col gap-4"
                    aria-label="Delete project"
                  >
                    <input type="hidden" name="orgSlug" value={ctx.org.slug} />
                    <input type="hidden" name="projectKey" value={ctx.project.key} />
                    <Field
                      htmlFor="project-confirm-key"
                      label={`Type ${ctx.project.key} to confirm`}
                      className="max-w-xs"
                    >
                      <Input
                        id="project-confirm-key"
                        name="confirmKey"
                        required
                        maxLength={50}
                        autoComplete="off"
                        spellCheck={false}
                      />
                    </Field>
                    <div className="flex flex-wrap items-center gap-2">
                      <SubmitButton color="primary-destructive" pendingLabel="Deleting...">
                        Delete project
                      </SubmitButton>
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
