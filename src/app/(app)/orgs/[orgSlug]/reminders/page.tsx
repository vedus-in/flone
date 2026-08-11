import type { Metadata } from 'next';
import { ReminderRepeat, Role } from '@prisma/client';

import {
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRoot,
  TableRow,
} from '@/components/table';
import { Badge, Breadcrumbs, Card, Field, Input, Label, PageHeader, SubmitButton } from '@/components/ui';
import { atLeast, loadPage, orgPath, requireOrgBySlug } from '@/lib/authz';
import { prisma } from '@/lib/db';
import { REPEAT_LABEL, formatWhen } from '@/lib/reminder-math';
import { ActionForm } from '../../../action-form';
import { createReminder, deleteReminder } from './actions';
import { TzOffsetField } from './tz-offset-field';

export const metadata: Metadata = {
  title: 'Reminders',
};

/**
 * Scheduled email reminders for one organization.
 *
 * ONE PAGE, NOT TWO. Scope is a field on the form rather than a second route
 * under each project, so "what have we got scheduled?" has a single answer and
 * the project-scoped and organization-scoped cases share every line of UI. The
 * page sits at organization level for the same reason the challenges board does:
 * a reminder may name any project in the organization, or none.
 *
 * Every member sees every reminder in the organization -- the same rule as the
 * member roster (SPEC 3: read everything in the org). Only the delete button is
 * conditional, and the action re-checks it.
 *
 * Times are rendered from each row's own stored offset, so the page reads
 * identically on the server, in the browser hydrating it, and in the email the
 * cron sends hours later from another continent.
 */

/**
 * A native `<select>` wearing Untitled UI's field tokens. Native for the reason
 * spelled out on the organization settings page: `ActionForm` restores a
 * rejected submit through `form.elements`, which only reaches real form
 * controls, and a listbox-backed select would silently disagree with what the
 * form actually submits.
 */
const SELECT_CLASS =
  'min-h-9 rounded-lg border border-primary bg-primary px-3 py-2 text-sm text-primary shadow-xs outline-focus-ring transition-colors hover:bg-primary_hover focus-visible:outline-2 focus-visible:outline-offset-2';

/**
 * The scope selector's organization-wide option. Spelled out here rather than
 * imported: every export of a `'use server'` module has to be an async function,
 * so `actions.ts` cannot share a constant. A mismatch is not silent -- the value
 * would fail the action's `ORG | cuid` union and the form would say so.
 */
const ORG_SCOPE = 'ORG';

const REPEAT_ORDER: ReminderRepeat[] = [
  ReminderRepeat.ONCE,
  ReminderRepeat.DAILY,
  ReminderRepeat.WEEKLY,
];

