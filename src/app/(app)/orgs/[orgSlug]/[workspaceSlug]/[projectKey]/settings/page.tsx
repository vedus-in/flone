import { Role, WorkflowStateType } from '@prisma/client';
import { notFound } from 'next/navigation';

import { StateIcon } from '@/components/issue-row';
import { Card, Field, Input, Separator, SubmitButton, Textarea } from '@/components/ui';
import { atLeast, loadPage, requireProjectByKey } from '@/lib/authz';
import { prisma } from '@/lib/db';
import { COLOR_TOKENS, colorClass } from '@/lib/model';
import { listStates } from '@/lib/states';
import { cx } from '@/lib/utils/cx';

import { ActionForm } from '../../../../../action-form';
import {
  createLabel,
  createState,
  deleteLabel,
  deleteProject,
  deleteState,
  moveState,
  updateCycleConfig,
  updateLabel,
  updateProject,
  updateState,
} from '../actions';

/**
 * Project settings: the workflow, the labels, the cycle cadence, and the door
 * marked danger.
 *
 * ADMIN+ only. A MEMBER who reaches this URL gets a 404 rather than a 403 --
 * the same posture as every other authorization failure in the app, so nothing
 * here confirms what it is guarding.
 */

type Params = { orgSlug: string; workspaceSlug: string; projectKey: string };

const STATE_TYPES: Array<{ value: WorkflowStateType; label: string; hint: string }> = [
  { value: WorkflowStateType.BACKLOG, label: 'Backlog', hint: 'Not planned yet' },
  { value: WorkflowStateType.UNSTARTED, label: 'Unstarted', hint: 'Planned, not begun' },
  { value: WorkflowStateType.STARTED, label: 'Started', hint: 'In flight' },
  { value: WorkflowStateType.COMPLETED, label: 'Completed', hint: 'Counts as done' },
  { value: WorkflowStateType.CANCELED, label: 'Canceled', hint: 'Left the scope' },
];

const WEEKDAYS = [
  { value: 1, label: 'Monday' },
  { value: 2, label: 'Tuesday' },
  { value: 3, label: 'Wednesday' },
  { value: 4, label: 'Thursday' },
  { value: 5, label: 'Friday' },
  { value: 6, label: 'Saturday' },
  { value: 7, label: 'Sunday' },
];

const SELECT =
  'h-8 rounded-lg border border-secondary bg-primary px-2 text-[0.8125rem] text-primary focus:outline-2 focus:outline-offset-1 focus:outline-focus-ring';
const TEXT =
  'h-8 rounded-lg border border-secondary bg-primary px-2.5 text-[0.8125rem] text-primary placeholder:text-tertiary focus:outline-2 focus:outline-offset-1 focus:outline-focus-ring';

/** One nudge along the board order. A no-op at the edges, so it is disabled there. */
function MoveButton({
  projectId,
  stateId,
  direction,
  disabled,
  name,
}: {
  projectId: string;
  stateId: string;
  direction: 'up' | 'down';
  disabled: boolean;
  name: string;
}) {
  return (
    <ActionForm action={moveState} aria-label={`Move ${name} ${direction}`}>
      <input type="hidden" name="projectId" value={projectId} />
      <input type="hidden" name="stateId" value={stateId} />
      <input type="hidden" name="direction" value={direction} />
      <button
        type="submit"
        disabled={disabled}
        aria-label={`Move ${name} ${direction}`}
        className="grid size-4 place-items-center rounded text-tertiary transition-colors hover:text-primary disabled:opacity-25"
      >
        <svg viewBox="0 0 16 16" fill="none" aria-hidden="true" className="size-3">
          <path
            d={direction === 'up' ? 'm4 10 4-4 4 4' : 'm4 6 4 4 4-4'}
            stroke="currentColor"
            strokeWidth="1.75"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </button>
    </ActionForm>
  );
}

function ColorSelect({ name, defaultValue }: { name: string; defaultValue: string }) {
  return (
    <select name={name} defaultValue={defaultValue} aria-label="Colour" className={SELECT}>
      {COLOR_TOKENS.map((token) => (
        <option key={token} value={token}>
          {token}
        </option>
      ))}
    </select>
  );
}

