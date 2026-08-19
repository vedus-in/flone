import Link from 'next/link';
import { Role } from '@prisma/client';
import { ChevronDown, Plus, XClose } from '@untitledui/icons';

import { prisma } from '@/lib/db';
import {
  atLeast,
  loadPage,
  orgPath,
  orgSettingsPath,
  requireOrgBySlug,
  type OrgRef,
} from '@/lib/authz';
import {
  Avatar,
  Badge,
  Breadcrumbs,
  Card,
  Field,
  Input,
  Label,
  SubmitButton,
} from '@/components/ui';
import {
  DangerZone,
  NEW_ROW_CLASS,
  SettingsRow,
  SettingsSelect,
  initials,
} from '@/components/settings-ui';
import { pendingInvites } from '@/lib/email-token';
import { ActionForm } from '../../../action-form';
import {
  addMember,
  changeMemberRole,
  deleteOrganization,
  removeMember,
  renameOrganization,
  resendInvitation,
  revokeInvitation,
} from './actions';

const ROLE_LABEL: Record<Role, string> = {
  OWNER: 'Owner',
  ADMIN: 'Admin',
  MEMBER: 'Member',
};

const ROLE_HELP: Record<Role, string> = {
  OWNER: 'Full control, including deleting the organization.',
  ADMIN: 'Manages projects, boards and members.',
  MEMBER: 'Reads everything, creates tickets and comments.',
};

const ROLE_ORDER: Role[] = [Role.OWNER, Role.ADMIN, Role.MEMBER];

const NAV_ITEM =
  'rounded-lg px-3 py-1.5 text-sm font-medium no-underline outline-focus-ring transition-colors focus-visible:outline-2 focus-visible:outline-offset-2';
const NAV_ON = 'bg-primary text-primary shadow-xs';
const NAV_OFF = 'text-tertiary hover:text-primary';

function SectionNav({ org }: { org: OrgRef }) {
  return (
    <nav
      aria-label="Organization sections"
      className="flex w-fit items-center gap-1 rounded-xl bg-secondary p-1"
    >
      <Link href={orgPath(org)} className={`${NAV_ITEM} ${NAV_OFF}`}>
        Projects
      </Link>
      <Link
        href={orgSettingsPath(org)}
        aria-current="page"
        className={`${NAV_ITEM} ${NAV_ON}`}
      >
        Members &amp; settings
      </Link>
    </nav>
  );
}

/**
 * The role matrix, folded away.
 *
 * It used to sit under the roster as three permanently-open cards -- reference
 * material, in the reading position, taking the space of two members. A
 * `<details>` keeps every word of it one click from the question it answers and
 * costs nothing when nobody is asking.
 */
function RoleHelp() {
  return (
    <details className="group">
      <summary className="flex w-fit cursor-pointer list-none items-center gap-1 rounded-md text-sm font-medium text-brand-secondary outline-focus-ring hover:underline focus-visible:outline-2 focus-visible:outline-offset-2">
        What can each role do?
        <ChevronDown
          aria-hidden="true"
          className="size-4 transition-transform duration-100 group-open:rotate-180"
        />
      </summary>
      <dl className="mt-3 grid gap-2 sm:grid-cols-3">
        {ROLE_ORDER.map((role) => (
          <div
            key={role}
            className="flex flex-col gap-1 rounded-lg border border-secondary px-3 py-2.5"
          >
            <dt className="text-xs font-medium text-primary">{ROLE_LABEL[role]}</dt>
            <dd className="text-xs text-tertiary">{ROLE_HELP[role]}</dd>
          </div>
        ))}
      </dl>
    </details>
  );
}

