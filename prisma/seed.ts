/**
 * A local database with enough in it to open every page.
 *
 * KANB-16 sat unverified through two rounds of review for one reason: the
 * settings pages 500 without a database, so nobody could look at them. `bun run
 * db:seed` is the missing half of `bun run db:migrate` -- it puts an
 * organization, a workspace, two projects, four members and a pending
 * invitation in front of you, which between them light up every branch those
 * pages have: a last owner, somebody who is not you, a role you may change and
 * one you may not, a private project in the access column, a workflow state
 * holding issues and one holding none.
 *
 * Idempotent, so running it twice is the same as running it once.
 *
 * NEVER point this at anything but a local database. It writes a known password.
 */
import { EmailTokenPurpose, PrismaClient, ProjectAccess, Role } from '@prisma/client';
import crypto from 'node:crypto';

const prisma = new PrismaClient();

/** The one credential, printed at the end. Local only, hence a constant. */
const PASSWORD = 'correct horse battery staple';

/**
 * scrypt with the parameters `src/lib/password.ts` encodes, inlined rather than
 * imported: that module is `server-only` and throws outside a React server
 * module graph, which is where a seed script runs.
 */
function hashPassword(plain: string): Promise<string> {
  const N = 2 ** 16;
  const R = 8;
  const P = 1;
  const KEYLEN = 64;
  const salt = crypto.randomBytes(16);
  return new Promise((resolve, reject) =>
    crypto.scrypt(
      plain.normalize('NFKC'),
      salt,
      KEYLEN,
      { N, r: R, p: P, maxmem: 128 * N * R * 2 },
      (err, key) =>
        err
          ? reject(err)
          : resolve(
              ['scrypt', N, R, P, salt.toString('base64'), key.toString('base64')].join('$'),
            ),
    ),
  );
}

/** Mirrors `DEFAULT_STATES` in `src/lib/model.ts`, which is also server-only. */
const DEFAULT_STATES = [
  { name: 'Backlog', type: 'BACKLOG', color: 'gray', position: 0 },
  { name: 'Todo', type: 'UNSTARTED', color: 'gray', position: 1 },
  { name: 'In Progress', type: 'STARTED', color: 'warning', position: 2 },
  { name: 'In Review', type: 'STARTED', color: 'brand', position: 3 },
  { name: 'Done', type: 'COMPLETED', color: 'success', position: 4 },
  { name: 'Canceled', type: 'CANCELED', color: 'gray', position: 5 },
] as const;

async function upsertUser(email: string, name: string) {
  // The hash is only computed for a new row: scrypt at these parameters costs
  // ~250ms, and re-seeding should not spend a second re-hashing the same string.
  const existing = await prisma.user.findUnique({ where: { email }, select: { id: true } });
  if (existing) {
    return prisma.user.update({
      where: { email },
      data: { name, emailVerified: new Date() },
    });
  }
  return prisma.user.create({
    data: { email, name, passwordHash: await hashPassword(PASSWORD), emailVerified: new Date() },
  });
}

async function main() {
  const owner = await upsertUser('owner@example.com', 'Ada Okonkwo');
  const admin = await upsertUser('admin@example.com', 'Suraj Pal');
  const member = await upsertUser('member@example.com', 'Devansh Rao');
  const outsider = await upsertUser('member2@example.com', 'Mia Lindqvist');

  const org = await prisma.organization.upsert({
    where: { slug: 'acme' },
    update: {},
    create: { name: 'Acme', slug: 'acme' },
  });

  const roles = [
    [owner, Role.OWNER],
    [admin, Role.ADMIN],
    [member, Role.MEMBER],
    [outsider, Role.MEMBER],
  ] as const;
  for (const [user, role] of roles) {
    await prisma.membership.upsert({
      where: { userId_organizationId: { userId: user.id, organizationId: org.id } },
      update: { role },
      create: { userId: user.id, organizationId: org.id, role },
    });
  }

  const workspace = await prisma.workspace.upsert({
    where: { organizationId_slug: { organizationId: org.id, slug: 'general' } },
    update: {},
    create: { organizationId: org.id, slug: 'general', name: 'General', position: 0 },
  });

  const project =
    (await prisma.project.findFirst({ where: { organizationId: org.id, key: 'ENG' } })) ??
    (await prisma.project.create({
      data: {
        organizationId: org.id,
        workspaceId: workspace.id,
        key: 'ENG',
        name: 'Engineering',
        description: 'The main project.',
        states: { create: DEFAULT_STATES.map((state) => ({ ...state })) },
      },
    }));

  // Private, and `outsider` is the only one named on it -- so the org settings
  // roster has a "Private access" line to render for exactly one person.
  if (!(await prisma.project.findFirst({ where: { organizationId: org.id, key: 'SEC' } }))) {
    await prisma.project.create({
      data: {
        organizationId: org.id,
        workspaceId: workspace.id,
        key: 'SEC',
        name: 'Security Review',
        access: ProjectAccess.PRIVATE,
        states: { create: DEFAULT_STATES.map((state) => ({ ...state })) },
        members: { create: [{ userId: outsider.id }] },
      },
    });
  }

  await prisma.label.createMany({
    data: [
      { projectId: project.id, name: 'bug', color: 'error' },
      { projectId: project.id, name: 'ui', color: 'brand' },
      { projectId: project.id, name: 'chore', color: 'gray' },
    ],
    skipDuplicates: true,
  });

  const board =
    (await prisma.board.findFirst({ where: { projectId: project.id } })) ??
    (await prisma.board.create({ data: { projectId: project.id, name: 'Main' } }));

  // Issues in the first four states only, so the workflow rows show both a
  // state that holds work and one that does not -- the two render differently.
  if ((await prisma.ticket.count({ where: { projectId: project.id } })) === 0) {
    const states = await prisma.workflowState.findMany({
      where: { projectId: project.id },
      orderBy: { position: 'asc' },
    });
    let number = 1;
    for (const state of states.slice(0, 4)) {
      for (let i = 0; i < 2; i++) {
        await prisma.ticket.create({
          data: {
            projectId: project.id,
            boardId: board.id,
            stateId: state.id,
            number,
            title: `Seeded issue ${number} in ${state.name}`,
            position: i,
            createdById: owner.id,
          },
        });
        number++;
      }
    }
  }

  // A pending invitation, so the roster has one to render. The hash is of a
  // fixed string: the link is never clicked, the row only has to exist.
  const tokenHash = crypto.createHash('sha256').update('seed-invite-token').digest('hex');
  const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
  await prisma.emailToken.upsert({
    where: { tokenHash },
    update: { usedAt: null, expiresAt },
    create: {
      tokenHash,
      purpose: EmailTokenPurpose.INVITE,
      email: 'newcomer@example.com',
      organizationId: org.id,
      role: Role.MEMBER,
      invitedById: owner.id,
      expiresAt,
    },
  });

  console.log(`
Seeded.

  sign in            owner@example.com   (also admin@ / member@ / member2@)
  password           ${PASSWORD}

  org settings       /orgs/acme/settings
  project settings   /orgs/acme/general/ENG/settings
`);
}

main()
  .then(() => prisma.$disconnect())
  .catch(async (error) => {
    console.error(error);
    await prisma.$disconnect();
    process.exit(1);
  });