export default async function ProjectSettingsPage({ params }: { params: Promise<Params> }) {
  const { orgSlug, workspaceSlug, projectKey } = await params;
  const ctx = await loadPage(() => requireProjectByKey(orgSlug, workspaceSlug, projectKey.toUpperCase()));

  // A 404, not a 403: the same shape every other refusal in this app takes.
  if (!atLeast(ctx.role, Role.ADMIN)) notFound();

  const [states, labels, cadence, counts] = await Promise.all([
    listStates(ctx.project.id),
    prisma.label.findMany({
      where: { projectId: ctx.project.id },
      orderBy: [{ name: 'asc' }, { id: 'asc' }],
      select: { id: true, name: true, color: true, _count: { select: { tickets: true } } },
    }),
    prisma.project.findUnique({
      where: { id: ctx.project.id },
      select: {
        cyclesEnabled: true,
        cycleWeeks: true,
        cycleStartDay: true,
        upcomingCycles: true,
      },
    }),
    prisma.ticket.groupBy({
      by: ['stateId'],
      where: { projectId: ctx.project.id },
      _count: { _all: true },
    }),
  ]);

  if (!cadence) notFound();
  const heldByState = new Map(counts.map((row) => [row.stateId, row._count._all] as const));

  return (
    <div className="flex flex-col gap-8">
      <h1 className="text-lg font-semibold text-primary">Project settings</h1>

      {/* ------------------------------------------------------------------ */}
      <section className="flex flex-col gap-3" aria-labelledby="general-heading">
        <h2 id="general-heading" className="text-sm font-medium text-primary">
          General
        </h2>
        <Card className="gap-4 p-5">
          <ActionForm action={updateProject} className="flex flex-col gap-4" aria-label="Update project">
            <input type="hidden" name="orgSlug" value={ctx.org.slug} />
            <input type="hidden" name="projectKey" value={ctx.project.key} />

            <Field
              htmlFor="project-name"
              label="Name"
              hint={`The key ${ctx.project.key} is part of every link and every issue id, and cannot be changed.`}
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
                rows={3}
                maxLength={2000}
                defaultValue={ctx.project.description ?? ''}
              />
            </Field>

            <div className="flex">
              <SubmitButton color="secondary">Save</SubmitButton>
            </div>
          </ActionForm>
        </Card>
      </section>

      {/* ------------------------------------------------------------------ */}
      <section className="flex flex-col gap-3" aria-labelledby="states-heading">
        <div className="flex flex-col gap-1">
          <h2 id="states-heading" className="text-sm font-medium text-primary">
            Workflow states
          </h2>
          <p className="max-w-prose text-xs text-tertiary">
            The <strong>type</strong> is what the app reasons about, not the name: it decides which
            tab an issue falls under, whether it counts as done for cycle and sub-issue progress,
            and whether moving into it stamps a start or completion time. Rename freely; change the
            type deliberately.
          </p>
        </div>

        <Card className="gap-3 p-5">
          <p className="text-xs text-tertiary">
            The order here is the BOARD order, left to right. The issues list groups by type
            instead, leading with whatever is in flight.
          </p>

          <ul className="flex flex-col gap-2">
            {states.map((state, index) => {
              const held = heldByState.get(state.id) ?? 0;
              return (
                <li key={state.id} className="flex flex-col gap-2 border-b border-secondary pb-2 last:border-b-0">
                  <div className="flex flex-wrap items-center gap-2">
                    {/* Two buttons rather than drag-and-drop: half a dozen rows
                        reordered once, and this works on a phone, from the
                        keyboard, and before hydration. */}
                    <div className="flex flex-col">
                      <MoveButton
                        projectId={ctx.project.id}
                        stateId={state.id}
                        direction="up"
                        disabled={index === 0}
                        name={state.name}
                      />
                      <MoveButton
                        projectId={ctx.project.id}
                        stateId={state.id}
                        direction="down"
                        disabled={index === states.length - 1}
                        name={state.name}
                      />
                    </div>

                  <ActionForm
                    action={updateState}
                    className="flex flex-wrap items-center gap-2"
                    aria-label={`Update ${state.name}`}
                  >
                    <input type="hidden" name="projectId" value={ctx.project.id} />
                    <input type="hidden" name="stateId" value={state.id} />
                    <StateIcon type={state.type} color={state.color} />
                    <input
                      name="name"
                      required
                      maxLength={40}
                      defaultValue={state.name}
                      aria-label="State name"
                      className={cx(TEXT, 'w-40')}
                    />
                    <select name="type" defaultValue={state.type} aria-label="Type" className={SELECT}>
                      {STATE_TYPES.map((option) => (
                        <option key={option.value} value={option.value}>
                          {option.label} — {option.hint}
                        </option>
                      ))}
                    </select>
                    <ColorSelect name="color" defaultValue={state.color} />
                    <span className="text-[0.6875rem] text-tertiary tabular-nums">
                      {held} {held === 1 ? 'issue' : 'issues'}
                    </span>
                    <button
                      type="submit"
                      className="h-8 rounded-lg border border-secondary px-2.5 text-[0.8125rem] text-primary transition-colors hover:bg-secondary"
                    >
                      Save
                    </button>
                  </ActionForm>
                  </div>

                  {states.length > 1 ? (
                    <ActionForm
                      action={deleteState}
                      className="flex flex-wrap items-center gap-2"
                      aria-label={`Delete ${state.name}`}
                    >
                      <input type="hidden" name="projectId" value={ctx.project.id} />
                      <input type="hidden" name="stateId" value={state.id} />
                      {held > 0 ? (
                        <>
                          <span className="text-[0.6875rem] text-tertiary">Move its issues to</span>
                          <select name="reassignToId" aria-label="Move issues to" className={SELECT}>
                            {states
                              .filter((candidate) => candidate.id !== state.id)
                              .map((candidate) => (
                                <option key={candidate.id} value={candidate.id}>
                                  {candidate.name}
                                </option>
                              ))}
                          </select>
                        </>
                      ) : null}
                      <button
                        type="submit"
                        className="h-7 rounded-lg px-2 text-[0.6875rem] text-tertiary transition-colors hover:text-error-primary"
                      >
                        Delete state
                      </button>
                    </ActionForm>
                  ) : null}
                </li>
              );
            })}
          </ul>

          <Separator />

          <ActionForm
            action={createState}
            className="flex flex-wrap items-center gap-2"
            aria-label="Add a state"
            resetOnSuccess
          >
            <input type="hidden" name="projectId" value={ctx.project.id} />
            <input
              name="name"
              required
              maxLength={40}
              placeholder="New state"
              aria-label="State name"
              className={cx(TEXT, 'w-40')}
            />
            <select name="type" defaultValue={WorkflowStateType.STARTED} aria-label="Type" className={SELECT}>
              {STATE_TYPES.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label} — {option.hint}
                </option>
              ))}
            </select>
            <ColorSelect name="color" defaultValue="gray" />
            <button
              type="submit"
              className="h-8 rounded-lg bg-brand-solid px-2.5 text-[0.8125rem] font-medium text-white transition-opacity hover:opacity-90"
            >
              Add
            </button>
          </ActionForm>
        </Card>
      </section>

      {/* ------------------------------------------------------------------ */}
      <section className="flex flex-col gap-3" aria-labelledby="labels-heading">
        <h2 id="labels-heading" className="text-sm font-medium text-primary">
          Labels
        </h2>
        <Card className="gap-3 p-5">
          {labels.length === 0 ? (
            <p className="text-sm text-tertiary">No labels yet.</p>
          ) : (
            <ul className="flex flex-col gap-2">
              {labels.map((label) => (
                <li key={label.id} className="flex flex-wrap items-center gap-2">
                  <ActionForm
                    action={updateLabel}
                    className="flex flex-wrap items-center gap-2"
                    aria-label={`Update ${label.name}`}
                  >
                    <input type="hidden" name="projectId" value={ctx.project.id} />
                    <input type="hidden" name="labelId" value={label.id} />
                    <span
                      aria-hidden="true"
                      className={cx('size-2.5 rounded-full', colorClass(label.color).dot)}
                    />
                    <input
                      name="name"
                      required
                      maxLength={40}
                      defaultValue={label.name}
                      aria-label="Label name"
                      className={cx(TEXT, 'w-40')}
                    />
                    <ColorSelect name="color" defaultValue={label.color} />
                    <span className="text-[0.6875rem] text-tertiary tabular-nums">
                      {label._count.tickets}
                    </span>
                    <button
                      type="submit"
                      className="h-8 rounded-lg border border-secondary px-2.5 text-[0.8125rem] text-primary transition-colors hover:bg-secondary"
                    >
                      Save
                    </button>
                  </ActionForm>

                  <ActionForm action={deleteLabel} aria-label={`Delete ${label.name}`}>
                    <input type="hidden" name="projectId" value={ctx.project.id} />
                    <input type="hidden" name="labelId" value={label.id} />
                    <button
                      type="submit"
                      className="h-7 rounded-lg px-2 text-[0.6875rem] text-tertiary transition-colors hover:text-error-primary"
                    >
                      Delete
                    </button>
                  </ActionForm>
                </li>
              ))}
            </ul>
          )}

          <Separator />

          <ActionForm
            action={createLabel}
            className="flex flex-wrap items-center gap-2"
            aria-label="Add a label"
            resetOnSuccess
          >
            <input type="hidden" name="projectId" value={ctx.project.id} />
            <input
              name="name"
              required
              maxLength={40}
              placeholder="New label"
              aria-label="Label name"
              className={cx(TEXT, 'w-40')}
            />
            <ColorSelect name="color" defaultValue="gray" />
            <button
              type="submit"
              className="h-8 rounded-lg bg-brand-solid px-2.5 text-[0.8125rem] font-medium text-white transition-opacity hover:opacity-90"
            >
              Add
            </button>
          </ActionForm>
        </Card>
      </section>

      {/* ------------------------------------------------------------------ */}
      <section className="flex flex-col gap-3" aria-labelledby="cycles-heading">
        <div className="flex flex-col gap-1">
          <h2 id="cycles-heading" className="text-sm font-medium text-primary">
            Cycles
          </h2>
          <p className="max-w-prose text-xs text-tertiary">
            Cycles are generated from this cadence when somebody opens the cycles pages — there is no
            scheduler to configure. Changing the cadence leaves existing cycles alone, so a finished
            sprint&rsquo;s dates stay a historical fact.
          </p>
        </div>

        <Card className="gap-4 p-5">
          <ActionForm action={updateCycleConfig} className="flex flex-col gap-4" aria-label="Cycle settings">
            <input type="hidden" name="projectId" value={ctx.project.id} />

            <label className="flex w-fit cursor-pointer items-center gap-2 text-[0.8125rem] text-primary">
              <input
                type="checkbox"
                name="cyclesEnabled"
                defaultChecked={cadence.cyclesEnabled}
                className="size-4 accent-brand-600"
              />
              Use cycles in this project
            </label>

            <div className="flex flex-wrap items-end gap-4">
              <label className="flex flex-col gap-1.5 text-xs text-tertiary">
                Length
                <select name="cycleWeeks" defaultValue={cadence.cycleWeeks} className={SELECT}>
                  {[1, 2, 3, 4, 6, 8].map((weeks) => (
                    <option key={weeks} value={weeks}>
                      {weeks} {weeks === 1 ? 'week' : 'weeks'}
                    </option>
                  ))}
                </select>
              </label>

              <label className="flex flex-col gap-1.5 text-xs text-tertiary">
                Starts on
                <select name="cycleStartDay" defaultValue={cadence.cycleStartDay} className={SELECT}>
                  {WEEKDAYS.map((day) => (
                    <option key={day.value} value={day.value}>
                      {day.label}
                    </option>
                  ))}
                </select>
              </label>

              <label className="flex flex-col gap-1.5 text-xs text-tertiary">
                Upcoming cycles kept
                <select name="upcomingCycles" defaultValue={cadence.upcomingCycles} className={SELECT}>
                  {[1, 2, 3, 4, 6, 8, 12].map((count) => (
                    <option key={count} value={count}>
                      {count}
                    </option>
                  ))}
                </select>
              </label>

              <SubmitButton color="secondary">Save cycles</SubmitButton>
            </div>
          </ActionForm>
        </Card>
      </section>

      {/* ------------------------------------------------------------------ */}
      <section className="flex flex-col gap-3" aria-labelledby="danger-heading">
        <h2 id="danger-heading" className="text-sm font-medium text-error-primary">
          Danger zone
        </h2>
        <Card className="gap-0 p-0 ring-error_subtle">
          <details className="group">
            <summary className="flex cursor-pointer list-none items-center justify-between gap-3 rounded-xl px-5 py-4 text-sm font-medium text-error-primary">
              Delete this project
            </summary>
            <div className="flex flex-col gap-4 px-5 pb-5">
              <p className="max-w-prose text-sm text-tertiary">
                Every board, workflow state, cycle, label, issue and comment in {ctx.project.key} is
                deleted permanently. This cannot be undone.
              </p>
              <ActionForm action={deleteProject} className="flex flex-col gap-3" aria-label="Delete project">
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
                <div className="flex">
                  <SubmitButton color="primary-destructive" pendingLabel="Deleting...">
                    Delete project
                  </SubmitButton>
                </div>
              </ActionForm>
            </div>
          </details>
        </Card>
      </section>
    </div>
  );
}
