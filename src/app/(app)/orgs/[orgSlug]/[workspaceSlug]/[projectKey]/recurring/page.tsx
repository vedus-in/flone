import type { Metadata } from 'next';
import { Priority, Role, TicketRepeat } from '@prisma/client';

import {
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRoot,
  TableRow,
} from '@/components/table';
import {
  Badge,
  Breadcrumbs,
  Card,
  Field,
  Input,
  Label,
  PageHeader,
  SubmitButton,
  Textarea,
} from '@/components/ui';
import { atLeast, loadPage, orgPath, projectPath, requireProjectByKey } from '@/lib/authz';
import { prisma } from '@/lib/db';
import { PRIORITY_LABEL, PRIORITY_ORDER, colorClass } from '@/lib/model';
import { TICKET_REPEAT_LABEL, formatWhen } from '@/lib/reminder-math';
import { ActionForm } from '../../../../../action-form';
import { TzOffsetField } from '../../../reminders/tz-offset-field';
import {
  createRecurringTicket,
  deleteRecurringTicket,
  setRecurringTicketPaused,
  updateRecurringTicket,
} from './actions';

export const metadata: Metadata = {
  title: 'Recurring',
};

/**
 * Recurring ticket templates for one project.
 *
 * Design: docs/superpowers/specs/2026-08-16-recurring-tickets-design.md, §8.
 *
 * PROJECT-scoped, not organization-scoped like Reminders, because everything on
 * the form belongs to the project: its labels, and the first Todo-type state a
 * spawned ticket lands in. Every member sees every template here, the same rule
 * as the issues list; only Delete is conditional, and the action re-checks it.
 *
 * Times are rendered from each row's own stored offset, so the page reads
 * identically on the server, in the browser hydrating it, and in the mail the
 * cron sends hours later from another continent.
 *
 * NATIVE CONTROLS THROUGHOUT -- selects, checkboxes, the textarea and the
 * datetime field. `ActionForm` puts a rejected submit back through
 * `form.elements`, which only reaches real form controls, so anything
 * listbox-backed would silently disagree with what the form actually submits.
 * The reminders page records the same rule for the same reason.
 */

/**
 * A native `<select>` wearing Untitled UI's field tokens -- the same constant
 * the reminders page declares, copied rather than imported because that page's
 * neighbours are its own and this one has no shared module to hang it on.
 */
const SELECT_CLASS =
  'min-h-9 rounded-lg border border-primary bg-primary px-3 py-2 text-sm text-primary shadow-xs outline-focus-ring transition-colors hover:bg-primary_hover focus-visible:outline-2 focus-visible:outline-offset-2';

const CHECKBOX_CLASS =
  'size-4 shrink-0 rounded border-primary text-brand-solid outline-focus-ring focus-visible:outline-2 focus-visible:outline-offset-2';

/**
 * Soonest first, and every cadence has one -- `ONCE` deliberately does not
 * exist here, because a one-time pre-filled ticket is called creating a ticket.
 */
const REPEAT_ORDER: TicketRepeat[] = [
  TicketRepeat.DAILY,
  TicketRepeat.WEEKDAYS,
  TicketRepeat.WEEKLY,
  TicketRepeat.MONTHLY,
];

/** The same cap `createIssue` and the actions enforce; stated here so it reads. */
const MAX_LABELS = 20;

type Params = { orgSlug: string; workspaceSlug: string; projectKey: string };

type Member = { id: string; name: string };
type LabelOption = { id: string; name: string; color: string };

/* -------------------------------------------------------------------------- */
/* Shared field groups                                                         */
/*                                                                             */
/* Rendered once in the create card and once per edit panel. Each takes an      */
/* `idPrefix` because DOM ids must be unique across the page and there is one   */
/* of these per row -- duplicate ids would point every label at the first form. */
/* -------------------------------------------------------------------------- */

