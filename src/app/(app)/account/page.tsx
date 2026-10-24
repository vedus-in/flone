import type { Metadata } from 'next';

import { PageBar, PageBody } from '@/components/page-bar';
import { Badge, Card, Field, Input, PageHeader, SubmitButton } from '@/components/ui';
import { loadPage, requireUser } from '@/lib/authz';
import { prisma } from '@/lib/db';
import { ActionForm } from '../action-form';
import { ThemeSelect } from './theme-select';
import {
  removePhone,
  requestPhoneCode,
  updateNotificationPreferences,
  verifyPhoneCode,
} from './actions';

export const metadata: Metadata = {
  title: 'Account',
};

/**
 * `/account` -- email preferences.
 *
 * Its own page rather than a section of `/tokens`. That page is about MCP
 * credentials and its copy is about what a token can do; mail preferences would
 * be an unrelated second subject sharing a heading.
 *
 * A native `<input type="checkbox">`, not Untitled UI's `Toggle`: `ActionForm`
 * restores a rejected submit by writing back through `form.elements`, which
 * only reaches real form controls. A react-aria toggle keeps its own state and
 * would silently disagree with what the form actually submits -- the same
 * reason the org settings page uses a native `<select>`.
 */

const PREFERENCES = [
  {
    name: 'notifyAssigned',
    label: 'When an issue is assigned to me',
    hint: 'Sent when somebody else assigns you an issue. Assigning one to yourself never sends anything.',
  },
  {
    name: 'notifyComments',
    label: 'New comments on issues I am involved in',
    hint: 'Issues you created, are assigned to, or have already commented on.',
  },
  {
    name: 'notifyOrgMembership',
    label: 'When I am added to an organization',
    hint: 'One message when somebody adds you to a workspace.',
  },
] as const;

