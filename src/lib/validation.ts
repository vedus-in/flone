import 'server-only';
import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import { BoardStatus, ReminderRepeat, Role, WorkflowStateType } from '@prisma/client';
import { COLOR_TOKENS, ISSUE_TABS } from '@/lib/model';
import { MAX_TZ_OFFSET_MINUTES, toInstant } from '@/lib/reminder-math';

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
 * Shared by organization slugs (under `/orgs/`) and workspace slugs (under
 * `/orgs/[orgSlug]/`). An org slug's only static sibling is `new`; a workspace
 * slug's are `settings`, `go`, `challenges` and `reminders`. Both sets are
 * frozen and both are covered here, which is what keeps the denylist provably
 * complete rather than aspirational (SPEC 7.1). The rest are defence in depth
 * against future routes and against slugs that look like infrastructure.
 */
export const RESERVED_SLUGS = new Set([
  'new',
  'orgs',
  'login',
  'register',
  'api',
  'admin',
  'settings',
  /** The per-person board at `/orgs/[orgSlug]/challenges`. */
  'challenges',
  /** Scheduled email reminders at `/orgs/[orgSlug]/reminders`. */
  'reminders',
  /** The legacy-project-URL trampoline at `/orgs/[orgSlug]/go/...`. */
  'go',
  'static',
  '_next',
  'favicon.ico',
  'robots.txt',
  'sitemap.xml',
  'health',
]);

/**
 * The workspace every organization is created with, and the one the workspace
 * migration backfilled every pre-existing project into. Nothing depends on a
 * workspace with this slug existing later -- it can be renamed or deleted like
 * any other.
 */
export const DEFAULT_WORKSPACE = { name: 'General', slug: 'general' } as const;

/**
 * The issue model's vocabulary lives in `@/lib/model`, which is import-free
 * enough for client modules and the check script to share it. Re-exported here
 * so server call sites keep one import site.
 */
export {
  COLOR_TOKENS,
  DEFAULT_STATES,
  ISSUE_TABS,
  PRIORITY_LABEL,
  PRIORITY_ORDER,
  STATE_GROUP_RANK,
  TAB_LABEL,
  TAB_STATE_TYPES,
  inferStateType,
  isAbandoned,
  isDone,
  isOpen,
  sortStatesForBoard,
  sortStatesForList,
  type ColorToken,
  type IssueTab,
} from '@/lib/model';

/**
 * Canonical read order everywhere (SPEC 6.10). Duplicate positions therefore
 * degrade to a stable, deterministic order rather than a rendering bug.
 */
export const TICKET_ORDER = [
  { position: 'asc' as const },
  { createdAt: 'asc' as const },
  { id: 'asc' as const },
];

/** Workflow states use the same scheme. */
export const STATE_ORDER = [{ position: 'asc' as const }, { id: 'asc' as const }];

/**
 * Workspaces are hand-arranged, so `position` leads -- but every row predating
 * that column sits at 0, which makes ties the normal case rather than the
 * pathological one. Name breaks them, so an unarranged organization still reads
 * alphabetically.
 */
export const WORKSPACE_ORDER = [
  { position: 'asc' as const },
  { name: 'asc' as const },
  { id: 'asc' as const },
];

export const CYCLE_ORDER = [{ number: 'asc' as const }];

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

/**
 * A one-time token from an emailed link: `randomBytes(32).toString('base64url')`,
 * so 43 characters from the base64url alphabet. Bounded and character-checked
 * before it reaches a query, exactly like every other id in this file -- an
 * unbounded string here would be hashed and looked up on every crafted request.
 */
export const emailTokenSchema = z
  .string()
  .trim()
  .min(20)
  .max(200)
  .regex(/^[A-Za-z0-9_-]+$/);

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
export const stateTypeSchema = z.nativeEnum(WorkflowStateType);
export const boardStatusSchema = z.nativeEnum(BoardStatus);
export const colorTokenSchema = z.enum(COLOR_TOKENS);
export const issueTabSchema = z.enum(ISSUE_TABS);

/** Cycle numbers share the ticket-number bound: both are Postgres `Int`. */
export const cycleNumberSchema = ticketNumberSchema;