function RepeatSelect({ idPrefix, value }: { idPrefix: string; value: TicketRepeat }) {
  const id = `${idPrefix}-repeat`;
  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={id}>Repeats</Label>
      <select id={id} name="repeat" defaultValue={value} className={`${SELECT_CLASS} w-full`}>
        {REPEAT_ORDER.map((repeat) => (
          <option key={repeat} value={repeat}>
            {TICKET_REPEAT_LABEL[repeat]}
          </option>
        ))}
      </select>
      <span className="text-xs text-pretty text-tertiary">
        Every weekday skips Saturday and Sunday. Every month keeps the date you picked, clamped to
        the length of shorter months.
      </span>
    </div>
  );
}

function AssigneeSelect({
  idPrefix,
  members,
  viewerId,
  value,
}: {
  idPrefix: string;
  members: Member[];
  viewerId: string;
  value: string;
}) {
  const id = `${idPrefix}-assignee`;
  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={id}>Assign to</Label>
      <select id={id} name="assigneeId" defaultValue={value} className={`${SELECT_CLASS} w-full`}>
        <option value="">Nobody</option>
        {members.map((member) => (
          <option key={member.id} value={member.id}>
            {member.id === viewerId ? `${member.name} (you)` : member.name}
          </option>
        ))}
      </select>
      <span className="text-xs text-pretty text-tertiary">
        They get an email each time a ticket is created. Optional.
      </span>
    </div>
  );
}

function PrioritySelect({ idPrefix, value }: { idPrefix: string; value: Priority }) {
  const id = `${idPrefix}-priority`;
  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={id}>Priority</Label>
      <select id={id} name="priority" defaultValue={value} className={`${SELECT_CLASS} w-full`}>
        {PRIORITY_ORDER.map((priority) => (
          <option key={priority} value={priority}>
            {PRIORITY_LABEL[priority]}
          </option>
        ))}
      </select>
    </div>
  );
}

/**
 * Checkboxes rather than a `<select multiple>`, the reminders page's reasoning:
 * the native multi-select needs ctrl-click to pick a second entry, which is
 * exactly the interaction nobody discovers.
 */
function LabelPicker({
  idPrefix,
  labels,
  checked,
}: {
  idPrefix: string;
  labels: LabelOption[];
  checked: ReadonlySet<string>;
}) {
  if (labels.length === 0) {
    return (
      <div className="flex flex-col gap-1.5">
        <span className="text-sm font-medium text-secondary">Labels</span>
        <span className="text-xs text-pretty text-tertiary">
          This project has no labels yet. One label per recurring duty is what turns its history
          into a filter on the issues list.
        </span>
      </div>
    );
  }

  return (
    <fieldset className="flex flex-col gap-1.5">
      <legend className="mb-1.5 text-sm font-medium text-secondary">Labels</legend>
      <div className="flex max-h-40 flex-col gap-2 overflow-y-auto rounded-lg border border-primary bg-primary px-3 py-2.5">
        {labels.map((label) => {
          const id = `${idPrefix}-label-${label.id}`;
          return (
            <div key={label.id} className="flex items-center gap-2.5">
              <input
                id={id}
                name="labelIds"
                type="checkbox"
                value={label.id}
                defaultChecked={checked.has(label.id)}
                className={CHECKBOX_CLASS}
              />
              <label htmlFor={id} className="flex items-center gap-1.5 text-sm text-primary">
                <span
                  aria-hidden="true"
                  className={`size-1.5 rounded-full ${colorClass(label.color).dot}`}
                />
                {label.name}
              </label>
            </div>
          );
        })}
      </div>
      <span className="text-xs text-pretty text-tertiary">
        Copied onto every ticket this creates, so the whole history of one duty is one filter.
        Up to {MAX_LABELS}.
      </span>
    </fieldset>
  );
}

/* -------------------------------------------------------------------------- */