export default async function OrganizationSettingsPage({
  params,
}: {
  params: Promise<{ orgSlug: string }>;
}) {
  const { orgSlug } = await params;
  const ctx = await loadPage(() => requireOrgBySlug(orgSlug));

  // Every member of the organization may read the roster (SPEC 3 role matrix:
  // "Read everything in the org"). Only the forms below are role-gated.
  const members = await prisma.membership.findMany({
    where: {
      organizationId: ctx.org.id,
      organization: { memberships: { some: { userId: ctx.user.id } } },
    },
    select: {
      id: true,
      role: true,
      user: { select: { id: true, name: true, email: true } },
    },
    orderBy: [{ role: 'asc' }, { user: { name: 'asc' } }, { id: 'asc' }],
  });

  const canManage = atLeast(ctx.role, Role.ADMIN);

  // Only admins can act on invitations, so only admins are shown them. The read
  // is skipped entirely for everyone else rather than fetched and hidden.
  const invites = canManage ? await pendingInvites(ctx.org.id) : [];

  const isOwner = ctx.role === Role.OWNER;
  const ownerCount = members.filter((member) => member.role === Role.OWNER).length;
  const assignableRoles: Role[] = isOwner
    ? [Role.OWNER, Role.ADMIN, Role.MEMBER]
    : [Role.ADMIN, Role.MEMBER];

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-8">
      <div className="flex flex-col gap-5">
        <Breadcrumbs>
          <Breadcrumbs.Item href="/orgs">Organizations</Breadcrumbs.Item>
          <Breadcrumbs.Item href={orgPath(ctx.org)}>{ctx.org.name}</Breadcrumbs.Item>
          <Breadcrumbs.Item>Members &amp; settings</Breadcrumbs.Item>
        </Breadcrumbs>

        <header className="flex flex-wrap items-center justify-between gap-4">
          <div className="flex min-w-0 items-center gap-3">
            <Avatar
              size="lg"
              rounded={false}
              initials={initials(ctx.org.name)}
              contentClassName="bg-brand-solid text-white"
            />
            <div className="flex min-w-0 flex-col">
              <h1 className="truncate text-xl font-semibold text-primary">{ctx.org.name}</h1>
              <p className="text-sm text-tertiary">
                {members.length} {members.length === 1 ? 'member' : 'members'}
              </p>
            </div>
          </div>
          <Badge tone="accent">{ctx.role}</Badge>
        </header>

        <SectionNav org={ctx.org} />
      </div>

      {/* ------------------------------------------------------------------ */}
      {/* Members                                                             */}
      {/* ------------------------------------------------------------------ */}
      <Card aria-labelledby="members-heading">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <Card.Title id="members-heading">Members</Card.Title>
          <RoleHelp />
        </div>

        <div className="flex flex-col gap-2">
          {members.map((member) => {
            const isSelf = member.user.id === ctx.user.id;
            const targetIsOwner = member.role === Role.OWNER;
            // UI politeness only -- the actions re-check every one of these.
            const actionable = canManage && !isSelf && (!targetIsOwner || isOwner);
            const lastOwner = targetIsOwner && ownerCount <= 1;
            const roleFieldId = `role-${member.id}`;

            return (
              <SettingsRow key={member.id} className="justify-between">
                <div className="flex min-w-0 items-center gap-3">
                  <Avatar size="sm" initials={initials(member.user.name)} />
                  <div className="flex min-w-0 flex-col">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="truncate text-sm font-medium text-primary">
                        {member.user.name}
                      </span>
                      {isSelf ? <Badge>you</Badge> : null}
                    </div>
                    <span className="truncate text-xs text-tertiary">{member.user.email}</span>
                  </div>
                </div>

                <div className="flex items-center gap-2">
                  {actionable ? (
                    <>
                      {/*
                        * Two forms, not one: the role select saves itself on
                        * change, and removal must stay its own submit rather
                        * than something a stray change event can trigger.
                        */}
                      <ActionForm
                        action={changeMemberRole}
                        autosave
                        className="flex items-center"
                        aria-label={`Change role for ${member.user.name}`}
                      >
                        <input type="hidden" name="orgSlug" value={ctx.org.slug} />
                        <input type="hidden" name="membershipId" value={member.id} />
                        <Label htmlFor={roleFieldId} className="visually-hidden">
                          Role for {member.user.name}
                        </Label>
                        <SettingsSelect
                          id={roleFieldId}
                          name="role"
                          defaultValue={member.role}
                          className="w-32"
                        >
                          {assignableRoles.map((role) => (
                            <option key={role} value={role}>
                              {ROLE_LABEL[role]}
                            </option>
                          ))}
                        </SettingsSelect>
                      </ActionForm>

                      <ActionForm
                        action={removeMember}
                        className="flex items-center"
                        aria-label={`Remove ${member.user.name}`}
                      >
                        <input type="hidden" name="orgSlug" value={ctx.org.slug} />
                        <input type="hidden" name="membershipId" value={member.id} />
                        <button
                          type="submit"
                          title={`Remove ${member.user.name} from ${ctx.org.name}`}
                          className="grid size-8 place-items-center rounded-lg text-tertiary transition-colors outline-focus-ring hover:bg-error-primary hover:text-error-primary focus-visible:outline-2 focus-visible:outline-offset-1"
                        >
                          <XClose aria-hidden="true" className="size-4" />
                          <span className="visually-hidden">Remove {member.user.name}</span>
                        </button>
                      </ActionForm>
                    </>
                  ) : (
                    <Badge tone={targetIsOwner ? 'accent' : 'neutral'}>
                      {ROLE_LABEL[member.role]}
                    </Badge>
                  )}

                  {lastOwner ? (
                    <span
                      className="text-xs whitespace-nowrap text-tertiary"
                      title="An organization must always have at least one owner."
                    >
                      Last owner
                    </span>
                  ) : null}
                </div>
              </SettingsRow>
            );
          })}

          {canManage ? (
            <ActionForm
              action={addMember}
              className={NEW_ROW_CLASS}
              resetOnSuccess
              aria-label="Invite someone"
            >
              <input type="hidden" name="orgSlug" value={ctx.org.slug} />
              <span
                aria-hidden="true"
                className="grid size-8 shrink-0 place-items-center rounded-full border border-dashed border-secondary text-tertiary"
              >
                <Plus className="size-4" />
              </span>
              <Label htmlFor="member-email" className="visually-hidden">
                Email
              </Label>
              <input
                id="member-email"
                name="email"
                type="email"
                required
                maxLength={254}
                autoComplete="email"
                placeholder="teammate@example.com"
                className="h-9 min-w-0 flex-1 rounded-lg border border-secondary bg-primary px-3 text-sm text-primary shadow-xs outline-focus-ring placeholder:text-tertiary focus-visible:outline-2 focus-visible:outline-offset-1"
              />
              <Label htmlFor="member-role" className="visually-hidden">
                Role
              </Label>
              <SettingsSelect
                id="member-role"
                name="role"
                defaultValue={Role.MEMBER}
                className="w-32"
              >
                <option value={Role.MEMBER}>{ROLE_LABEL.MEMBER}</option>
                <option value={Role.ADMIN}>{ROLE_LABEL.ADMIN}</option>
              </SettingsSelect>
              <SubmitButton pendingLabel="Inviting...">Invite</SubmitButton>
            </ActionForm>
          ) : null}
        </div>

        {canManage ? (
          <Card.Description className="text-xs">
            Existing accounts are added straight away; everyone else gets an email invitation
            that expires in 7 days.
          </Card.Description>
        ) : null}
      </Card>

      {/* ------------------------------------------------------------------ */}
      {/* Pending invitations                                                 */}
      {/* ------------------------------------------------------------------ */}
      {/*
       * Admins only, and hidden entirely when there are none -- an empty card on
       * every settings page would be pure furniture. These are addresses that
       * have been offered access but do not yet correspond to any account, so
       * they are not part of the member roster above.
       */}
      {canManage && invites.length > 0 ? (
        <Card aria-labelledby="invites-heading">
          <Card.Header>
            <Card.Title id="invites-heading">Pending invitations</Card.Title>
            <Card.Description className="text-xs">
              Nobody has accepted these yet. They stop working on the date shown.
            </Card.Description>
          </Card.Header>

          <div className="flex flex-col gap-2">
            {invites.map((invite) => (
              <SettingsRow key={invite.id} className="justify-between">
                <div className="flex min-w-0 flex-col">
                  <span className="truncate text-sm text-primary">{invite.email}</span>
                  <span className="text-xs text-tertiary">
                    {ROLE_LABEL[invite.role ?? Role.MEMBER]} &middot; expires{' '}
                    {invite.expiresAt.toISOString().slice(0, 10)}
                  </span>
                </div>

                <div className="flex items-center gap-2">
                  <ActionForm
                    action={resendInvitation}
                    className="flex items-center"
                    aria-label={`Resend the invitation to ${invite.email}`}
                  >
                    <input type="hidden" name="orgSlug" value={ctx.org.slug} />
                    <input type="hidden" name="tokenId" value={invite.id} />
                    <SubmitButton color="secondary" size="sm" pendingLabel="Sending...">
                      Resend
                    </SubmitButton>
                  </ActionForm>

                  <ActionForm
                    action={revokeInvitation}
                    className="flex items-center"
                    aria-label={`Revoke the invitation to ${invite.email}`}
                  >
                    <input type="hidden" name="orgSlug" value={ctx.org.slug} />
                    <input type="hidden" name="tokenId" value={invite.id} />
                    <button
                      type="submit"
                      title={`Revoke the invitation to ${invite.email}`}
                      className="grid size-8 place-items-center rounded-lg text-tertiary transition-colors outline-focus-ring hover:bg-error-primary hover:text-error-primary focus-visible:outline-2 focus-visible:outline-offset-1"
                    >
                      <XClose aria-hidden="true" className="size-4" />
                      <span className="visually-hidden">Revoke {invite.email}</span>
                    </button>
                  </ActionForm>
                </div>
              </SettingsRow>
            ))}
          </div>
        </Card>
      ) : null}

      {/* ------------------------------------------------------------------ */}
      {/* Rename                                                              */}
      {/* ------------------------------------------------------------------ */}
      {canManage ? (
        <Card aria-labelledby="rename-heading">
          <Card.Header>
            <Card.Title id="rename-heading">Organization name</Card.Title>
            <Card.Description>
              The URL stays{' '}
              <code className="rounded bg-secondary px-1 py-0.5 text-xs">
                /orgs/{ctx.org.slug}
              </code>{' '}
              so existing links keep working.
            </Card.Description>
          </Card.Header>

          <ActionForm
            action={renameOrganization}
            autosave
            saveHint="Saves automatically"
            className="flex flex-col gap-3"
            aria-label="Rename organization"
          >
            <input type="hidden" name="orgSlug" value={ctx.org.slug} />
            <Label htmlFor="org-name" className="visually-hidden">
              Name
            </Label>
            <Input
              id="org-name"
              name="name"
              required
              minLength={2}
              maxLength={60}
              autoComplete="organization"
              defaultValue={ctx.org.name}
              className="max-w-sm"
            />
          </ActionForm>
        </Card>
      ) : null}

      {/* ------------------------------------------------------------------ */}
      {/* Danger zone                                                         */}
      {/* ------------------------------------------------------------------ */}
      {isOwner ? (
        <DangerZone
          title="Danger zone"
          description={`Deleting the organization removes every workspace, project, and issue in it, for everyone. This cannot be undone.`}
          buttonLabel="Delete this organization..."
        >
          <ActionForm
            action={deleteOrganization}
            className="flex flex-col gap-4"
            aria-label="Delete organization"
          >
            <input type="hidden" name="orgSlug" value={ctx.org.slug} />
            <Field
              htmlFor="org-confirm-name"
              label={`Type ${ctx.org.name} to confirm`}
              className="max-w-sm"
            >
              <Input
                id="org-confirm-name"
                name="confirmName"
                required
                maxLength={200}
                autoComplete="off"
                spellCheck={false}
              />
            </Field>
            <div className="flex flex-wrap items-center gap-2">
              <SubmitButton color="primary-destructive" pendingLabel="Deleting...">
                Delete organization
              </SubmitButton>
            </div>
          </ActionForm>
        </DangerZone>
      ) : null}
    </div>
  );
}
