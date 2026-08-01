import Link from 'next/link';
import { Role } from '@prisma/client';
import { prisma } from '@/lib/db';
import {
  atLeast,
  boardPath,
  loadPage,
  orgPath,
  orgSettingsPath,
  requireProjectByKey,
} from '@/lib/authz';
import {
  Badge,
  Card,
  EmptyState,
  Field,
  Input,
  Prose,
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
    <>
      <nav className="breadcrumb" aria-label="Breadcrumb">
        <Link href="/">Organizations</Link>
        <span className="sep">/</span>
        <Link href={orgPath(ctx.org)}>{ctx.org.name}</Link>
        <span className="sep">/</span>
        <span aria-current="page">{ctx.project.key}</span>
      </nav>

      <div className="page-head">
        <div className="stack-sm">
          <div className="row">
            <Badge>{ctx.project.key}</Badge>
            <h1>{ctx.project.name}</h1>
          </div>
          {ctx.project.description ? (
            <Prose className="muted">{ctx.project.description}</Prose>
          ) : null}
        </div>
        <div className="row">
          <Link className="tab" href={orgPath(ctx.org)}>
            Projects
          </Link>
          <Link className="tab" href={orgSettingsPath(ctx.org)}>
            Members
          </Link>
        </div>
      </div>

      <div className="stack">
        {/* ---------------------------------------------------------------- */}
        {/* Boards                                                            */}
        {/* ---------------------------------------------------------------- */}
        <section className="stack" aria-labelledby="boards-heading">
          <h2 id="boards-heading">Boards</h2>

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
            <div className="grid">
              {boards.map((board) => (
                <Card key={board.id} className="stack-sm">
                  <Link href={boardPath(ctx.org, ctx.project, board)} className="stack-sm">
                    <h3>{board.name}</h3>
                    <p className="faint">
                      {board._count.tickets}{' '}
                      {board._count.tickets === 1 ? 'ticket' : 'tickets'}
                    </p>
                  </Link>

                  {canManage ? (
                    <details>
                      <summary>Manage</summary>
                      <div className="stack">
                        <ActionForm
                          action={renameBoard}
                          className="stack"
                          aria-label={`Rename ${board.name}`}
                        >
                          <input type="hidden" name="boardId" value={board.id} />
                          <Field htmlFor={`board-name-${board.id}`} label="Board name">
                            <Input
                              id={`board-name-${board.id}`}
                              name="name"
                              required
                              maxLength={80}
                              defaultValue={board.name}
                              autoComplete="off"
                            />
                          </Field>
                          <div className="row">
                            <SubmitButton variant="secondary" size="sm">
                              Rename
                            </SubmitButton>
                          </div>
                        </ActionForm>

                        <ActionForm
                          action={deleteBoard}
                          className="stack-sm"
                          aria-label={`Delete ${board.name}`}
                        >
                          <input type="hidden" name="boardId" value={board.id} />
                          <p className="faint">
                            Deleting a board removes its tickets and comments permanently.
                          </p>
                          <div className="row">
                            <SubmitButton variant="danger" size="sm" pendingLabel="Deleting...">
                              Delete board
                            </SubmitButton>
                          </div>
                        </ActionForm>
                      </div>
                    </details>
                  ) : null}
                </Card>
              ))}
            </div>
          )}

          {canManage ? (
            <details className="card" open={empty}>
              <summary>New board</summary>
              <ActionForm action={createBoard} className="stack" aria-label="New board">
                <input type="hidden" name="orgSlug" value={ctx.org.slug} />
                <input type="hidden" name="projectKey" value={ctx.project.key} />
                <Field htmlFor="board-name" label="Name">
                  <Input
                    id="board-name"
                    name="name"
                    required
                    maxLength={80}
                    autoFocus={empty}
                    placeholder="Sprint 1"
                    autoComplete="off"
                  />
                </Field>
                <div className="row">
                  <SubmitButton pendingLabel="Creating...">Create board</SubmitButton>
                </div>
              </ActionForm>
            </details>
          ) : null}
        </section>

        {/* ---------------------------------------------------------------- */}
        {/* Project settings                                                  */}
        {/* ---------------------------------------------------------------- */}
        {canManage ? (
          <section className="stack" aria-labelledby="project-settings-heading">
            <h2 id="project-settings-heading">Project settings</h2>

            <Card className="stack">
              <ActionForm action={updateProject} className="stack" aria-label="Update project">
                <input type="hidden" name="orgSlug" value={ctx.org.slug} />
                <input type="hidden" name="projectKey" value={ctx.project.key} />

                <Field
                  htmlFor="project-name"
                  label="Name"
                  hint={`The key ${ctx.project.key} is part of every link and cannot be changed.`}
                >
                  <Input
                    id="project-name"
                    name="name"
                    required
                    maxLength={80}
                    defaultValue={ctx.project.name}
                    autoComplete="off"
                  />
                </Field>

                <Field htmlFor="project-description" label="Description" hint="Optional.">
                  <Textarea
                    id="project-description"
                    name="description"
                    maxLength={2000}
                    defaultValue={ctx.project.description ?? ''}
                  />
                </Field>

                <div className="row">
                  <SubmitButton variant="secondary">Save project</SubmitButton>
                </div>
              </ActionForm>
            </Card>

            <Card className="stack danger-zone">
              <h3>Delete this project</h3>
              <p className="muted">
                Every board, ticket and comment in {ctx.project.key} is deleted permanently.
                This cannot be undone.
              </p>
              <ActionForm action={deleteProject} className="stack" aria-label="Delete project">
                <input type="hidden" name="orgSlug" value={ctx.org.slug} />
                <input type="hidden" name="projectKey" value={ctx.project.key} />
                <Field htmlFor="confirm-key" label={`Type ${ctx.project.key} to confirm`}>
                  <Input
                    id="confirm-key"
                    name="confirmKey"
                    required
                    maxLength={50}
                    autoComplete="off"
                    spellCheck={false}
                  />
                </Field>
                <div className="row">
                  <SubmitButton variant="danger" pendingLabel="Deleting...">
                    Delete project
                  </SubmitButton>
                </div>
              </ActionForm>
            </Card>
          </section>
        ) : null}
      </div>
    </>
  );
}
