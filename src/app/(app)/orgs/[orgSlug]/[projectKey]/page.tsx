import Link from 'next/link';
import { Role } from '@prisma/client';
import { Breadcrumbs } from '@heroui/react/breadcrumbs';
import { Card } from '@heroui/react/card';
import { Description } from '@heroui/react/description';
import { Disclosure } from '@heroui/react/disclosure';
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
  ButtonLink,
  EmptyState,
  Input,
  Label,
  PageHeader,
  Prose,
  Separator,
  SubmitButton,
  Textarea,
  TextField,
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
          <span className="text-xs text-muted">
            {boards.length} {boards.length === 1 ? 'board' : 'boards'}
          </span>
        </PageHeader>

        {ctx.project.description ? (
          <Prose className="max-w-prose text-muted">{ctx.project.description}</Prose>
        ) : null}
      </div>

      {/* ------------------------------------------------------------------ */}
      {/* Boards                                                              */}
      {/* ------------------------------------------------------------------ */}
      <section className="flex flex-col gap-4" aria-labelledby="boards-heading">
        <h2 id="boards-heading" className="text-sm font-medium text-foreground">
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
                        className="rounded-sm outline-none hover:underline focus-visible:focus-ring"
                      >
                        {board.name}
                      </Link>
                    </Card.Title>
                    <span className="shrink-0 text-xs text-muted">
                      {board._count.tickets}{' '}
                      {board._count.tickets === 1 ? 'ticket' : 'tickets'}
                    </span>
                  </Card.Header>

                  <Card.Footer className="mt-auto">
                    <ButtonLink
                      href={boardPath(ctx.org, ctx.project, board)}
                      variant="secondary"
                      size="sm"
                    >
                      Open board
                    </ButtonLink>
                  </Card.Footer>

                  {canManage ? (
                    <Disclosure className="border-t border-border pt-2">
                      <Disclosure.Heading level={3}>
                        <Disclosure.Trigger className="flex w-full items-center justify-between gap-2 rounded-lg text-xs font-medium text-muted transition-colors hover:text-foreground">
                          Manage board
                          <Disclosure.Indicator />
                        </Disclosure.Trigger>
                      </Disclosure.Heading>
                      <Disclosure.Content>
                        <div className="flex flex-col gap-4 pt-3">
                          <ActionForm
                            action={renameBoard}
                            className="flex flex-col gap-3"
                            aria-label={`Rename ${board.name}`}
                          >
                            <input type="hidden" name="boardId" value={board.id} />
                            <TextField
                              isRequired
                              maxLength={80}
                              autoComplete="off"
                              defaultValue={board.name}
                              fullWidth
                            >
                              <Label>Board name</Label>
                              <Input name="name" />
                            </TextField>
                            <div className="flex">
                              <SubmitButton variant="secondary" size="sm">
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
                            <p className="text-xs text-muted">
                              Deleting a board removes its tickets and comments permanently.
                            </p>
                            <div className="flex">
                              <SubmitButton
                                variant="danger-soft"
                                size="sm"
                                pendingLabel="Deleting..."
                              >
                                Delete board
                              </SubmitButton>
                            </div>
                          </ActionForm>
                        </div>
                      </Disclosure.Content>
                    </Disclosure>
                  ) : null}
                </Card>
              </li>
            ))}
          </ul>
        )}

        {canManage ? (
          <Card className="gap-0 p-0">
            <Disclosure defaultExpanded={empty}>
              <Disclosure.Heading level={3}>
                <Disclosure.Trigger className="flex w-full items-center justify-between gap-3 rounded-2xl px-5 py-4 text-sm font-medium text-foreground">
                  New board
                  <Disclosure.Indicator />
                </Disclosure.Trigger>
              </Disclosure.Heading>
              <Disclosure.Content>
                <div className="px-5 pb-5">
                  <ActionForm
                    action={createBoard}
                    className="flex flex-col gap-4"
                    aria-label="New board"
                  >
                    <input type="hidden" name="orgSlug" value={ctx.org.slug} />
                    <input type="hidden" name="projectKey" value={ctx.project.key} />
                    <TextField
                      isRequired
                      maxLength={80}
                      autoComplete="off"
                      fullWidth
                      className="max-w-md"
                    >
                      <Label>Name</Label>
                      <Input name="name" autoFocus={empty} placeholder="Sprint 1" />
                    </TextField>
                    <div className="flex flex-wrap items-center gap-2">
                      <SubmitButton pendingLabel="Creating...">Create board</SubmitButton>
                    </div>
                  </ActionForm>
                </div>
              </Disclosure.Content>
            </Disclosure>
          </Card>
        ) : null}
      </section>

      {/* ------------------------------------------------------------------ */}
      {/* Project settings                                                    */}
      {/* ------------------------------------------------------------------ */}
      {canManage ? (
        <section className="flex flex-col gap-4" aria-labelledby="project-settings-heading">
          <h2 id="project-settings-heading" className="text-sm font-medium text-foreground">
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

              {/* HeroUI v3: `defaultValue` belongs on TextField, `name` on the control. */}
              <TextField
                isRequired
                maxLength={80}
                autoComplete="off"
                defaultValue={ctx.project.name}
                fullWidth
                className="max-w-md"
              >
                <Label>Name</Label>
                <Input name="name" />
                <Description>
                  The key {ctx.project.key} is part of every link and cannot be changed.
                </Description>
              </TextField>

              <TextField
                maxLength={2000}
                defaultValue={ctx.project.description ?? ''}
                fullWidth
              >
                <Label>Description</Label>
                <Textarea name="description" rows={4} />
                <Description>Optional.</Description>
              </TextField>

              <div className="flex flex-wrap items-center gap-2">
                <SubmitButton variant="secondary">Save project</SubmitButton>
              </div>
            </ActionForm>
          </Card>

          <Card className="gap-0 border border-danger/25 p-0">
            <Disclosure>
              <Disclosure.Heading level={3}>
                <Disclosure.Trigger className="flex w-full items-center justify-between gap-3 rounded-2xl px-6 py-4 text-sm font-medium text-danger">
                  Delete this project
                  <Disclosure.Indicator />
                </Disclosure.Trigger>
              </Disclosure.Heading>
              <Disclosure.Content>
                <div className="flex flex-col gap-4 px-6 pb-6">
                  <p className="max-w-prose text-sm text-muted">
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
                    <TextField
                      isRequired
                      maxLength={50}
                      autoComplete="off"
                      fullWidth
                      className="max-w-xs"
                    >
                      <Label>Type {ctx.project.key} to confirm</Label>
                      <Input name="confirmKey" spellCheck={false} />
                    </TextField>
                    <div className="flex flex-wrap items-center gap-2">
                      <SubmitButton variant="danger" pendingLabel="Deleting...">
                        Delete project
                      </SubmitButton>
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