export default async function RecurringPage({ params }: { params: Promise<Params> }) {
  const { orgSlug, workspaceSlug, projectKey } = await params;
  const ctx = await loadPage(() =>
    requireProjectByKey(orgSlug, workspaceSlug, projectKey.toUpperCase()),
  );

  const [templates, labels, memberships] = await Promise.all([
    prisma.recurringTicket.findMany({
      where: { projectId: ctx.project.id },
      // Soonest first, and PAUSED rows sink to the bottom rather than
      // disappearing: `nextRunAt` is null when paused, and a template that
      // cannot be seen to be paused is one somebody will re-create by hand.
      orderBy: [{ nextRunAt: { sort: 'asc', nulls: 'last' } }, { createdAt: 'desc' }],
      select: {
        id: true,
        title: true,
        description: true,
        priority: true,
        repeat: true,
        anchorAt: true,
        nextRunAt: true,
        lastSpawnedAt: true,
        tzOffsetMinutes: true,
        createdById: true,
        assigneeId: true,
        assignee: { select: { id: true, name: true } },
        createdBy: { select: { name: true } },
        labels: { select: { id: true, name: true, color: true } },
      },
    }),
    prisma.label.findMany({
      where: { projectId: ctx.project.id },
      orderBy: [{ name: 'asc' }, { id: 'asc' }],
      select: { id: true, name: true, color: true },
    }),
    prisma.membership.findMany({
      where: { organizationId: ctx.org.id },
      orderBy: [{ user: { name: 'asc' } }, { id: 'asc' }],
      select: { user: { select: { id: true, name: true } } },
    }),
  ]);

  const members: Member[] = memberships.map((membership) => membership.user);
  const canManageAny = atLeast(ctx.role, Role.ADMIN);
  const noLabels: ReadonlySet<string> = new Set<string>();

  /** Carried on every form so the actions can re-walk to this exact project. */
  const scope = (
    <>
      <input type="hidden" name="orgSlug" value={ctx.org.slug} />
      <input type="hidden" name="projectKey" value={ctx.project.key} />
    </>
  );

  return (
    <div className="flex flex-col gap-8">
      <div className="flex flex-col gap-5">
        <Breadcrumbs>
          <Breadcrumbs.Item href={orgPath(ctx.org)}>{ctx.org.name}</Breadcrumbs.Item>
          <Breadcrumbs.Item href={projectPath(ctx.org, ctx.project)}>
            {ctx.project.name}
          </Breadcrumbs.Item>
          <Breadcrumbs.Item>Recurring</Breadcrumbs.Item>
        </Breadcrumbs>

        <PageHeader
          title="Recurring tickets"
          description={`Tickets ${ctx.project.name} creates for you on a schedule, pre-filled and assigned.`}
        />
      </div>

      {/* ------------------------------------------------------------------ */}
      {/* New recurring ticket                                                */}
      {/* ------------------------------------------------------------------ */}
      <section aria-labelledby="new-recurring-heading">
        <Card className="gap-4 p-6">
          <Card.Header>
            <Card.Title id="new-recurring-heading" className="text-base">
              New recurring ticket
            </Card.Title>
            {/* "Within a few minutes" is not hedging: the scheduler ticks on an
                interval, so the tick interval is a ticket's worst-case
                lateness. Promising the exact minute would be a promise the
                deployment cannot keep. */}
            <Card.Description className="text-pretty">
              A ticket appears in {ctx.project.key} at the time you pick, in your own timezone,
              within a few minutes &mdash; pre-filled and due that day.
            </Card.Description>
          </Card.Header>

          <ActionForm
            action={createRecurringTicket}
            className="flex flex-col gap-5"
            resetOnSuccess
            aria-label="Create a recurring ticket"
          >
            {scope}
            <TzOffsetField />

            <Field
              htmlFor="new-recurring-title"
              label="Title"
              hint={
                <>
                  Each ticket is created with the date on the end, like &ldquo;Daily review
                  &mdash; 16 Aug 2026&rdquo;.
                </>
              }
            >
              {/* `isRequired`, not `required`: `InputBase` spreads its props
                  and THEN writes `required={isRequired}`, so a plain `required`
                  is overwritten with undefined and the browser never blocks the
                  submit. The action rejects it either way; this is the half
                  that says so before a round trip. */}
              <Input
                id="new-recurring-title"
                name="title"
                isRequired
                maxLength={160}
                autoComplete="off"
                placeholder="XAU breakout daily review"
              />
            </Field>

            <Field
              htmlFor="new-recurring-description"
              label="Description (Markdown)"
              hint={
                <>
                  This is the ticket&rsquo;s description, every time. Editing it later changes
                  every future ticket &mdash; it is the living checklist.
                </>
              }
            >
              <Textarea
                id="new-recurring-description"
                name="description"
                rows={6}
                maxLength={10000}
                placeholder={'Deployed on: MT5 - account 1120\n\n## How it worked\n## Performance\n## Improvements'}
              />
            </Field>

            <div className="grid gap-4 sm:grid-cols-2">
              {/* A native `<input type="datetime-local">`, which is what §3 of
                  the design specifies and what `localDateTimeSchema` was
                  written to parse. No default value: "tomorrow at 09:00"
                  depends on the timezone, and a server rendering in UTC would
                  disagree with the browser hydrating it. */}
              <Field
                htmlFor="new-recurring-run-at"
                label="First ticket"
                hint="Your local time. Every later occurrence is counted from this one."
              >
                <Input
                  id="new-recurring-run-at"
                  name="runAt"
                  type="datetime-local"
                  isRequired
                  autoComplete="off"
                />
              </Field>

              <RepeatSelect idPrefix="new-recurring" value={TicketRepeat.DAILY} />

              <AssigneeSelect
                idPrefix="new-recurring"
                members={members}
                viewerId={ctx.user.id}
                value={ctx.user.id}
              />

              <PrioritySelect idPrefix="new-recurring" value={Priority.NONE} />

              <div className="sm:col-span-2">
                <LabelPicker idPrefix="new-recurring" labels={labels} checked={noLabels} />
              </div>
            </div>

            <div className="flex flex-wrap items-center gap-2">
              <SubmitButton pendingLabel="Scheduling...">Create recurring ticket</SubmitButton>
            </div>
          </ActionForm>
        </Card>
      </section>

      {/* ------------------------------------------------------------------ */}
      {/* Scheduled                                                           */}
      {/* ------------------------------------------------------------------ */}
      <section className="flex flex-col gap-4" aria-labelledby="scheduled-heading">
        <h2 id="scheduled-heading" className="text-sm font-medium text-primary">
          Scheduled
        </h2>

        {templates.length === 0 ? (
          <p className="text-sm text-pretty text-tertiary">
            Nothing recurring yet. Anything you add above shows up here with the time its next
            ticket appears.
          </p>
        ) : (
          <div className="w-full overflow-x-auto rounded-xl ring-1 ring-secondary">
            <TableRoot size="sm" aria-label="Scheduled recurring tickets">
              <TableHeader>
                <TableHead isRowHeader className="w-full">
                  Recurring ticket
                </TableHead>
                <TableHead className="whitespace-nowrap">Next</TableHead>
                <TableHead className="whitespace-nowrap">Repeats</TableHead>
                <TableHead className="whitespace-nowrap">To</TableHead>
                <TableHead className="whitespace-nowrap text-end">Manage</TableHead>
              </TableHeader>

              <TableBody>
                {templates.map((template) => {
                  // Presentation only. `deleteRecurringTicket` re-derives all of
                  // this from the session and the stored row.
                  const canDelete = canManageAny || template.createdById === ctx.user.id;
                  const paused = template.nextRunAt === null;
                  const checkedLabels = new Set(template.labels.map((label) => label.id));

                  return (
                    <TableRow key={template.id} id={template.id}>
                      <TableCell>
                        <div className="flex min-w-0 flex-col gap-0.5 py-1">
                          <span className="font-medium text-primary">{template.title}</span>
                          <span className="text-xs text-tertiary">
                            {template.labels.length > 0
                              ? `${template.labels.map((label) => label.name).join(', ')} · `
                              : ''}
                            set by{' '}
                            {template.createdById === ctx.user.id
                              ? 'you'
                              : template.createdBy.name}
                            {template.lastSpawnedAt ? (
                              <>
                                {' '}
                                &middot; last created{' '}
                                <span className="tabular-nums">
                                  {formatWhen(template.lastSpawnedAt, template.tzOffsetMinutes)}
                                </span>
                              </>
                            ) : null}
                          </span>

                          {/*
                           * Edit lives in this column rather than under Manage
                           * because it is the only control that needs room: a
                           * template body is accumulated process, and the
                           * Manage cell is four words wide. Collapsed by
                           * default, so the table reads as the wireframe until
                           * somebody opens one.
                           *
                           * TWO FORMS, NOT ONE. Content and schedule are
                           * separate submits so neither can half-write the
                           * other's columns -- see the header comment in
                           * `actions.ts` for the failure mode and for why the
                           * design's "one form, full replace" cannot work.
                           */}
                          {/*
                           * `min-h-10` is the 40px hit target; `-my-1` gives
                           * back the vertical space that buys, so the row reads
                           * as tightly as before while the tap area is real.
                           * The default marker is removed in favour of a
                           * chevron that rotates on open -- a bare word gives
                           * no hint that anything is behind it.
                           */}
                          <details className="group mt-1">
                            <summary className="-my-1 inline-flex min-h-10 w-fit cursor-pointer list-none items-center gap-1.5 text-xs text-tertiary outline-focus-ring transition-colors duration-100 hover:text-primary focus-visible:outline-2 focus-visible:outline-offset-2 [&::-webkit-details-marker]:hidden">
                              <svg
                                aria-hidden="true"
                                viewBox="0 0 16 16"
                                className="size-3 transition-transform duration-200 ease-[cubic-bezier(0.2,0,0,1)] group-open:rotate-90 motion-reduce:transition-none"
                              >
                                <path
                                  d="M6 4l4 4-4 4"
                                  fill="none"
                                  stroke="currentColor"
                                  strokeWidth="1.5"
                                  strokeLinecap="round"
                                  strokeLinejoin="round"
                                />
                              </svg>
                              Edit
                            </summary>

                            <div className="mt-3 flex flex-col gap-5 rounded-lg border border-secondary p-4">
                              <ActionForm
                                action={updateRecurringTicket}
                                className="flex flex-col gap-4"
                                aria-label={`Edit the recurring ticket "${template.title}"`}
                              >
                                {scope}
                                <input type="hidden" name="part" value="CONTENT" />
                                <input
                                  type="hidden"
                                  name="recurringTicketId"
                                  value={template.id}
                                />

                                <Field htmlFor={`${template.id}-title`} label="Title">
                                  <Input
                                    id={`${template.id}-title`}
                                    name="title"
                                    isRequired
                                    maxLength={160}
                                    autoComplete="off"
                                    defaultValue={template.title}
                                  />
                                </Field>

                                <Field
                                  htmlFor={`${template.id}-description`}
                                  label="Description (Markdown)"
                                  hint="Changes every future ticket. The ones already created keep the text they were made with."
                                >
                                  <Textarea
                                    id={`${template.id}-description`}
                                    name="description"
                                    rows={8}
                                    maxLength={10000}
                                    defaultValue={template.description ?? ''}
                                  />
                                </Field>

                                <div className="grid gap-4 sm:grid-cols-2">
                                  <AssigneeSelect
                                    idPrefix={template.id}
                                    members={members}
                                    viewerId={ctx.user.id}
                                    value={template.assigneeId ?? ''}
                                  />
                                  <PrioritySelect
                                    idPrefix={template.id}
                                    value={template.priority}
                                  />
                                  <div className="sm:col-span-2">
                                    <LabelPicker
                                      idPrefix={template.id}
                                      labels={labels}
                                      checked={checkedLabels}
                                    />
                                  </div>
                                </div>

                                <div>
                                  <SubmitButton size="sm" pendingLabel="Saving...">
                                    Save
                                  </SubmitButton>
                                </div>
                              </ActionForm>

                              <ActionForm
                                action={updateRecurringTicket}
                                className="flex flex-col gap-4"
                                aria-label={`Reschedule the recurring ticket "${template.title}"`}
                              >
                                {scope}
                                <input type="hidden" name="part" value="SCHEDULE" />
                                <input
                                  type="hidden"
                                  name="recurringTicketId"
                                  value={template.id}
                                />
                                <TzOffsetField />

                                <div className="grid gap-4 sm:grid-cols-2">
                                  {/* Empty rather than pre-filled with the
                                      stored anchor: that anchor is in the PAST
                                      for any template that has already spawned,
                                      and re-submitting it would be rejected by
                                      the same guard that keeps a first run
                                      honest. Rescheduling means naming a new
                                      first run. */}
                                  <Field
                                    htmlFor={`${template.id}-run-at`}
                                    label="New first ticket"
                                    hint="Replaces the anchor every later occurrence is counted from."
                                  >
                                    <Input
                                      id={`${template.id}-run-at`}
                                      name="runAt"
                                      type="datetime-local"
                                      isRequired
                                      autoComplete="off"
                                    />
                                  </Field>

                                  <RepeatSelect
                                    idPrefix={template.id}
                                    value={template.repeat}
                                  />
                                </div>

                                <div>
                                  <SubmitButton
                                    color="secondary"
                                    size="sm"
                                    pendingLabel="Saving..."
                                  >
                                    {paused
                                      ? 'Save schedule (stays paused)'
                                      : 'Save schedule'}
                                  </SubmitButton>
                                </div>
                              </ActionForm>
                            </div>
                          </details>
                        </div>
                      </TableCell>

                      <TableCell className="whitespace-nowrap align-top">
                        {/* Every row in this column is a clock. Proportional
                            digits make the times jitter against each other down
                            the column; tabular ones line them up. */}
                        <span className="text-sm text-secondary tabular-nums">
                          {template.nextRunAt
                            ? formatWhen(template.nextRunAt, template.tzOffsetMinutes)
                            : 'Paused'}
                        </span>
                      </TableCell>

                      <TableCell className="whitespace-nowrap align-top">
                        <Badge tone={paused ? 'neutral' : 'accent'}>
                          {TICKET_REPEAT_LABEL[template.repeat]}
                        </Badge>
                      </TableCell>

                      <TableCell className="whitespace-nowrap align-top">
                        <span className="text-sm text-secondary">
                          {template.assignee
                            ? template.assignee.id === ctx.user.id
                              ? 'You'
                              : template.assignee.name
                            : '—'}
                        </span>
                      </TableCell>

                      <TableCell className="align-top">
                        <div className="flex flex-col items-end gap-2">
                          {/* Any member may pause or resume: it is the
                              assignee's escape hatch when a template is filling
                              their board, and nothing is lost by it. */}
                          <ActionForm
                            action={setRecurringTicketPaused}
                            className="flex flex-col items-end gap-2"
                            aria-label={`${paused ? 'Resume' : 'Pause'} the recurring ticket "${template.title}"`}
                          >
                            {scope}
                            <input type="hidden" name="recurringTicketId" value={template.id} />
                            <input type="hidden" name="paused" value={paused ? 'false' : 'true'} />
                            <SubmitButton
                              color="secondary"
                              size="sm"
                              pendingLabel={paused ? 'Resuming...' : 'Pausing...'}
                            >
                              {paused ? 'Resume' : 'Pause'}
                            </SubmitButton>
                          </ActionForm>

                          {/* Never dangled at somebody who cannot do it -- and
                              the action re-checks regardless. */}
                          {canDelete ? (
                            <ActionForm
                              action={deleteRecurringTicket}
                              className="flex flex-col items-end gap-2"
                              aria-label={`Delete the recurring ticket "${template.title}"`}
                            >
                              {scope}
                              <input type="hidden" name="recurringTicketId" value={template.id} />
                              <SubmitButton
                                color="secondary-destructive"
                                size="sm"
                                pendingLabel="Deleting..."
                              >
                                Delete
                              </SubmitButton>
                            </ActionForm>
                          ) : (
                            <span className="text-xs whitespace-nowrap text-tertiary">
                              Pause only
                            </span>
                          )}
                        </div>
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </TableRoot>
          </div>
        )}
      </section>
    </div>
  );
}
