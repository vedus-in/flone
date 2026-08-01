import 'server-only';
import crypto from 'node:crypto';

/**
 * SPEC §4.1 — password hashing with node:crypto scrypt.
 *
 * No native-binding dependency (no bcrypt, no argon2) — scrypt ships with the
 * runtime and is OWASP-acceptable, and native bindings are a Railway build risk.
 */

const N = 2 ** 16;
const R = 8;
const P = 1;
const KEYLEN = 64;
const SALTLEN = 16;

/**
 * MANDATORY. `128 * N * r` = 64 MiB, which exceeds Node's 32 MiB default and
 * makes `crypto.scrypt` throw ERR_CRYPTO_INVALID_SCRYPT_PARAMS on 100% of calls.
 * Doubled to 128 MiB so historical parameter sets still fit.
 */
const MAXMEM = 128 * N * R * 2; // 134_217_728

const OPTS = { N, r: R, p: P, maxmem: MAXMEM } as const;

/**
 * Async only. `scryptSync` blocks the event loop for ~250 ms per call.
 *
 * Hand-wrapped rather than `promisify`d: `crypto.scrypt` is overloaded, and
 * `promisify` binds to the 4-arg `(password, salt, keylen, callback)` overload,
 * which drops the `options` argument we need for N/r/p/maxmem and widens the
 * result to `unknown`.
 */
function scryptAsync(
  password: string,
  salt: Buffer,
  keylen: number,
  options: crypto.ScryptOptions,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    crypto.scrypt(password, salt, keylen, options, (err, derivedKey) => {
      if (err) reject(err);
      else resolve(derivedKey);
    });
  });
}

/* -------------------------------------------------------------------------- */
/* Concurrency semaphore                                                       */
/* -------------------------------------------------------------------------- */

/**
 * 4 x 64 MiB is already most of a small Railway container. Without this gate a
 * handful of concurrent logins is an OOM kill. FIFO so a queued request is never
 * starved.
 */
const MAX_CONCURRENT = 4;
let active = 0;
const queue: Array<() => void> = [];

function acquire(): Promise<void> {
  if (active < MAX_CONCURRENT) {
    active += 1;
    return Promise.resolve();
  }
  return new Promise<void>((resolve) => {
    queue.push(resolve);
  });
}

function release(): void {
  const next = queue.shift();
  // Hand the slot straight over rather than decrementing and re-incrementing.
  if (next) next();
  else active -= 1;
}

async function derive(
  normalized: string,
  salt: Buffer,
  keylen: number,
  options: crypto.ScryptOptions,
): Promise<Buffer> {
  await acquire();
  try {
    return await scryptAsync(normalized, salt, keylen, options);
  } finally {
    release();
  }
}

/* -------------------------------------------------------------------------- */
/* Encoding                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * `["scrypt", N, r, p, salt.b64, key.b64].join("$")` — exactly 6 `$`-separated
 * fields. Base64 never contains `$`, so the delimiter is unambiguous.
 */
function encode(salt: Buffer, hash: Buffer): string {
  return ['scrypt', N, R, P, salt.toString('base64'), hash.toString('base64')].join('$');
}

export type ParsedHash = {
  N: number;
  r: number;
  p: number;
  salt: Buffer;
  hash: Buffer;
};

const UINT_RE = /^\d{1,7}$/;

function isPowerOfTwo(n: number): boolean {
  return n > 0 && (n & (n - 1)) === 0;
}

/**
 * Strict decoder. Returns `null` — never throws — unless every invariant holds.
 *
 * The byte-length checks are load-bearing: `Buffer.from(x, 'base64')` silently
 * skips invalid characters and truncates, so a malformed field would otherwise
 * produce a short-but-plausible buffer.
 */
