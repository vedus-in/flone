import Link from 'next/link';
import { Role } from '@prisma/client';
import { ChevronDown } from '@untitledui/icons';
import {
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRoot,
  TableRow,
} from '@/components/table';
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
  Badge,
  Breadcrumbs,
  Card,
  Field,
  Input,
  Label,
  PageHeader,
  SubmitButton,
} from '@/components/ui';
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

/**
 * A native `<select>` wearing Untitled UI's field tokens.
 *
 * Deliberately native rather than Untitled UI's `Select`: React 19 resets a
 * `<form action={fn}>` once the action settles, and `ActionForm`'s restore
 * workaround puts the submitted values back by writing to
 * `form.elements` -- which only reaches real `<select>` elements. A
 * listbox-backed select would keep its own state and silently disagree with
 * whatever the form actually submits.
 */
const SELECT_CLASS =
  'min-h-9 rounded-lg border border-primary bg-primary px-3 py-2 text-sm text-primary shadow-xs outline-focus-ring transition-colors hover:bg-primary_hover focus-visible:outline-2 focus-visible:outline-offset-2';

const NAV_ITEM =
  'rounded-lg px-3 py-1.5 text-sm font-medium outline-none transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring';
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
    <div className="flex flex-col gap-8">
      <div className="flex flex-col gap-5">
        <Breadcrumbs>
          <Breadcrumbs.Item href="/orgs">Organizations</Breadcrumbs.Item>
          <Breadcrumbs.Item href={orgPath(ctx.org)}>{ctx.org.name}</Breadcrumbs.Item>
          <Breadcrumbs.Item>Members &amp; settings</Breadcrumbs.Item>
        </Breadcrumbs>

        <PageHeader
          title="Members & settings"
          description={`${members.length} ${members.length === 1 ? 'person' : 'people'} in ${ctx.org.name}.`}
        >
          <Badge tone="accent">{ctx.role}</Badge>
        </PageHeader>

        <SectionNav org={ctx.org} />
      </div>

      {/* ------------------------------------------------------------------ */}
      {/* Members                                                             */}
      {/* ------------------------------------------------------------------ */}
      <section className="flex flex-col gap-4" aria-labelledby="members-heading">
        <h2 id="members-heading" className="text-sm font-medium text-primary">
          Members
        </h2>

        <div className="w-full overflow-x-auto rounded-xl ring-1 ring-secondary">
          <TableRoot size="sm" aria-label="Members of this organization">
            <TableHeader>
              <TableHead isRowHeader className="w-full">
                Member
              </TableHead>
              <TableHead className="whitespace-nowrap">Role</TableHead>
              {canManage ? (
                <TableHead className="whitespace-nowrap text-end">Manage</TableHead>
              ) : null}
            </TableHeader>

            <TableBody>
              {members.map((member) => {
                const isSelf = member.user.id === ctx.user.id;
                const targetIsOwner = member.role === Role.OWNER;
                // UI politeness only -- the actions re-check every one of these.
                const actionable = canManage && !isSelf && (!targetIsOwner || isOwner);
                const lastOwner = targetIsOwner && ownerCount <= 1;
                const roleFieldId = `role-${member.id}`;

                return (
                  <TableRow key={member.id} id={member.id}>
                    <TableCell>
                      <div className="flex min-w-0 flex-col gap-0.5 py-1">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="font-medium text-primary">
                            {member.user.name}
                          </span>
                          {isSelf ? <Badge>You</Badge> : null}
                        </div>
                        <span className="text-xs text-tertiary">{member.user.email}</span>
                      </div>
                    </TableCell>

                    <TableCell className="whitespace-nowrap align-top">
                      <Badge tone={targetIsOwner ? 'accent' : 'neutral'}>
                        {ROLE_LABEL[member.role]}
                      </Badge>
                    </TableCell>

                    {canManage ? (
                      <TableCell className="align-top">
                        <div className="flex flex-col items-end gap-2">
                          {actionable ? (
                            <div className="flex flex-wrap items-start justify-end gap-2">
                              <ActionForm
                                action={changeMemberRole}
                                className="flex flex-col items-end gap-2"
                                aria-label={`Change role for ${member.user.name}`}
                              >
                                <input
                                  type="hidden"
                                  name="orgSlug"
                                  value={ctx.org.slug}
                                />
                                <input
                                  type="hidden"
                                  name="membershipId"
                                  value={member.id}
                                />
                                <div className="flex items-center gap-2">
                                  <Label htmlFor={roleFieldId} className="visually-hidden">
                                    Role for {member.user.name}
                                  </Label>
                                  <select
                                    id={roleFieldId}
                                    name="role"
                                    defaultValue={member.role}
                                    className={`${SELECT_CLASS} w-32`}
                                  >
                                    {assignableRoles.map((role) => (
                                      <option key={role} value={role}>
                                        {ROLE_LABEL[role]}
                                      </option>
                                    ))}
                                  </select>
                                  <SubmitButton
                                    color="secondary"
                                    size="sm"
                                    pendingLabel="Saving..."
                                  >
                                    Update
                                  </SubmitButton>
                                </div>
                              </ActionForm>

                              <ActionForm
                                action={removeMember}
                                className="flex flex-col items-end gap-2"
                                aria-label={`Remove ${member.user.name}`}
                              >
                                <input
                                  type="hidden"
                                  name="orgSlug"
                                  value={ctx.org.slug}
                                />
                                <input
                                  type="hidden"
                                  name="membershipId"
                                  value={member.id}
                                />
                                <SubmitButton
                                  color="secondary-destructive"
                                  size="sm"
                                  pendingLabel="Removing..."
                                >
                                  Remove
                                </SubmitButton>
                              </ActionForm>
                            </div>
                          ) : (
                            // Short and non-wrapping on purpose. The full
                            // sentence here wrapped inside a narrow, end-aligned
                            // column and stretched every row to several lines.
                            // The reason lives in `title` for anyone who wants it.
                            <span
                              className="text-xs whitespace-nowrap text-tertiary"
                              title={
                                isSelf
                                  ? 'You cannot change your own role or remove yourself.'
                                  : 'Only an owner can change or remove another owner.'
                              }
                            >
                              {isSelf ? 'That is you' : 'Owners only'}
                            </span>
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
                      </TableCell>
                    ) : null}
                  </TableRow>
                );
              })}
            </TableBody>
          </TableRoot>
        </div>

        <dl className="grid gap-2 sm:grid-cols-3">
          {ROLE_ORDER.map((role) => (
            <div
              key={role}
              className="flex flex-col gap-1 rounded-xl border border-secondary px-3 py-2.5"
            >
              <dt className="text-xs font-medium text-primary">{ROLE_LABEL[role]}</dt>
              <dd className="text-xs text-tertiary">{ROLE_HELP[role]}</dd>
            </div>
          ))}
        </dl>
      </section>

      {/* ------------------------------------------------------------------ */}
      {/* Add member                                                          */}
      {/* ------------------------------------------------------------------ */}
      {canManage ? (
        <section aria-labelledby="add-member-heading">
          <Card className="gap-4 p-6">
            <Card.Header>
              <Card.Title id="add-member-heading" className="text-base">
                Add a member
              </Card.Title>
              <Card.Description>
                If they already have an account they are added straight away. If not, we email
                them an invitation that expires in 7 days.
              </Card.Description>
            </Card.Header>

            <ActionForm
              action={addMember}
              className="flex flex-col gap-5"
              resetOnSuccess
              aria-label="Add a member"
            >
              <input type="hidden" name="orgSlug" value={ctx.org.slug} />

              <div className="grid gap-4 sm:grid-cols-[minmax(0,2fr)_minmax(0,1fr)] sm:items-start">
                <Field htmlFor="member-email" label="Email">
                  <Input
                    id="member-email"
                    name="email"
                    type="email"
                    required
                    maxLength={254}
                    autoComplete="email"
                    placeholder="teammate@example.com"
                  />
                </Field>

                <div className="flex flex-col gap-1">
                  <Label htmlFor="member-role">Role</Label>
                  <select
                    id="member-role"
                    name="role"
                    defaultValue={Role.MEMBER}
                    className={`${SELECT_CLASS} w-full`}
                  >
                    <option value={Role.MEMBER}>{ROLE_LABEL.MEMBER}</option>
                    <option value={Role.ADMIN}>{ROLE_LABEL.ADMIN}</option>
                  </select>
                </div>
              </div>

              <div className="flex flex-wrap items-center gap-2">
                <SubmitButton pendingLabel="Adding...">Add member</SubmitButton>
              </div>
            </ActionForm>
          </Card>
        </section>
      ) : null}

      {/* ------------------------------------------------------------------ */}
      {/* Pending invitations                                                 */}
      {/* ------------------------------------------------------------------ */}
      {/*
       * Admins only, and hidden entirely when there are none -- an empty table
       * on every settings page would be pure furniture. These are addresses that
       * have been offered access but do not yet correspond to any account, so
       * they are not part of the member roster above.
       */}
      {canManage && invites.length > 0 ? (
        <section className="flex flex-col gap-4" aria-labelledby="invites-heading">
          <h2 id="invites-heading" className="text-sm font-medium text-primary">
            Pending invitations
          </h2>

          <div className="w-full overflow-x-auto rounded-xl ring-1 ring-secondary">
            <TableRoot size="sm" aria-label="Pending invitations">
              <TableHeader>
                <TableHead isRowHeader className="w-full">
                  Email
                </TableHead>
                <TableHead className="whitespace-nowrap">Role</TableHead>
                <TableHead className="whitespace-nowrap">Expires</TableHead>
                <TableHead className="whitespace-nowrap text-end">Manage</TableHead>
              </TableHeader>

              <TableBody>
                {invites.map((invite) => (
                  <TableRow key={invite.id} id={invite.id}>
                    <TableCell>
                      <span className="text-sm text-primary">{invite.email}</span>
                    </TableCell>

                    <TableCell className="whitespace-nowrap align-top">
                      <Badge tone="neutral">
                        {invite.role ? ROLE_LABEL[invite.role] : ROLE_LABEL.MEMBER}
                      </Badge>
                    </TableCell>

                    <TableCell className="whitespace-nowrap align-top">
                      <span className="text-sm text-tertiary">
                        {invite.expiresAt.toISOString().slice(0, 10)}
                      </span>
                    </TableCell>

                    <TableCell className="align-top">
                      <div className="flex flex-wrap items-start justify-end gap-2">
                        <ActionForm
                          action={resendInvitation}
                          className="flex flex-col items-end gap-2"
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
                          className="flex flex-col items-end gap-2"
                          aria-label={`Revoke the invitation to ${invite.email}`}
                        >
                          <input type="hidden" name="orgSlug" value={ctx.org.slug} />
                          <input type="hidden" name="tokenId" value={invite.id} />
                          <SubmitButton
                            color="secondary-destructive"
                            size="sm"
                            pendingLabel="Revoking..."
                          >
                            Revoke
                          </SubmitButton>
                        </ActionForm>
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </TableRoot>
          </div>
        </section>
      ) : null}

      {/* ------------------------------------------------------------------ */}
      {/* Rename                                                              */}
      {/* ------------------------------------------------------------------ */}
      {canManage ? (
        <section aria-labelledby="rename-heading">
          <Card className="gap-4 p-6">
            <Card.Header>
              <Card.Title id="rename-heading" className="text-base">
                Organization name
              </Card.Title>
              <Card.Description>
                The URL stays /orgs/{ctx.org.slug} so existing links keep working.
              </Card.Description>
            </Card.Header>

            <ActionForm
              action={renameOrganization}
              className="flex flex-col gap-4"
              aria-label="Rename organization"
            >
              <input type="hidden" name="orgSlug" value={ctx.org.slug} />
              <Field htmlFor="org-name" label="Name" className="max-w-md">
                <Input
                  id="org-name"
                  name="name"
                  required
                  minLength={2}
                  maxLength={60}
                  autoComplete="organization"
                  defaultValue={ctx.org.name}
                />
              </Field>
              <div className="flex flex-wrap items-center gap-2">
                <SubmitButton color="secondary">Save name</SubmitButton>
              </div>
            </ActionForm>
          </Card>
        </section>
      ) : null}

      {/* ------------------------------------------------------------------ */}
      {/* Danger zone                                                         */}
      {/* ------------------------------------------------------------------ */}
      {isOwner ? (
        <section aria-labelledby="danger-heading">
          <Card className="gap-0 p-0 ring-error_subtle">
            <details className="group">
              <summary
                id="danger-heading"
                className="flex cursor-pointer list-none items-center justify-between gap-3 rounded-xl px-6 py-4 text-sm font-medium text-error-primary"
              >
                Delete this organization
                <ChevronDown
                  aria-hidden="true"
                  className="size-4 transition-transform duration-100 group-open:rotate-180"
                />
              </summary>
              <div className="flex flex-col gap-4 px-6 pb-6">
                <p className="max-w-prose text-sm text-tertiary">
                  Every project, board, ticket and comment in {ctx.org.name} is deleted
                  permanently. This cannot be undone.
                </p>
                <ActionForm
                  action={deleteOrganization}
                  className="flex flex-col gap-4"
                  aria-label="Delete organization"
                >
                  <input type="hidden" name="orgSlug" value={ctx.org.slug} />
                  <Field
                    htmlFor="org-confirm-name"
                    label={`Type ${ctx.org.name} to confirm`}
                    className="max-w-md"
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
              </div>
            </details>
          </Card>
        </section>
      ) : null}
    </div>
  );
}
