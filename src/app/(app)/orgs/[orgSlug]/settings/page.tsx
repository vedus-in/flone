import Link from 'next/link';
import { Role } from '@prisma/client';
import { prisma } from '@/lib/db';
import { atLeast, loadPage, orgPath, orgSettingsPath, requireOrgBySlug } from '@/lib/authz';
import { Badge, Card, Field, Input, SubmitButton } from '@/components/ui';
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
    <>
      <nav className="breadcrumb" aria-label="Breadcrumb">
        <Link href="/">Organizations</Link>
        <span className="sep">/</span>
        <Link href={orgPath(ctx.org)}>{ctx.org.name}</Link>
        <span className="sep">/</span>
        <span aria-current="page">Members &amp; settings</span>
      </nav>

      <div className="page-head">
        <div className="stack-sm">
          <h1>Members &amp; settings</h1>
          <p className="muted">
            {members.length} {members.length === 1 ? 'person' : 'people'} in {ctx.org.name}.
          </p>
        </div>
        <Badge tone="accent">{ctx.role}</Badge>
      </div>

      <nav className="tabs" aria-label="Organization sections">
        <Link className="tab" href={orgPath(ctx.org)}>
          Projects
        </Link>
        <Link className="tab" aria-current="page" href={orgSettingsPath(ctx.org)}>
          Members &amp; settings
        </Link>
      </nav>

      <div className="stack">
        {/* ---------------------------------------------------------------- */}
        {/* Members                                                           */}
        {/* ---------------------------------------------------------------- */}
        <section className="stack" aria-labelledby="members-heading">
          <h2 id="members-heading">Members</h2>

          {members.map((member) => {
            const isSelf = member.user.id === ctx.user.id;
            const targetIsOwner = member.role === Role.OWNER;
            // UI politeness only -- the actions re-check every one of these.
            const actionable = canManage && !isSelf && (!targetIsOwner || isOwner);
            const lastOwner = targetIsOwner && ownerCount <= 1;

            return (
              <Card key={member.id} tight className="stack-sm">
                <div className="row">
                  <strong>{member.user.name}</strong>
                  <Badge tone={targetIsOwner ? 'accent' : 'neutral'}>
                    {ROLE_LABEL[member.role]}
                  </Badge>
                  {isSelf ? <Badge>You</Badge> : null}
                  <span className="spacer" />
                  <span className="faint">{member.user.email}</span>
                </div>

                {actionable ? (
                  <div className="row">
                    <ActionForm
                      action={changeMemberRole}
                      className="stack-sm"
                      aria-label={`Change role for ${member.user.name}`}
                    >
                      <input type="hidden" name="orgSlug" value={ctx.org.slug} />
                      <input type="hidden" name="membershipId" value={member.id} />
                      <div className="row">
                        <div className="field">
                          <label className="visually-hidden" htmlFor={`role-${member.id}`}>
                            Role for {member.user.name}
                          </label>
                          <select
                            className="select"
                            id={`role-${member.id}`}
                            name="role"
                            defaultValue={member.role}
                          >
                            {assignableRoles.map((role) => (
                              <option key={role} value={role}>
                                {ROLE_LABEL[role]}
                              </option>
                            ))}
                          </select>
                        </div>
                        <SubmitButton variant="secondary" size="sm" pendingLabel="Saving...">
                          Update role
                        </SubmitButton>
                      </div>
                    </ActionForm>

                    <ActionForm
                      action={removeMember}
                      className="stack-sm"
                      aria-label={`Remove ${member.user.name}`}
                    >
                      <input type="hidden" name="orgSlug" value={ctx.org.slug} />
                      <input type="hidden" name="membershipId" value={member.id} />
                      <SubmitButton variant="danger" size="sm" pendingLabel="Removing...">
                        Remove
                      </SubmitButton>
                    </ActionForm>
                  </div>
                ) : (
                  <p className="faint">
                    {isSelf
                      ? 'You cannot change your own role or remove yourself.'
                      : canManage
                        ? 'Only an owner can act on an owner.'
                        : ROLE_HELP[member.role]}
                  </p>
                )}

                {lastOwner ? (
                  <p className="faint">
                    This is the only owner. An organization must always have at least one.
                  </p>
                ) : null}
              </Card>
            );
          })}
        </section>

        {/* ---------------------------------------------------------------- */}
        {/* Add member                                                        */}
        {/* ---------------------------------------------------------------- */}
        {canManage ? (
          <section aria-labelledby="add-member-heading">
            <Card className="stack">
              <h2 id="add-member-heading">Add a member</h2>
              <p className="muted">
                The person needs an account already. There is no invitation email.
              </p>

              <ActionForm
                action={addMember}
                className="stack"
                resetOnSuccess
                aria-label="Add a member"
              >
                <input type="hidden" name="orgSlug" value={ctx.org.slug} />

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

                <div className="field">
                  <label className="label" htmlFor="member-role">
                    Role
                  </label>
                  <select className="select" id="member-role" name="role" defaultValue={Role.MEMBER}>
                    <option value={Role.MEMBER}>{ROLE_LABEL.MEMBER}</option>
                    <option value={Role.ADMIN}>{ROLE_LABEL.ADMIN}</option>
                  </select>
                  <span className="hint">{ROLE_HELP.MEMBER}</span>
                </div>

                <div className="row">
                  <SubmitButton pendingLabel="Adding...">Add member</SubmitButton>
                </div>
              </ActionForm>
            </Card>
          </section>
        ) : null}

        {/* ---------------------------------------------------------------- */}
        {/* Rename                                                            */}
        {/* ---------------------------------------------------------------- */}
        {canManage ? (
          <section aria-labelledby="rename-heading">
            <Card className="stack">
              <h2 id="rename-heading">Organization name</h2>
              <ActionForm
                action={renameOrganization}
                className="stack"
                aria-label="Rename organization"
              >
                <input type="hidden" name="orgSlug" value={ctx.org.slug} />
                <Field
                  htmlFor="org-name"
                  label="Name"
                  hint={`The URL stays /orgs/${ctx.org.slug} so existing links keep working.`}
                >
                  <Input
                    id="org-name"
                    name="name"
                    required
                    minLength={2}
                    maxLength={60}
                    defaultValue={ctx.org.name}
                    autoComplete="organization"
                  />
                </Field>
                <div className="row">
                  <SubmitButton variant="secondary">Save name</SubmitButton>
                </div>
              </ActionForm>
            </Card>
          </section>
        ) : null}

        {/* ---------------------------------------------------------------- */}
        {/* Danger zone                                                       */}
        {/* ---------------------------------------------------------------- */}
        {isOwner ? (
          <section aria-labelledby="danger-heading">
            <Card className="stack danger-zone">
              <h2 id="danger-heading">Delete this organization</h2>
              <p className="muted">
                Every project, board, ticket and comment in {ctx.org.name} is deleted
                permanently. This cannot be undone.
              </p>
              <ActionForm
                action={deleteOrganization}
                className="stack"
                aria-label="Delete organization"
              >
                <input type="hidden" name="orgSlug" value={ctx.org.slug} />
                <Field htmlFor="confirm-name" label={`Type "${ctx.org.name}" to confirm`}>
                  <Input
                    id="confirm-name"
                    name="confirmName"
                    required
                    maxLength={200}
                    autoComplete="off"
                  />
                </Field>
                <div className="row">
                  <SubmitButton variant="danger" pendingLabel="Deleting...">
                    Delete organization
                  </SubmitButton>
                </div>
              </ActionForm>
            </Card>
          </section>
        ) : null}
      </div>
    </>
  );
}
