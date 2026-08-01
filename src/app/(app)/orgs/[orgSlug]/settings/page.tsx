import Link from 'next/link';
import { Role } from '@prisma/client';
import { Breadcrumbs } from '@heroui/react/breadcrumbs';
import { Card } from '@heroui/react/card';
import { Disclosure } from '@heroui/react/disclosure';
import { Table } from '@heroui/react/table';
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
  Input,
  Label,
  PageHeader,
  SubmitButton,
  TextField,
} from '@/components/ui';
import { ActionForm } from '../../../action-form';
import {
  addMember,
  changeMemberRole,
  deleteOrganization,
  removeMember,
  renameOrganization,
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
 * A native `<select>` wearing HeroUI's field tokens.
 *
 * Deliberately native rather than HeroUI's `Select`: React 19 resets a
 * `<form action={fn}>` once the action settles, and `ActionForm`'s restore
 * workaround puts the submitted values back by writing to
 * `form.elements` -- which only reaches real `<select>` elements. A
 * listbox-backed select would keep its own state and silently disagree with
 * whatever the form actually submits.
 */
const SELECT_CLASS =
  'min-h-9 rounded-field border border-field-border bg-field px-3 py-2 text-sm text-field-foreground shadow-field outline-none transition-colors hover:bg-field-hover focus-visible:focus-field-ring';

const NAV_ITEM =
  'rounded-lg px-3 py-1.5 text-sm font-medium outline-none transition-colors focus-visible:focus-ring';
const NAV_ON = 'bg-surface text-foreground shadow-surface';
const NAV_OFF = 'text-muted hover:text-foreground';

function SectionNav({ org }: { org: OrgRef }) {
  return (
    <nav
      aria-label="Organization sections"
      className="flex w-fit items-center gap-1 rounded-xl bg-surface-secondary p-1"
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
  const isOwner = ctx.role === Role.OWNER;
  const ownerCount = members.filter((member) => member.role === Role.OWNER).length;
  const assignableRoles: Role[] = isOwner
    ? [Role.OWNER, Role.ADMIN, Role.MEMBER]
    : [Role.ADMIN, Role.MEMBER];

  return (
    <div className="flex flex-col gap-8">
      <div className="flex flex-col gap-5">
        <Breadcrumbs>
          <Breadcrumbs.Item href="/">Organizations</Breadcrumbs.Item>
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
        <h2 id="members-heading" className="text-sm font-medium text-foreground">
          Members
        </h2>

        <Table variant="secondary">
          <Table.ScrollContainer>
            <Table.Content aria-label="Members of this organization">
              <Table.Header>
                <Table.Column isRowHeader className="w-full">
                  Member
                </Table.Column>
                <Table.Column className="whitespace-nowrap">Role</Table.Column>
                {canManage ? (
                  <Table.Column className="whitespace-nowrap text-end">Manage</Table.Column>
                ) : null}
              </Table.Header>

              <Table.Body>
                {members.map((member) => {
                  const isSelf = member.user.id === ctx.user.id;
                  const targetIsOwner = member.role === Role.OWNER;
                  // UI politeness only -- the actions re-check every one of these.
                  const actionable = canManage && !isSelf && (!targetIsOwner || isOwner);
                  const lastOwner = targetIsOwner && ownerCount <= 1;
                  const roleFieldId = `role-${member.id}`;

                  return (
                    <Table.Row key={member.id} id={member.id}>
                      <Table.Cell>
                        <div className="flex min-w-0 flex-col gap-0.5 py-1">
                          <div className="flex flex-wrap items-center gap-2">
                            <span className="font-medium text-foreground">
                              {member.user.name}
                            </span>
                            {isSelf ? <Badge>You</Badge> : null}
                          </div>
                          <span className="text-xs text-muted">{member.user.email}</span>
                        </div>
                      </Table.Cell>

                      <Table.Cell className="whitespace-nowrap align-top">
                        <Badge tone={targetIsOwner ? 'accent' : 'neutral'}>
                          {ROLE_LABEL[member.role]}
                        </Badge>
                      </Table.Cell>

                      {canManage ? (
                        <Table.Cell className="align-top">
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
                                      variant="secondary"
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
                                    variant="danger-soft"
                                    size="sm"
                                    pendingLabel="Removing..."
                                  >
                                    Remove
                                  </SubmitButton>
                                </ActionForm>
                              </div>
                            ) : (
                              <p className="max-w-[28ch] text-end text-xs text-muted">
                                {isSelf
                                  ? 'You cannot change your own role or remove yourself.'
                                  : 'Only an owner can act on an owner.'}
                              </p>
                            )}

                            {lastOwner ? (
                              <p className="max-w-[32ch] text-end text-xs text-muted">
                                The only owner. An organization must always have at least one.
                              </p>
                            ) : null}
                          </div>
                        </Table.Cell>
                      ) : null}
                    </Table.Row>
                  );
                })}
              </Table.Body>
            </Table.Content>
          </Table.ScrollContainer>
        </Table>

        <dl className="grid gap-2 sm:grid-cols-3">
          {ROLE_ORDER.map((role) => (
            <div
              key={role}
              className="flex flex-col gap-1 rounded-xl border border-border px-3 py-2.5"
            >
              <dt className="text-xs font-medium text-foreground">{ROLE_LABEL[role]}</dt>
              <dd className="text-xs text-muted">{ROLE_HELP[role]}</dd>
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
                The person needs an account already. There is no invitation email.
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
                <TextField
                  isRequired
                  type="email"
                  maxLength={254}
                  autoComplete="email"
                  fullWidth
                >
                  <Label>Email</Label>
                  <Input name="email" placeholder="teammate@example.com" />
                </TextField>

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
              {/* HeroUI v3: `defaultValue` belongs on TextField, `name` on Input. */}
              <TextField
                isRequired
                minLength={2}
                maxLength={60}
                autoComplete="organization"
                defaultValue={ctx.org.name}
                fullWidth
                className="max-w-md"
              >
                <Label>Name</Label>
                <Input name="name" />
              </TextField>
              <div className="flex flex-wrap items-center gap-2">
                <SubmitButton variant="secondary">Save name</SubmitButton>
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
          <Card className="gap-0 border border-danger/25 p-0">
            <Disclosure>
              <Disclosure.Heading level={2} id="danger-heading">
                <Disclosure.Trigger className="flex w-full items-center justify-between gap-3 rounded-2xl px-6 py-4 text-sm font-medium text-danger">
                  Delete this organization
                  <Disclosure.Indicator />
                </Disclosure.Trigger>
              </Disclosure.Heading>
              <Disclosure.Content>
                <div className="flex flex-col gap-4 px-6 pb-6">
                  <p className="max-w-prose text-sm text-muted">
                    Every project, board, ticket and comment in {ctx.org.name} is deleted
                    permanently. This cannot be undone.
                  </p>
                  <ActionForm
                    action={deleteOrganization}
                    className="flex flex-col gap-4"
                    aria-label="Delete organization"
                  >
                    <input type="hidden" name="orgSlug" value={ctx.org.slug} />
                    <TextField
                      isRequired
                      maxLength={200}
                      autoComplete="off"
                      fullWidth
                      className="max-w-md"
                    >
                      <Label>Type {ctx.org.name} to confirm</Label>
                      <Input name="confirmName" spellCheck={false} />
                    </TextField>
                    <div className="flex flex-wrap items-center gap-2">
                      <SubmitButton variant="danger" pendingLabel="Deleting...">
                        Delete organization
                      </SubmitButton>
                    </div>
                  </ActionForm>
                </div>
              </Disclosure.Content>
            </Disclosure>
          </Card>
        </section>
      ) : null}
    </div>
  );
}
