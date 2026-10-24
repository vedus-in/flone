import type { Metadata } from 'next';
import { ReminderChannel, ReminderRepeat, Role } from '@prisma/client';

import {
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRoot,
  TableRow,
} from '@/components/table';
import { IconBell } from '@/components/icons';
import { PageBar, PageBody } from '@/components/page-bar';
import { Badge, Card, Field, Input, Label, PageHeader, SubmitButton } from '@/components/ui';
import { atLeast, loadPage, requireOrgBySlug, visibleProject } from '@/lib/authz';
import { prisma } from '@/lib/db';
import {
  CHANNEL_CALLS,
  CHANNEL_EMAILS,
  CHANNEL_LABEL,
  REPEAT_LABEL,
  formatWhen,
} from '@/lib/reminder-math';
import { ActionForm } from '../../../action-form';
import { createReminder, deleteReminder } from './actions';
import { RunAtField } from './run-at-field';
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
  'h-8 rounded-md border border-primary bg-secondary_subtle px-2.5 text-sm text-primary outline-focus-ring transition-colors focus-visible:outline-2 focus-visible:outline-offset-1';

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

const CHANNEL_ORDER: ReminderChannel[] = [
  ReminderChannel.EMAIL,
  ReminderChannel.CALL,
  ReminderChannel.BOTH,
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
      // A reminder scoped to a project renders that project's name and key, so
      // the list is filtered by the same predicate the rest of the app uses.
      // Org-wide reminders carry no project and are simply not narrowed.
      where: {
        organizationId: ctx.org.id,
        OR: [{ projectId: null }, { project: visibleProject(ctx.user.id) }],
      },
      // Soonest first; the ones that have finished sending sink to the bottom
      // rather than disappearing, so a one-time reminder can be seen to have run.
      orderBy: [{ nextRunAt: { sort: 'asc', nulls: 'last' } }, { createdAt: 'desc' }],
      select: {
        id: true,
        title: true,
        repeat: true,
        channel: true,
        nextRunAt: true,
        lastSentAt: true,
        tzOffsetMinutes: true,
        createdById: true,
        project: { select: { name: true, key: true } },
        // `phoneVerified` only -- never the number itself. Every member can
        // read this page, and a roster of colleagues' phone numbers is not
        // something scheduling a reminder should hand out.
        recipient: {
          select: { id: true, name: true, emailVerified: true, phoneVerified: true },
        },
        createdBy: { select: { name: true } },
      },
    }),
    prisma.project.findMany({
      where: visibleProject(ctx.user.id, { organizationId: ctx.org.id }),
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
    <>
      <PageBar crumbs={[{ label: 'Reminders', icon: <IconBell className="size-3.5 text-tertiary" /> }]} />
      <PageBody width="wide" className="flex flex-col gap-8">
        <PageHeader
          title="Reminders"
          description="Scheduled emails and calls for you or a teammate, about this organization or one of its projects."
        />

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
                The email or call arrives at the time you pick, in your own timezone, within a few
                minutes. Recurring reminders keep that time.
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
                {/* Owns its own label and its own hidden `runAt` input, so it is
                    not wrapped in `Field` -- see the note in that module for why
                    this one control is allowed to keep React state where every
                    other input on the page is native. */}
                <RunAtField />

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
                  <Label htmlFor="reminder-channel">How</Label>
                  <select
                    id="reminder-channel"
                    name="channel"
                    defaultValue={ReminderChannel.EMAIL}
                    className={`${SELECT_CLASS} w-full`}
                  >
                    {CHANNEL_ORDER.map((channel) => (
                      <option key={channel} value={channel}>
                        {CHANNEL_LABEL[channel]}
                      </option>
                    ))}
                  </select>
                  <span className="text-xs text-tertiary">
                    A call needs a confirmed number on the recipient&rsquo;s account. Anyone without
                    one is flagged in the list below.
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

                {/*
                 * Checkboxes rather than a `<select multiple>`: the native
                 * multi-select needs ctrl-click to pick a second name, which is
                 * exactly the interaction nobody discovers. Native inputs
                 * regardless -- `ActionForm` restores a rejected submit through
                 * `form.elements`, which only reaches real form controls.
                 */}
                <fieldset className="flex flex-col gap-1.5">
                  <legend className="mb-1.5 text-sm font-medium text-secondary">Send to</legend>
                  <div className="flex max-h-40 flex-col gap-2 overflow-y-auto rounded-lg border border-primary bg-primary px-3 py-2.5">
                    {members.map((member) => {
                      const id = `reminder-recipient-${member.user.id}`;
                      return (
                        <div key={member.user.id} className="flex items-center gap-2.5">
                          <input
                            id={id}
                            name="recipientIds"
                            type="checkbox"
                            value={member.user.id}
                            defaultChecked={member.user.id === ctx.user.id}
                            className="size-4 shrink-0 rounded border-primary text-brand-solid outline-focus-ring focus-visible:outline-2 focus-visible:outline-offset-2"
                          />
                          <label htmlFor={id} className="text-sm text-primary">
                            {member.user.id === ctx.user.id
                              ? `${member.user.name} (you)`
                              : member.user.name}
                          </label>
                        </div>
                      );
                    })}
                  </div>
                  <span className="text-xs text-tertiary">
                    Anyone in {ctx.org.name}. Each person gets their own reminder and can delete it
                    themselves.
                  </span>
                </fieldset>
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
                  <TableHead className="whitespace-nowrap">How</TableHead>
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

                    // What this row will ACTUALLY do, which is not the same as
                    // what it was set to. A channel whose destination has never
                    // been confirmed is claimed, advanced and delivered nowhere --
                    // the feature's one silent failure, and the reason each of
                    // these gets a sentence rather than being left to look fine.
                    const needsEmail = CHANNEL_EMAILS[reminder.channel];
                    const needsCall = CHANNEL_CALLS[reminder.channel];
                    const noEmail = needsEmail && !reminder.recipient.emailVerified;
                    const noPhone = needsCall && !reminder.recipient.phoneVerified;
                    const who = isSelf ? 'Your' : 'Their';
                    // Both missing is one sentence, not two stacked warnings that
                    // say the same thing about the same person.
                    const undeliverable =
                      noEmail && noPhone
                        ? `${who} email address and phone number are both unconfirmed, so nothing will be delivered.`
                        : noEmail
                          ? `${who} email address is not confirmed yet, so ${reminder.channel === ReminderChannel.BOTH ? 'no email will be sent' : 'nothing will be delivered'}.`
                          : noPhone
                            ? `${who} phone number is not confirmed yet, so ${reminder.channel === ReminderChannel.BOTH ? 'no call will be placed' : 'nothing will be delivered'}.`
                            : null;

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
                            {undeliverable ? (
                              <span className="text-xs text-error-primary">{undeliverable}</span>
                            ) : null}
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
                          <Badge
                            tone={
                              undeliverable
                                ? 'danger'
                                : reminder.channel === ReminderChannel.EMAIL
                                  ? 'neutral'
                                  : 'accent'
                            }
                          >
                            {CHANNEL_LABEL[reminder.channel]}
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
      </PageBody>
    </>
  );
}
