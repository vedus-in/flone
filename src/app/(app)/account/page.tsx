import type { Metadata } from 'next';

import { Card, PageHeader, SubmitButton } from '@/components/ui';
import { loadPage, requireUser } from '@/lib/authz';
import { prisma } from '@/lib/db';
import { ActionForm } from '../action-form';
import { updateNotificationPreferences } from './actions';

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
    },
  });

  const current = {
    notifyAssigned: user?.notifyAssigned ?? true,
    notifyComments: user?.notifyComments ?? true,
    notifyOrgMembership: user?.notifyOrgMembership ?? true,
  };

  return (
    <div className="flex flex-col gap-8">
      <PageHeader
        title="Account"
        description={`Email preferences for ${user?.email ?? session.email}.`}
      />

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
                    className="mt-0.5 size-4 shrink-0 rounded border-primary text-brand-solid outline-focus-ring focus-visible:outline-2 focus-visible:outline-offset-2"
                  />
                  <div className="flex flex-col gap-0.5">
                    <label
                      htmlFor={preference.name}
                      className="text-sm font-medium text-primary"
                    >
                      {preference.label}
                    </label>
                    <p className="text-sm text-tertiary">{preference.hint}</p>
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
    </div>
  );
}