export default async function AccountPage() {
  const session = await loadPage(() => requireUser());

  const user = await prisma.user.findUnique({
    where: { id: session.id },
    select: {
      email: true,
      notifyAssigned: true,
      notifyComments: true,
      notifyOrgMembership: true,
      phone: true,
      phoneVerified: true,
      // Never the hash and never the expiry -- only whether a call is
      // outstanding, which is all the form needs to decide what to show.
      phoneCodeExpiresAt: true,
    },
  });

  const phone = user?.phone ?? null;
  const phoneVerified = Boolean(user?.phoneVerified);
  const awaitingCode =
    Boolean(phone) &&
    !phoneVerified &&
    (user?.phoneCodeExpiresAt?.getTime() ?? 0) > Date.now();

  const current = {
    notifyAssigned: user?.notifyAssigned ?? true,
    notifyComments: user?.notifyComments ?? true,
    notifyOrgMembership: user?.notifyOrgMembership ?? true,
  };

  return (
    <>
      <PageBar crumbs={[{ label: 'Account' }]} />
      <PageBody className="flex flex-col gap-8">
        <PageHeader
          title="Account"
          description={`Preferences and notification settings for ${user?.email ?? session.email}.`}
        />

        <section aria-labelledby="interface-heading">
          <Card className="flex-row flex-wrap items-center justify-between gap-4 p-6">
            <Card.Header>
              <Card.Title id="interface-heading">Interface theme</Card.Title>
              <Card.Description>Applies to this browser.</Card.Description>
            </Card.Header>
            <ThemeSelect />
          </Card>
        </section>

        <section aria-labelledby="notifications-heading">
          <Card className="gap-4 p-6">
            <Card.Header>
              <Card.Title id="notifications-heading" className="text-base">
                Email notifications
              </Card.Title>
              <Card.Description>
                Security messages — a password change, a new MCP access token — are always sent and
                cannot be turned off.
              </Card.Description>
            </Card.Header>

            <ActionForm
              action={updateNotificationPreferences}
              className="flex flex-col gap-5"
              aria-label="Email notification preferences"
            >
              <div className="flex flex-col gap-4">
                {PREFERENCES.map((preference) => (
                  <div key={preference.name} className="flex items-start gap-3">
                    <input
                      id={preference.name}
                      name={preference.name}
                      type="checkbox"
                      defaultChecked={current[preference.name]}
                      // The hint says which messages the box actually governs, so
                      // it is part of the choice rather than decoration beside it.
                      // Hand-wired because this row is not a `Field`: the label
                      // and hint sit in a column next to the box, not under it.
                      aria-describedby={`${preference.name}-hint`}
                      className="mt-0.5 size-4 shrink-0 rounded border-primary text-brand-solid outline-focus-ring focus-visible:outline-2 focus-visible:outline-offset-2"
                    />
                    <div className="flex flex-col gap-0.5">
                      <label
                        htmlFor={preference.name}
                        className="text-sm font-medium text-primary"
                      >
                        {preference.label}
                      </label>
                      <p id={`${preference.name}-hint`} className="text-sm text-tertiary">
                        {preference.hint}
                      </p>
                    </div>
                  </div>
                ))}
              </div>

              <div className="flex flex-wrap items-center gap-2">
                <SubmitButton pendingLabel="Saving...">Save preferences</SubmitButton>
              </div>
            </ActionForm>
          </Card>
        </section>

        {/* ------------------------------------------------------------------ */}
        {/* Phone                                                               */}
        {/*                                                                     */}
        {/* On `/account` and nowhere else, because a number is set only by its  */}
        {/* owner. There is no admin screen for this and no field on the invite  */}
        {/* form: the moment somebody else can type your number in, a reminder   */}
        {/* becomes a way to make a stranger's phone ring every morning.         */}
        {/* ------------------------------------------------------------------ */}
        <section aria-labelledby="phone-heading">
          <Card className="gap-4 p-6">
            <Card.Header>
              <Card.Title id="phone-heading" className="text-base">
                Phone number
              </Card.Title>
              <Card.Description>
                Used only by reminders you or a teammate schedule as a call. We confirm it by
                phoning you once with a six-digit code.
              </Card.Description>
            </Card.Header>

            {phone ? (
              <div className="flex flex-col gap-4">
                <div className="flex flex-wrap items-center gap-3">
                  {/* Rendered as plain text in a fixed direction: a phone number
                      is a left-to-right sequence whatever the surrounding copy
                      does, and `+91...` reorders visually without this. */}
                  <span dir="ltr" className="font-medium text-primary tabular-nums">
                    {phone}
                  </span>
                  {phoneVerified ? (
                    <Badge tone="success">Confirmed</Badge>
                  ) : (
                    <Badge tone="warning">Not confirmed</Badge>
                  )}
                </div>

                {phoneVerified ? null : (
                  <p className="text-sm text-error-primary">
                    Until this number is confirmed, no reminder will call it.
                  </p>
                )}

                {awaitingCode ? (
                  <ActionForm
                    action={verifyPhoneCode}
                    className="flex flex-col gap-4"
                    aria-label="Confirm your phone number"
                  >
                    <Field
                      htmlFor="phone-code"
                      label="Code from the call"
                      hint="You get one attempt per call, so take a moment. The code expires after ten minutes."
                    >
                      <Input
                        id="phone-code"
                        name="code"
                        required
                        inputMode="numeric"
                        autoComplete="one-time-code"
                        maxLength={6}
                        placeholder="123456"
                        className="max-w-40 tabular-nums"
                      />
                    </Field>
                    <div className="flex flex-wrap items-center gap-2">
                      <SubmitButton pendingLabel="Confirming...">Confirm number</SubmitButton>
                    </div>
                  </ActionForm>
                ) : null}

                <div className="flex flex-wrap items-center gap-2 border-t border-secondary pt-4">
                  <ActionForm
                    action={requestPhoneCode}
                    className="flex flex-wrap items-end gap-2"
                    aria-label="Change your phone number"
                  >
                    <Field htmlFor="phone-new" label="Change or re-confirm">
                      <Input
                        id="phone-new"
                        name="phone"
                        required
                        type="tel"
                        dir="ltr"
                        inputMode="tel"
                        autoComplete="tel"
                        defaultValue={phone}
                        placeholder="+14155550100"
                        className="max-w-56"
                      />
                    </Field>
                    <SubmitButton color="secondary" pendingLabel="Calling...">
                      Call me with a code
                    </SubmitButton>
                  </ActionForm>

                  <ActionForm action={removePhone} aria-label="Remove your phone number">
                    <SubmitButton color="secondary-destructive" pendingLabel="Removing...">
                      Remove
                    </SubmitButton>
                  </ActionForm>
                </div>
              </div>
            ) : (
              <ActionForm
                action={requestPhoneCode}
                className="flex flex-col gap-4"
                aria-label="Add your phone number"
              >
                <Field
                  htmlFor="phone"
                  label="Phone number"
                  /* No default country and no local formats. `8448417051` is a
                     valid Indian mobile AND a valid US toll-free number, and
                     guessing between them silently phones a stranger. The `+`
                     makes the user say which they meant. */
                  hint="International format, starting with the country code — for example +14155550100 or +919876543210."
                >
                  <Input
                    id="phone"
                    name="phone"
                    required
                    type="tel"
                    dir="ltr"
                    inputMode="tel"
                    autoComplete="tel"
                    placeholder="+14155550100"
                    className="max-w-56"
                  />
                </Field>
                <div className="flex flex-wrap items-center gap-2">
                  <SubmitButton pendingLabel="Calling...">Call me with a code</SubmitButton>
                </div>
              </ActionForm>
            )}
          </Card>
        </section>
      </PageBody>
    </>
  );
}
