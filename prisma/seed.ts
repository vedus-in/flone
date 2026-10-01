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
 */
import { EmailTokenPurpose, PrismaClient, ProjectAccess, Role } from '@prisma/client';
import crypto from 'node:crypto';

// `model.ts` is deliberately not `server-only` and free of path aliases, for
// exactly this: `scripts/check-model.ts` already imports it straight from Node.
// Taking the states and the stamping rule from it rather than restating them
// is the difference between seed data the app could have written and seed data
// that merely looks like it.
import { DEFAULT_STATES, stampsFor } from '../src/lib/model.ts';

/**
 * Loopback only, enforced rather than asked for.
 *
 * This script writes accounts whose password is a constant three lines below
 * and resets the role on every membership it touches. `.env` points at whatever
 * the last person connected to, so "don't run this against staging" is a rule
 * that gets broken by a shell that was already open -- and the failure is a set
 * of real-looking accounts anyone who read this file can sign into.
 *
 * No override flag on purpose: a seed that can be pointed somewhere else is one
 * that eventually is. Seeding a non-local database means editing this list and
 * owning that edit.
 */
const LOCAL_HOSTS = [
  'localhost',
  '127.0.0.1',
  '::1',
  // No host at all, as in `postgresql:///flone` -- a Unix socket, which cannot
  // reach another machine. Not an oversight; do not drop it.
  '',
];

function assertLocalDatabase(): void {
  if (process.env.NODE_ENV === 'production') {
    throw new Error('Refusing to seed with NODE_ENV=production.');
  }
  const raw = process.env.DATABASE_URL;
  if (!raw) throw new Error('DATABASE_URL is not set.');

  let host: string;
  try {
    // Brackets survive URL parsing for IPv6; strip them before comparing.
    host = new URL(raw).hostname.replace(/^\[|\]$/g, '');
  } catch {
    throw new Error('DATABASE_URL is not a URL this script can check. Refusing to seed.');
  }
  if (!LOCAL_HOSTS.includes(host)) {
    throw new Error(
      `Refusing to seed "${host}": local databases only. This script writes a known password.`,
    );
  }
}

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

/**
 * The password is rewritten on every run, not just on create.
 *
 * Skipping the hash for a row that already exists is the cheaper branch -- and
 * it means a seeded account whose password was since changed keeps the old one
 * while the banner below still prints the constant. A seed script whose closing
 * line is wrong about how to sign in has failed at its only job, and ~250ms per
 * user is not worth that.
 */
async function upsertUser(email: string, name: string) {
  const passwordHash = await hashPassword(PASSWORD);
  return prisma.user.upsert({
    where: { email },
    update: { name, passwordHash, emailVerified: new Date() },
    create: { email, name, passwordHash, emailVerified: new Date() },
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
            // The same rule the real write path uses, not a restatement of it,
            // so these rows stay ones the app could have written if the slice
            // above ever widens. The cycle burndown reads these two columns.
            ...stampsFor(state.type, { startedAt: null, completedAt: null }),
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

assertLocalDatabase();

main()
  .then(() => prisma.$disconnect())
  .catch(async (error) => {
    console.error(error);
    await prisma.$disconnect();
    process.exit(1);
  });
