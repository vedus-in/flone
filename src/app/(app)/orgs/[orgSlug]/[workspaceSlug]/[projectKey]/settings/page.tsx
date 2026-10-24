import { ProjectAccess, Role, WorkflowStateType } from '@prisma/client';
import { notFound } from 'next/navigation';
import type { ReactNode } from 'react';
import { Trash01 } from '@untitledui/icons';

import { projectCrumb } from '@/components/crumbs';
import { PageBar, PageBody } from '@/components/page-bar';
import { Assignee, StateIcon } from '@/components/issue-row';
import { Badge, Card, Field, Input, SubmitButton, Textarea } from '@/components/ui';
import { SettingsNav, type SettingsNavItem } from '@/components/settings-nav';
import {
  ColorSwatches,
  DangerZone,
  InfoNote,
  MENU_DANGER_CLASS,
  MenuNote,
  NEW_ROW_CLASS,
  RowMenu,
  SettingsRow,
  SettingsSelect,
  Switch,
  initials,
} from '@/components/settings-ui';
import { atLeast, loadPage, requireProjectByKey } from '@/lib/authz';
import { prisma } from '@/lib/db';
import { colorClass } from '@/lib/model';
import { listStates } from '@/lib/states';
import { cx } from '@/lib/utils/cx';

import { ActionForm } from '../../../../../action-form';
import {
  addProjectMember,
  createLabel,
  createState,
  deleteLabel,
  deleteProject,
  deleteState,
  moveState,
  removeProjectMember,
  setProjectAccess,
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
 *
 * Six sections down one column, so the page carries its own side-nav and every
 * section is an anchor. Everything that can be edited saves on change; the two
 * things that cannot be undone (deleting a state, deleting the project) still
 * take a deliberate press.
 */

type Params = { orgSlug: string; workspaceSlug: string; projectKey: string };

/**
 * The label only. The hint each of these used to carry ("Completed -- counts as
 * done") made the longest option 270px wide inside a 208px select, so three of
 * the five truncated mid-word -- the control explaining what a type means was
 * the one you could not read. The sentence under the card heading says the same
 * thing with room to say it, so the hints moved there and the select shrank to
 * fit its widest real option.
 */
const STATE_TYPES: Array<{ value: WorkflowStateType; label: string }> = [
  { value: WorkflowStateType.BACKLOG, label: 'Backlog' },
  { value: WorkflowStateType.UNSTARTED, label: 'Unstarted' },
  { value: WorkflowStateType.STARTED, label: 'Started' },
  { value: WorkflowStateType.COMPLETED, label: 'Completed' },
  { value: WorkflowStateType.CANCELED, label: 'Canceled' },
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

const NAV: SettingsNavItem[] = [
  { id: 'general', label: 'General' },
  { id: 'access', label: 'Access' },
  { id: 'workflow', label: 'Workflow' },
  { id: 'labels', label: 'Labels' },
  { id: 'cycles', label: 'Cycles' },
  { id: 'danger', label: 'Danger zone', tone: 'danger' },
];

/** The compact text input the editable rows use. */
const ROW_INPUT =
  'h-9 min-w-0 rounded-lg border border-secondary bg-primary px-3 text-sm text-primary shadow-xs outline-focus-ring placeholder:text-tertiary focus-visible:outline-2 focus-visible:outline-offset-1';

/** The small square icon button the rows use for destructive actions. */
const ICON_BUTTON =
  'grid size-8 shrink-0 place-items-center rounded-lg text-tertiary transition-colors outline-focus-ring hover:bg-error-primary hover:text-error-primary focus-visible:outline-2 focus-visible:outline-offset-1 disabled:opacity-25 disabled:hover:bg-transparent disabled:hover:text-tertiary';

/**
 * One nudge along the board order. A no-op at the edges, so it is disabled
 * there.
 *
 * Still two arrows rather than the drag handle the design draws: half a dozen
 * rows are reordered once, and this works on a phone, from the keyboard, and
 * before hydration. Stacked tight in the row's leading slot, they read as the
 * grip they replace.
 */
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
    <ActionForm action={moveState} className="flex" aria-label={`Move ${name} ${direction}`}>
      <input type="hidden" name="projectId" value={projectId} />
      <input type="hidden" name="stateId" value={stateId} />
      <input type="hidden" name="direction" value={direction} />
      <button
        type="submit"
        disabled={disabled}
        aria-label={`Move ${name} ${direction}`}
        className="grid h-3.5 w-4 place-items-center rounded text-quaternary transition-colors outline-focus-ring hover:text-primary focus-visible:outline-2 focus-visible:outline-offset-1 disabled:opacity-25 disabled:hover:text-quaternary"
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

function Section({
  id,
  labelledBy,
  children,
}: {
  id: string;
  labelledBy: string;
  children: ReactNode;
}) {
  return (
    <section id={id} aria-labelledby={labelledBy} className="scroll-mt-20">
      {children}
    </section>
  );
}

export default async function ProjectSettingsPage({ params }: { params: Promise<Params> }) {
  const { orgSlug, workspaceSlug, projectKey } = await params;
  const ctx = await loadPage(() =>
    requireProjectByKey(orgSlug, workspaceSlug, projectKey.toUpperCase()),
  );

  // A 404, not a 403: the same shape every other refusal in this app takes.
  if (!atLeast(ctx.role, Role.ADMIN)) notFound();

  const [states, labels, cadence, counts, orgMembers] = await Promise.all([
    listStates(ctx.project.id),
    prisma.label.findMany({
      where: { projectId: ctx.project.id },
      orderBy: [{ name: 'asc' }, { id: 'asc' }],
      select: { id: true, name: true, color: true, _count: { select: { tickets: true } } },
    }),
    prisma.project.findUnique({
      where: { id: ctx.project.id },
      select: {
        access: true,
        cyclesEnabled: true,
        cycleWeeks: true,
        cycleStartDay: true,
        upcomingCycles: true,
        members: { select: { userId: true } },
      },
    }),
    prisma.ticket.groupBy({
      by: ['stateId'],
      where: { projectId: ctx.project.id },
      _count: { _all: true },
    }),
    // The pool the access list picks from. Project membership is a narrowing of
    // organization membership, so there is nobody else to offer.
    prisma.membership.findMany({
      where: { organizationId: ctx.org.id },
      orderBy: [{ user: { name: 'asc' } }, { id: 'asc' }],
      select: { role: true, user: { select: { id: true, name: true, email: true } } },
    }),
  ]);

  if (!cadence) notFound();
  const heldByState = new Map(counts.map((row) => [row.stateId, row._count._all] as const));

  const isPrivate = cadence.access === ProjectAccess.PRIVATE;
  const onProject = new Set(cadence.members.map((row) => row.userId));
  // Owners are listed as already having access even without a row, because they
  // do -- the predicate in `@/lib/authz` lets an owner see every project in the
  // organization. Offering an Add button for them would be a button that
  // changes nothing anyone can observe.
  const named = orgMembers.filter(
    (member) => onProject.has(member.user.id) || member.role === Role.OWNER,
  );
  const addable = orgMembers.filter(
    (member) => !onProject.has(member.user.id) && member.role !== Role.OWNER,
  );

  return (
    <>
      <PageBar crumbs={[projectCrumb(ctx.org, ctx.project), { label: 'Settings' }]} />
      <PageBody width="wide" className="flex flex-col gap-6">
        <header className="flex flex-col gap-1">
          <h2 className="text-xl font-semibold text-primary">Project settings</h2>
          <p className="flex flex-wrap items-center gap-2 text-sm text-tertiary">
            {ctx.project.name} &middot; key
            <Badge tone="neutral">{ctx.project.key}</Badge>
          </p>
        </header>

        <div className="grid gap-6 lg:grid-cols-[9rem_minmax(0,1fr)] lg:gap-8">
          <SettingsNav items={NAV} label="Project settings sections" />

          <div className="flex min-w-0 flex-col gap-6">
            {/* -------------------------------------------------------------- */}
            <Section id="general" labelledBy="general-heading">
              <Card>
                <Card.Title id="general-heading">General</Card.Title>

                <ActionForm
                  action={updateProject}
                  autosave
                  saveHint="Changes save automatically"
                  className="flex flex-col gap-4"
                  aria-label="Update project"
                >
                  <input type="hidden" name="orgSlug" value={ctx.org.slug} />
                  <input type="hidden" name="projectKey" value={ctx.project.key} />

                  <Field
                    htmlFor="project-name"
                    label="Project name"
                    hint={`The key ${ctx.project.key} lives in every link and issue id and cannot change -- the name can.`}
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

                  <Field
                    htmlFor="project-description"
                    label={
                      <>
                        Description <span className="text-tertiary">(optional)</span>
                      </>
                    }
                  >
                    <Textarea
                      id="project-description"
                      name="description"
                      rows={3}
                      maxLength={2000}
                      placeholder="What is this project for?"
                      defaultValue={ctx.project.description ?? ''}
                    />
                  </Field>
                </ActionForm>
              </Card>
            </Section>

            {/* -------------------------------------------------------------- */}
            <Section id="access" labelledBy="access-heading">
              <Card>
                <Card.Header>
                  <Card.Title id="access-heading">Access</Card.Title>
                  <Card.Description>
                    Visibility decides who can <em>see</em> the project. What people can do here is
                    still set by their organization role.
                  </Card.Description>
                </Card.Header>

                <ActionForm
                  action={setProjectAccess}
                  autosave
                  className="flex flex-col"
                  aria-label="Project access"
                >
                  <input type="hidden" name="orgSlug" value={ctx.org.slug} />
                  <input type="hidden" name="projectKey" value={ctx.project.key} />

                  <div className="flex items-center justify-between gap-4 rounded-lg border border-secondary bg-secondary_subtle px-4 py-3">
                    <div className="flex min-w-0 flex-col gap-0.5">
                      {/*
                        * Reads the flag, like the hint under it. Hardcoded, this
                        * line said "open to everyone" over a hint reading "only the
                        * people below" with the switch plainly off -- the heading
                        * contradicting both the sentence beneath it and the control
                        * beside it.
                        */}
                      <span className="text-sm font-semibold text-primary">
                        {isPrivate
                          ? `${ctx.project.key} is private`
                          : `${ctx.project.key} is open to everyone in ${ctx.org.name}`}
                      </span>
                      <span id="access-hint" className="text-xs text-tertiary">
                        {isPrivate
                          ? 'Only the people below can find and view it.'
                          : 'Anyone in the organization can find and view it.'}
                      </span>
                    </div>
                    {/*
                      * The switch submits the enum itself, and the hidden input
                      * carries the other value. Order matters: `FormData.get`
                      * returns the FIRST entry, so an unchecked box falls through
                      * to PRIVATE without the action needing to know a checkbox
                      * was involved.
                      */}
                    <Switch
                      name="access"
                      value={ProjectAccess.OPEN}
                      defaultChecked={!isPrivate}
                      aria-label={`Open ${ctx.project.key} to everyone in ${ctx.org.name}`}
                      aria-describedby="access-hint"
                    />
                    <input type="hidden" name="access" value={ProjectAccess.PRIVATE} />
                  </div>
                </ActionForm>

                <div className="flex flex-col gap-2">
                  <h3 className="text-sm font-medium text-primary">Members</h3>

                  {named.map((member) => (
                    <SettingsRow key={member.user.id} className="justify-between">
                      <div className="flex min-w-0 items-center gap-3">
                        <Assignee name={member.user.name} size="md" />
                        <div className="flex min-w-0 flex-col">
                          <span className="truncate text-sm text-primary">{member.user.name}</span>
                          <span className="truncate text-xs text-tertiary">{member.user.email}</span>
                        </div>
                      </div>

                      {member.role === Role.OWNER && !onProject.has(member.user.id) ? (
                        <Badge tone="accent">Owner</Badge>
                      ) : (
                        <ActionForm
                          action={removeProjectMember}
                          className="flex"
                          aria-label={`Remove ${member.user.name} from this project`}
                        >
                          <input type="hidden" name="orgSlug" value={ctx.org.slug} />
                          <input type="hidden" name="projectKey" value={ctx.project.key} />
                          <input type="hidden" name="userId" value={member.user.id} />
                          <SubmitButton color="secondary" size="sm" pendingLabel="Removing...">
                            Remove
                          </SubmitButton>
                        </ActionForm>
                      )}
                    </SettingsRow>
                  ))}

                  {addable.length > 0 ? (
                    <ActionForm
                      action={addProjectMember}
                      className={NEW_ROW_CLASS}
                      aria-label="Add someone to this project"
                    >
                      <input type="hidden" name="orgSlug" value={ctx.org.slug} />
                      <input type="hidden" name="projectKey" value={ctx.project.key} />
                      <SettingsSelect name="userId" aria-label="Person" className="min-w-0 flex-1">
                        {addable.map((member) => (
                          <option key={member.user.id} value={member.user.id}>
                            {member.user.name} &mdash; {member.user.email}
                          </option>
                        ))}
                      </SettingsSelect>
                      <SubmitButton pendingLabel="Adding...">Add</SubmitButton>
                    </ActionForm>
                  ) : (
                    <InfoNote>
                      Everyone in this organization already has access, so there is no one to add.
                    </InfoNote>
                  )}
                </div>

                {isPrivate ? null : (
                  <Card.Description className="text-xs">
                    The list is kept while the project is open, so making it private again restores
                    exactly these people.
                  </Card.Description>
                )}
              </Card>
            </Section>

            {/* -------------------------------------------------------------- */}
            <Section id="workflow" labelledBy="workflow-heading">
              <Card>
                <Card.Header>
                  <Card.Title id="workflow-heading">Workflow states</Card.Title>
                  <Card.Description>
                    The <strong className="font-semibold text-secondary">type</strong> drives
                    behaviour &mdash; which tab an issue lands on and when it counts as done.{' '}
                    <strong className="font-semibold text-secondary">Backlog</strong> is not planned
                    yet and <strong className="font-semibold text-secondary">Unstarted</strong> is;{' '}
                    <strong className="font-semibold text-secondary">Started</strong> is in flight,{' '}
                    <strong className="font-semibold text-secondary">Completed</strong> counts as
                    done, and <strong className="font-semibold text-secondary">Canceled</strong> has
                    left the scope. Rename freely; use the arrows to set the board order.
                  </Card.Description>
                </Card.Header>

                <div className="flex flex-col gap-2">
                  {states.map((state, index) => {
                    const held = heldByState.get(state.id) ?? 0;
                    return (
                      <SettingsRow key={state.id}>
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
                          autosave
                          className="flex min-w-0 flex-1 flex-wrap items-center gap-2"
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
                            className={cx(ROW_INPUT, 'w-40 flex-1')}
                          />
                          <SettingsSelect
                            name="type"
                            defaultValue={state.type}
                            aria-label="Type"
                            className="w-36"
                          >
                            {STATE_TYPES.map((option) => (
                              <option key={option.value} value={option.value}>
                                {option.label}
                              </option>
                            ))}
                          </SettingsSelect>
                          <ColorSwatches name="color" defaultValue={state.color} />
                          <span className="w-16 shrink-0 text-end text-xs text-tertiary tabular-nums">
                            {held > 0 ? `${held} ${held === 1 ? 'issue' : 'issues'}` : null}
                          </span>
                        </ActionForm>

                        {/*
                          * In the menu rather than inline, because a state that
                          * holds issues cannot simply vanish and the picker that
                          * asks where they go is 144px wide -- inline, it appeared
                          * on some rows and not others, and the row's flex layout
                          * passed the difference straight to the name field, which
                          * halved to 80px and truncated "In Progress" to "In Progr"
                          * on exactly the rows that had any work in them. The menu
                          * makes every row's trailing control the same 32px, and a
                          * destructive action that needs a decision first is what
                          * `RowMenu` is for. Deliberately NOT an autosaving form.
                          *
                          * Labels keep their one-click bin: deleting one only
                          * untags issues, so there is nothing to ask and nothing to
                          * orphan.
                          */}
                        {states.length > 1 ? (
                          <RowMenu label={`More actions for ${state.name}`}>
                            <MenuNote>
                              {held > 0
                                ? `${state.name} holds ${held} ${held === 1 ? 'issue' : 'issues'}. They move to the state you pick; deleting cannot be undone.`
                                : `${state.name} holds no issues. Deleting cannot be undone.`}
                            </MenuNote>
                            <ActionForm
                              action={deleteState}
                              className="flex flex-col gap-2"
                              aria-label={`Delete ${state.name}`}
                            >
                              <input type="hidden" name="projectId" value={ctx.project.id} />
                              <input type="hidden" name="stateId" value={state.id} />
                              {held > 0 ? (
                                <SettingsSelect
                                  name="reassignToId"
                                  aria-label={`Move the issues in ${state.name} to`}
                                  className="w-full"
                                >
                                  {states
                                    .filter((candidate) => candidate.id !== state.id)
                                    .map((candidate) => (
                                      <option key={candidate.id} value={candidate.id}>
                                        Move to {candidate.name}
                                      </option>
                                    ))}
                                </SettingsSelect>
                              ) : null}
                              <button type="submit" className={MENU_DANGER_CLASS}>
                                Delete {state.name}
                              </button>
                            </ActionForm>
                          </RowMenu>
                        ) : (
                          <span className="size-8 shrink-0" aria-hidden="true" />
                        )}
                      </SettingsRow>
                    );
                  })}

                  <ActionForm
                    action={createState}
                    className={NEW_ROW_CLASS}
                    aria-label="Add a state"
                    resetOnSuccess
                  >
                    <input type="hidden" name="projectId" value={ctx.project.id} />
                    <input
                      name="name"
                      required
                      maxLength={40}
                      placeholder="New state name"
                      aria-label="State name"
                      className={cx(ROW_INPUT, 'w-40 flex-1')}
                    />
                    <SettingsSelect
                      name="type"
                      defaultValue={WorkflowStateType.STARTED}
                      aria-label="Type"
                      className="w-36"
                    >
                      {STATE_TYPES.map((option) => (
                        <option key={option.value} value={option.value}>
                          {option.label}
                        </option>
                      ))}
                    </SettingsSelect>
                    <ColorSwatches name="color" defaultValue="gray" />
                    <SubmitButton pendingLabel="Adding...">Add state</SubmitButton>
                  </ActionForm>
                </div>
              </Card>
            </Section>

            {/* -------------------------------------------------------------- */}
            <Section id="labels" labelledBy="labels-heading">
              <Card>
                <Card.Header>
                  <Card.Title id="labels-heading">Labels</Card.Title>
                  <Card.Description>Tag issues across this project.</Card.Description>
                </Card.Header>

                <div className="flex flex-col gap-2">
                  {labels.length === 0 ? (
                    <p className="text-sm text-tertiary italic">
                      No labels yet &mdash; add the first one below.
                    </p>
                  ) : (
                    labels.map((label) => (
                      <SettingsRow key={label.id}>
                        <ActionForm
                          action={updateLabel}
                          autosave
                          className="flex min-w-0 flex-1 flex-wrap items-center gap-2"
                          aria-label={`Update ${label.name}`}
                        >
                          <input type="hidden" name="projectId" value={ctx.project.id} />
                          <input type="hidden" name="labelId" value={label.id} />
                          <span
                            aria-hidden="true"
                            className={cx('size-2.5 shrink-0 rounded-full', colorClass(label.color).dot)}
                          />
                          <input
                            name="name"
                            required
                            maxLength={40}
                            defaultValue={label.name}
                            aria-label="Label name"
                            className={cx(ROW_INPUT, 'w-40 flex-1')}
                          />
                          <ColorSwatches name="color" defaultValue={label.color} />
                          <span className="w-16 shrink-0 text-end text-xs text-tertiary tabular-nums">
                            {label._count.tickets > 0
                              ? `${label._count.tickets} ${label._count.tickets === 1 ? 'issue' : 'issues'}`
                              : null}
                          </span>
                        </ActionForm>

                        <ActionForm
                          action={deleteLabel}
                          className="flex"
                          aria-label={`Delete ${label.name}`}
                        >
                          <input type="hidden" name="projectId" value={ctx.project.id} />
                          <input type="hidden" name="labelId" value={label.id} />
                          <button type="submit" title={`Delete ${label.name}`} className={ICON_BUTTON}>
                            <Trash01 aria-hidden="true" className="size-4" />
                            <span className="visually-hidden">Delete {label.name}</span>
                          </button>
                        </ActionForm>
                      </SettingsRow>
                    ))
                  )}

                  <ActionForm
                    action={createLabel}
                    className={NEW_ROW_CLASS}
                    aria-label="Add a label"
                    resetOnSuccess
                  >
                    <input type="hidden" name="projectId" value={ctx.project.id} />
                    <input
                      name="name"
                      required
                      maxLength={40}
                      placeholder="New label name"
                      aria-label="Label name"
                      className={cx(ROW_INPUT, 'w-40 flex-1')}
                    />
                    <ColorSwatches name="color" defaultValue="gray" />
                    <SubmitButton pendingLabel="Adding...">Add label</SubmitButton>
                  </ActionForm>
                </div>
              </Card>
            </Section>

            {/* -------------------------------------------------------------- */}
            <Section id="cycles" labelledBy="cycles-heading">
              <Card>
                <ActionForm
                  action={updateCycleConfig}
                  autosave
                  className="flex flex-col gap-4"
                  aria-label="Cycle settings"
                >
                  <input type="hidden" name="projectId" value={ctx.project.id} />

                  <div className="flex items-start justify-between gap-4">
                    <div className="flex min-w-0 flex-col gap-1">
                      <Card.Title id="cycles-heading">Cycles</Card.Title>
                      <Card.Description id="cycles-hint">
                        Time-boxed sprints, generated from this cadence. Finished cycles keep their
                        dates.
                      </Card.Description>
                    </div>
                    <Switch
                      name="cyclesEnabled"
                      defaultChecked={cadence.cyclesEnabled}
                      aria-label="Use cycles in this project"
                      aria-describedby="cycles-hint"
                    />
                  </div>

                  <div className="flex flex-wrap gap-4">
                    <Field htmlFor="cycle-weeks" label="Length">
                      <SettingsSelect
                        id="cycle-weeks"
                        name="cycleWeeks"
                        defaultValue={cadence.cycleWeeks}
                        className="w-36"
                      >
                        {[1, 2, 3, 4, 6, 8].map((weeks) => (
                          <option key={weeks} value={weeks}>
                            {weeks} {weeks === 1 ? 'week' : 'weeks'}
                          </option>
                        ))}
                      </SettingsSelect>
                    </Field>

                    <Field htmlFor="cycle-start" label="Starts on">
                      <SettingsSelect
                        id="cycle-start"
                        name="cycleStartDay"
                        defaultValue={cadence.cycleStartDay}
                        className="w-36"
                      >
                        {WEEKDAYS.map((day) => (
                          <option key={day.value} value={day.value}>
                            {day.label}
                          </option>
                        ))}
                      </SettingsSelect>
                    </Field>

                    <Field htmlFor="cycle-upcoming" label="Upcoming cycles kept">
                      <SettingsSelect
                        id="cycle-upcoming"
                        name="upcomingCycles"
                        defaultValue={cadence.upcomingCycles}
                        className="w-36"
                      >
                        {[1, 2, 3, 4, 6, 8, 12].map((count) => (
                          <option key={count} value={count}>
                            {count}
                          </option>
                        ))}
                      </SettingsSelect>
                    </Field>
                  </div>
                </ActionForm>
              </Card>
            </Section>

            {/* -------------------------------------------------------------- */}
            <Section id="danger" labelledBy="danger-heading">
              <DangerZone
                id="danger-heading"
                title="Danger zone"
                description={`Deleting removes every issue, cycle, and label in this project for everyone. This cannot be undone.`}
                buttonLabel="Delete this project..."
              >
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
                  <div className="flex">
                    <SubmitButton color="primary-destructive" pendingLabel="Deleting...">
                      Delete project
                    </SubmitButton>
                  </div>
                </ActionForm>
              </DangerZone>
            </Section>
          </div>
        </div>
      </PageBody>
    </>
  );
}
