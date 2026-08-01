import 'server-only';
import { PrismaClient } from '@prisma/client';

/**
 * SPEC §5 — PrismaClient singleton.
 *
 * `log` is fixed at `['error', 'warn']` and must NEVER include `'query'`
 * (SPEC §4.7 / §9): the query event payload carries bound parameters, i.e. every
 * email address the app has ever looked up.
 *
 * In development Next's HMR re-evaluates modules on every edit; without the
 * global cache that leaks a connection pool per reload until Postgres refuses
 * new connections.
 */
const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

export const prisma: PrismaClient =
  globalForPrisma.prisma ??
  new PrismaClient({
    log: ['error', 'warn'],
  });

if (process.env.NODE_ENV !== 'production') {
  globalForPrisma.prisma = prisma;
}