/**
 * `YYYY-MM-DD`, parsed as UTC midnight so the stored instant does not drift a
 * day depending on where the server happens to be running. Rejects a
 * well-formed but impossible date like 2026-02-31, which `new Date()` would
 * silently roll forward into March.
 */
export const isoDateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Use the format YYYY-MM-DD.')
  .refine((value) => {
    const parsed = new Date(`${value}T00:00:00.000Z`);
    return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
  }, 'That is not a real date.');

/** The roles an ADMIN is allowed to hand out. Granting OWNER is OWNER-only. */
export const assignableRoleSchema = z.enum(['ADMIN', 'MEMBER']);

/* -------------------------------------------------------------------------- */
/* Reminders                                                                   */
/* -------------------------------------------------------------------------- */

export const reminderRepeatSchema = z.nativeEnum(ReminderRepeat);

/**
 * `YYYY-MM-DDTHH:mm`, the value an `<input type="datetime-local">` submits.
 *
 * The real-date check is delegated to `toInstant` rather than repeated here, so
 * the string the form validates and the instant the action stores can never
 * disagree about whether 2026-02-31T09:00 exists. Same trap `isoDateSchema`
 * guards against; same fix, one implementation.
 */
export const localDateTimeSchema = z
  .string()
  .trim()
  .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/, 'Pick a date and a time.')
  .refine((value) => toInstant(value, 0) !== null, 'That is not a real date and time.');

/**
 * The browser's UTC offset in minutes, as `getTimezoneOffset()` reports it.
 *
 * Bounded to the real range (+-14h) and defaulted rather than required: the
 * hidden field carrying it is filled by client JavaScript, and a form submitted
 * without it must still produce a working reminder -- interpreted as UTC, which
 * is the only defensible guess.
 */
export const tzOffsetSchema = z.coerce
  .number()
  .int()
  .min(-MAX_TZ_OFFSET_MINUTES)
  .max(MAX_TZ_OFFSET_MINUTES)
  .catch(0);

/** Same cap as an issue title: it is the subject line of the email. */
export const reminderTitleSchema = safeText(1, 200);

/* -------------------------------------------------------------------------- */
/* Named length caps (SPEC 4.10, final)                                        */
/* -------------------------------------------------------------------------- */

export const userNameSchema = safeText(1, 80);
export const orgNameSchema = safeText(2, 60);
export const workspaceNameSchema = safeText(2, 60);
export const projectNameSchema = safeText(1, 80);
export const projectDescriptionSchema = safeMultiline(0, 2000);
export const boardNameSchema = safeText(1, 80);
export const boardDescriptionSchema = safeMultiline(0, 2000);
export const ticketTitleSchema = safeText(1, 200);
export const ticketDescriptionSchema = safeMultiline(0, 10000);
export const commentBodySchema = safeMultiline(1, 5000);
export const stateNameSchema = safeText(1, 40);
export const labelNameSchema = safeText(1, 40);
export const cycleNameSchema = safeText(0, 60);
export const viewNameSchema = safeText(1, 60);

/**
 * A saved view's stored query string.
 *
 * Capped and control-char-free like any other stored text, and additionally
 * forbidden from containing anything but a query: no `?`, no `#`, no scheme.
 * That is what stops a "view" being saved that navigates somewhere else
 * entirely when it is turned back into a link.
 */
export const viewQuerySchema = safeText(0, 500).refine(
  (value) => !/[?#]/.test(value) && !value.includes('//'),
  'That is not a valid filter.',
);

/* -------------------------------------------------------------------------- */
/* Cycle cadence                                                               */
/* -------------------------------------------------------------------------- */

/**
 * Bounded hard on purpose. `cycleWeeks` feeds a loop that materializes cycles
 * on read, and `upcomingCycles` decides how many it writes; leaving either
 * open would let a settings form turn one page view into thousands of inserts.
 */
export const cycleWeeksSchema = z.coerce.number().int().min(1).max(8);
/** ISO weekday: 1 = Monday .. 7 = Sunday. */
export const cycleStartDaySchema = z.coerce.number().int().min(1).max(7);
export const upcomingCyclesSchema = z.coerce.number().int().min(1).max(12);

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