export default async function RemindersPage({
  params,
}: {
  params: Promise<{ orgSlug: string }>;
}) {
  const { orgSlug } = await params;
  const ctx = await loadPage(() => requireOrgBySlug(orgSlug));

  const [reminders, projects, members] = await Promise.all([
    prisma.reminder.findMany({
      where: { organizationId: ctx.org.id },
      // Soonest first; the ones that have finished sending sink to the bottom
      // rather than disappearing, so a one-time reminder can be seen to have run.
      orderBy: [{ nextRunAt: { sort: 'asc', nulls: 'last' } }, { createdAt: 'desc' }],
      select: {
        id: true,
        title: true,
        repeat: true,
        nextRunAt: true,
        lastSentAt: true,
        tzOffsetMinutes: true,
        createdById: true,
        project: { select: { name: true, key: true } },
        recipient: { select: { id: true, name: true, emailVerified: true } },
        createdBy: { select: { name: true } },
      },
    }),
    prisma.project.findMany({
      where: { organizationId: ctx.org.id },
      orderBy: [{ name: 'asc' }, { id: 'asc' }],
      select: { id: true, name: true, key: true },
    }),
    prisma.membership.findMany({
      where: { organizationId: ctx.org.id },
      orderBy: [{ user: { name: 'asc' } }, { id: 'asc' }],
      select: { user: { select: { id: true, name: true } } },
    }),
  ]);

  const canManageAny = atLeast(ctx.role, Role.ADMIN);

  return (
    <div className="flex flex-col gap-8">
      <div className="flex flex-col gap-5">
        <Breadcrumbs>
          <Breadcrumbs.Item href="/orgs">Organizations</Breadcrumbs.Item>
          <Breadcrumbs.Item href={orgPath(ctx.org)}>{ctx.org.name}</Breadcrumbs.Item>
          <Breadcrumbs.Item>Reminders</Breadcrumbs.Item>
        </Breadcrumbs>

        <PageHeader
          title="Reminders"
          description="Scheduled emails for you or a teammate, about this organization or one of its projects."
        />
      </div>

      {/* ------------------------------------------------------------------ */}
      {/* New reminder                                                        */}
      {/* ------------------------------------------------------------------ */}
      <section aria-labelledby="new-reminder-heading">
        <Card className="gap-4 p-6">
          <Card.Header>
            <Card.Title id="new-reminder-heading" className="text-base">
              New reminder
            </Card.Title>
            {/* "Within a few minutes" is not hedging: the scheduler ticks on
                an interval, so the tick interval is a reminder's worst-case
                lateness. Promising the exact minute here would be a promise the
                deployment cannot keep. */}
            <Card.Description>
              The email arrives at the time you pick, in your own timezone, within a few minutes.
              Recurring reminders keep that time.
            </Card.Description>
          </Card.Header>

          <ActionForm
            action={createReminder}
            className="flex flex-col gap-5"
            resetOnSuccess
            aria-label="Schedule a reminder"
          >
            <input type="hidden" name="orgSlug" value={ctx.org.slug} />
            <TzOffsetField />

            <Field
              htmlFor="reminder-title"
              label="Remind about"
              hint="This becomes the subject line, so write it the way you want to read it."
            >
              <Input
                id="reminder-title"
                name="title"
                required
                maxLength={200}
                autoComplete="off"
                placeholder="Post the deploy notes before standup"
              />
            </Field>

            <div className="grid gap-4 sm:grid-cols-2">
              <Field htmlFor="reminder-run-at" label="First send">
                {/* Native picker: it is the platform's own control, it is
                    keyboard accessible everywhere, and it submits a plain
                    `YYYY-MM-DDTHH:mm` the action can parse. */}
                <Input id="reminder-run-at" name="runAt" type="datetime-local" required />
              </Field>

              <div className="flex flex-col gap-1.5">
                <Label htmlFor="reminder-repeat">Repeats</Label>
                <select
                  id="reminder-repeat"
                  name="repeat"
                  defaultValue={ReminderRepeat.ONCE}
                  className={`${SELECT_CLASS} w-full`}
                >
                  {REPEAT_ORDER.map((repeat) => (
                    <option key={repeat} value={repeat}>
                      {REPEAT_LABEL[repeat]}
                    </option>
                  ))}
                </select>
                <span className="text-xs text-tertiary">
                  A recurring reminder keeps sending until it is deleted.
                </span>
              </div>

              <div className="flex flex-col gap-1.5">
                <Label htmlFor="reminder-scope">About</Label>
                <select
                  id="reminder-scope"
                  name="scope"
                  defaultValue={ORG_SCOPE}
                  className={`${SELECT_CLASS} w-full`}
                >
                  <option value={ORG_SCOPE}>{ctx.org.name} (whole organization)</option>
                  {projects.map((project) => (
                    <option key={project.id} value={project.id}>
                      {project.key} — {project.name}
                    </option>
                  ))}
                </select>
                <span className="text-xs text-tertiary">
                  Shown in the email, so the reason for the nudge arrives with it.
                </span>
              </div>

              <div className="flex flex-col gap-1.5">
                <Label htmlFor="reminder-recipient">Send to</Label>
                <select
                  id="reminder-recipient"
                  name="recipientId"
                  defaultValue={ctx.user.id}
                  className={`${SELECT_CLASS} w-full`}
                >
                  {members.map((member) => (
                    <option key={member.user.id} value={member.user.id}>
                      {member.user.id === ctx.user.id
                        ? `${member.user.name} (you)`
                        : member.user.name}
                    </option>
                  ))}
                </select>
                <span className="text-xs text-tertiary">
                  Anyone in {ctx.org.name}. They can delete it themselves.
                </span>
              </div>
            </div>

            <div className="flex flex-wrap items-center gap-2">
              <SubmitButton pendingLabel="Scheduling...">Schedule reminder</SubmitButton>
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

        {reminders.length === 0 ? (
          <p className="text-sm text-tertiary">
            Nothing scheduled yet. Anything you add above shows up here with its next send time.
          </p>
        ) : (
          <div className="w-full overflow-x-auto rounded-xl ring-1 ring-secondary">
            <TableRoot size="sm" aria-label="Scheduled reminders">
              <TableHeader>
                <TableHead isRowHeader className="w-full">
                  Reminder
                </TableHead>
                <TableHead className="whitespace-nowrap">Next</TableHead>
                <TableHead className="whitespace-nowrap">Repeats</TableHead>
                <TableHead className="whitespace-nowrap">To</TableHead>
                <TableHead className="whitespace-nowrap text-end">Manage</TableHead>
              </TableHeader>

              <TableBody>
                {reminders.map((reminder) => {
                  // Presentation only. `deleteReminder` re-derives every part of
                  // this from the session and the stored row.
                  const canDelete =
                    canManageAny ||
                    reminder.createdById === ctx.user.id ||
                    reminder.recipient.id === ctx.user.id;
                  const isSelf = reminder.recipient.id === ctx.user.id;
                  const scope = reminder.project
                    ? `${reminder.project.key} — ${reminder.project.name}`
                    : ctx.org.name;

                  return (
                    <TableRow key={reminder.id} id={reminder.id}>
                      <TableCell>
                        <div className="flex min-w-0 flex-col gap-0.5 py-1">
                          <span className="font-medium text-primary">{reminder.title}</span>
                          <span className="text-xs text-tertiary">
                            {scope} &middot; set by{' '}
                            {reminder.createdById === ctx.user.id
                              ? 'you'
                              : reminder.createdBy.name}
                            {reminder.lastSentAt ? (
                              <>
                                {' '}
                                &middot; last sent{' '}
                                {formatWhen(reminder.lastSentAt, reminder.tzOffsetMinutes)}
                              </>
                            ) : null}
                          </span>
                          {/* The one silent failure this feature has: a
                              reminder addressed to an unconfirmed mailbox is
                              scheduled, advanced and never delivered. Say so
                              here rather than let it look like it worked. */}
                          {reminder.recipient.emailVerified ? null : (
                            <span className="text-xs text-error-primary">
                              {isSelf ? 'Your' : 'Their'} email address is not confirmed yet, so
                              nothing will be delivered.
                            </span>
                          )}
                        </div>
                      </TableCell>

                      <TableCell className="whitespace-nowrap align-top">
                        <span className="text-sm text-secondary">
                          {reminder.nextRunAt
                            ? formatWhen(reminder.nextRunAt, reminder.tzOffsetMinutes)
                            : 'Sent'}
                        </span>
                      </TableCell>

                      <TableCell className="whitespace-nowrap align-top">
                        <Badge tone={reminder.repeat === ReminderRepeat.ONCE ? 'neutral' : 'accent'}>
                          {REPEAT_LABEL[reminder.repeat]}
                        </Badge>
                      </TableCell>

                      <TableCell className="whitespace-nowrap align-top">
                        <span className="text-sm text-secondary">
                          {isSelf ? 'You' : reminder.recipient.name}
                        </span>
                      </TableCell>

                      <TableCell className="align-top">
                        <div className="flex justify-end">
                          {canDelete ? (
                            <ActionForm
                              action={deleteReminder}
                              className="flex flex-col items-end gap-2"
                              aria-label={`Delete the reminder "${reminder.title}"`}
                            >
                              <input type="hidden" name="orgSlug" value={ctx.org.slug} />
                              <input type="hidden" name="reminderId" value={reminder.id} />
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
                              Not yours
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
