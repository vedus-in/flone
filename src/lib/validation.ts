import 'server-only';
import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import { Role } from '@prisma/client';

/**
 * SPEC 4.5 + 4.10 -- shared validation primitives.
 *
 * Every Server Action re-parses its input with zod, without exception. These are
 * the shared building blocks so two actions can never disagree about what a
 * valid email, slug or title is.
 */

/* -------------------------------------------------------------------------- */
/* Constants                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Organization slugs live under `/orgs/`, so the only static sibling a slug
 * could shadow is `new`. The rest are defence in depth against future routes and
 * against slugs that look like infrastructure.
 */
export const RESERVED_SLUGS = new Set([
  'new',
  'orgs',
  'login',
  'register',
  'api',
  'admin',
  'settings',
  'static',
  '_next',
  'favicon.ico',
  'robots.txt',
  'sitemap.xml',
  'health',
]);

/** Every board is seeded with exactly these three columns. Column CRUD is cut. */
export const DEFAULT_COLUMNS = [
  { name: 'To Do', position: 0 },
  { name: 'In Progress', position: 1 },
  { name: 'Done', position: 2 },
] as const;

/**
 * Canonical read order everywhere (SPEC 6.10). Duplicate positions therefore
 * degrade to a stable, deterministic order rather than a rendering bug.
 */
export const TICKET_ORDER = [
  { position: 'asc' as const },
  { createdAt: 'asc' as const },
  { id: 'asc' as const },
];

/** Columns use the same scheme; the seeded three are fixed at 0, 1, 2. */
export const COLUMN_ORDER = [{ position: 'asc' as const }, { id: 'asc' as const }];

/* -------------------------------------------------------------------------- */
/* Text primitives                                                             */
/* -------------------------------------------------------------------------- */

const CHAR_LF = 10;
const CHAR_SPACE = 32;
const CHAR_DEL = 127;

/**
 * True when the string contains a C0 control character or DEL.
 *
 * Written as a scan rather than a regex literal so the source file stays pure
 * ASCII and no editor or tool can mangle the escape sequences.
 *
 * This is load-bearing, not cosmetic: Postgres `text` cannot store a NUL byte,
 * so a NUL reaching Prisma throws and produces a user-controlled 500 with an
 * error digest.
 */
function hasControlChars(value: string, allowNewline: boolean): boolean {
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (allowNewline && code === CHAR_LF) continue;
    if (code < CHAR_SPACE || code === CHAR_DEL) return true;
  }
  return false;
}

const NOT_ALLOWED = 'Contains characters that are not allowed.';

/** Single-line text. Tabs and newlines are rejected along with every other control char. */
export const safeText = (min: number, max: number) =>
  z
    .string()
    .trim()
    .min(min)
    .max(max)
    .refine((s) => !hasControlChars(s, false), NOT_ALLOWED);

/** Multi-line text. Normalizes CRLF to LF first, then bans every control char except LF. */
export const safeMultiline = (min: number, max: number) =>
  z
    .string()
    .transform((s) => s.replace(/\r\n/g, '\n'))
    .pipe(
      z
        .string()
        .trim()
        .min(min)
        .max(max)
        .refine((s) => !hasControlChars(s, true), NOT_ALLOWED),
    );

/* -------------------------------------------------------------------------- */
/* Identity primitives                                                         */
/* -------------------------------------------------------------------------- */

export const cuid = z.string().cuid();

/**
 * `.max()` sits BEFORE the transforms so a 10 MB string is rejected before any
 * work is done on it. Used identically by register and login so casing can never
 * fork an account. Do not strip dots or `+tags`, and do not NFKC an address.
 */
export const emailSchema = z.string().max(254).trim().toLowerCase().pipe(z.string().email());

/** Never `.trim()` a password. NFKC happens inside hashPassword/verifyPassword only. */
export const passwordSchema = z.string().min(12).max(200);

/** Login accepts any non-empty password so a short one still fails as a credential error. */
export const loginPasswordSchema = z.string().min(1).max(200);

export const slugSchema = z
  .string()
  .trim()
  .toLowerCase()
  .regex(
    /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])$/,
    'Use 2 to 40 lowercase letters, numbers or dashes.',
  )
  .refine((s) => !RESERVED_SLUGS.has(s), 'That URL is not available.');

export const projectKeySchema = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[A-Z][A-Z0-9]{1,9}$/, 'Use 2 to 10 characters: a letter followed by letters or digits.');

/**
 * Bounded to INT4 because `Ticket.number` is a Postgres `Int`. Without the
 * `.max()`, a crafted path segment like `/.../9999999999` parses fine here and
 * only fails inside the query engine (Prisma P2033), turning what should be a
 * 404 into a 500.
 */
export const ticketNumberSchema = z.coerce.number().int().positive().max(2147483647);

export const roleSchema = z.nativeEnum(Role);

/** The roles an ADMIN is allowed to hand out. Granting OWNER is OWNER-only. */
export const assignableRoleSchema = z.enum(['ADMIN', 'MEMBER']);

/* -------------------------------------------------------------------------- */
/* Named length caps (SPEC 4.10, final)                                        */
/* -------------------------------------------------------------------------- */

export const userNameSchema = safeText(1, 80);
export const orgNameSchema = safeText(2, 60);
export const projectNameSchema = safeText(1, 80);
export const projectDescriptionSchema = safeMultiline(0, 2000);
export const boardNameSchema = safeText(1, 80);
export const ticketTitleSchema = safeText(1, 200);
export const ticketDescriptionSchema = safeMultiline(0, 10000);
export const commentBodySchema = safeMultiline(1, 5000);

/* -------------------------------------------------------------------------- */
/* Derivation helpers                                                          */
/* -------------------------------------------------------------------------- */

/** Strips the combining marks that NFKD decomposition leaves behind. */
function stripDiacritics(input: string): string {
  return input.normalize('NFKD').replace(/\p{M}/gu, '');
}

/** Lowercase, `[a-z0-9-]`, collapsed dashes, at most 40 chars, fallback `'org'`. */
export function slugify(input: string): string {
  const base = stripDiacritics(input)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/g, '');
  return base.length >= 2 && !RESERVED_SLUGS.has(base) ? base : 'org';
}

/**
 * Four random base36 characters. An incrementing `-2` / `-3` suffix is
 * forbidden: it turns the global slug index into an enumeration oracle for other
 * tenants' organization names (SPEC 7.14).
 */
export function randomSlugSuffix(): string {
  let out = '';
  for (const byte of randomBytes(4)) out += (byte % 36).toString(36);
  return out;
}

/** First 3-4 alphanumerics of the name, uppercased, starting at a letter. */
export function deriveProjectKey(name: string): string {
  const cleaned = stripDiacritics(name)
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '');
  const firstLetter = cleaned.search(/[A-Z]/);
  const usable = firstLetter === -1 ? '' : cleaned.slice(firstLetter);
  const candidate = usable.slice(0, 4);
  return candidate.length >= 2 ? candidate : 'PROJ';
}