export function parseHash(encoded: string): ParsedHash | null {
  if (typeof encoded !== 'string') return null;

  const parts = encoded.split('$');
  if (parts.length !== 6) return null;

  const [scheme, nRaw, rRaw, pRaw, saltB64, hashB64] = parts as [
    string,
    string,
    string,
    string,
    string,
    string,
  ];

  if (scheme !== 'scrypt') return null;
  if (!UINT_RE.test(nRaw) || !UINT_RE.test(rRaw) || !UINT_RE.test(pRaw)) return null;

  const n = Number(nRaw);
  const r = Number(rRaw);
  const p = Number(pRaw);

  if (!isPowerOfTwo(n) || n < 2 ** 14 || n > 2 ** 17) return null;
  if (r < 1 || r > 16) return null;
  if (p < 1 || p > 4) return null;
  if (128 * n * r > MAXMEM) return null;

  const salt = Buffer.from(saltB64, 'base64');
  const hash = Buffer.from(hashB64, 'base64');

  if (salt.length !== SALTLEN) return null;
  if (hash.length !== KEYLEN) return null;

  return { N: n, r, p, salt, hash };
}

function optsFor(parsed: ParsedHash): crypto.ScryptOptions {
  return { N: parsed.N, r: parsed.r, p: parsed.p, maxmem: MAXMEM };
}

/* -------------------------------------------------------------------------- */
/* Decoy                                                                       */
/* -------------------------------------------------------------------------- */

/**
 * Produced once, offline, by hashing a random 32-byte string with the current
 * parameters. Used so an unknown email costs exactly one scrypt invocation —
 * see SPEC §4.4. It protects nothing by being secret; it is a timing shim.
 */
export const DUMMY_HASH =
  'scrypt$65536$8$1$UAn08msxFXdJz9DH7vPOKg==$uVKTdE2ndqxuVDOm7FszcwHui8XOZreTMULgJOUc8EUZT9kmcnnddJaJejETjbMLOVN9+BbOzzotsncI3umWsQ==';

/* -------------------------------------------------------------------------- */
/* Public API                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * NFKC normalization happens HERE and in `verifyPassword` only — never at the
 * schema layer, so it cannot be applied on one path and forgotten on the other.
 * Never `.trim()` a password.
 */
export async function hashPassword(plain: string): Promise<string> {
  const normalized = plain.normalize('NFKC');
  const salt = crypto.randomBytes(SALTLEN);
  const hash = await derive(normalized, salt, KEYLEN, OPTS);
  return encode(salt, hash);
}

/**
 * Constant-ish time verification.
 *
 * On parse failure we still run one scrypt against the decoy so a corrupt stored
 * hash is indistinguishable from a wrong password. On success the candidate is
 * derived with `keylen := parsed.hash.length`, so the two buffers are equal-length
 * BY CONSTRUCTION and `timingSafeEqual`'s ERR_CRYPTO_TIMING_SAFE_EQUAL_LENGTH
 * throw is structurally unreachable.
 *
 * Never compare with `===`, `Buffer.compare`, or `.equals()`.
 */
export async function verifyPassword(plain: string, encoded: string): Promise<boolean> {
  const normalized = plain.normalize('NFKC');
  const parsed = parseHash(encoded);

  if (!parsed) {
    const decoy = parseHash(DUMMY_HASH);
    if (decoy) {
      await derive(normalized, decoy.salt, decoy.hash.length, optsFor(decoy));
    }
    return false;
  }

  const candidate = await derive(normalized, parsed.salt, parsed.hash.length, optsFor(parsed));
  return crypto.timingSafeEqual(candidate, parsed.hash);
}

/**
 * True when the stored parameters differ from the current constants. On a
 * successful login with `needsRehash`, re-hash the just-verified plaintext and
 * update the row.
 */
export function needsRehash(encoded: string): boolean {
  const parsed = parseHash(encoded);
  if (!parsed) return true;
  return (
    parsed.N !== N ||
    parsed.r !== R ||
    parsed.p !== P ||
    parsed.salt.length !== SALTLEN ||
    parsed.hash.length !== KEYLEN
  );
}

/**
 * A pure parse with zero hashing cost that fails the boot loudly if the
 * parameters above are changed without regenerating the decoy — otherwise the
 * decoy branch would silently cost a different amount of CPU than the real one,
 * reopening the enumeration oracle it exists to close.
 */
if (needsRehash(DUMMY_HASH)) {
  throw new Error('DUMMY_HASH params drifted');
}
