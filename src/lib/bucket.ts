import 'server-only';
import { createHash, createHmac } from 'node:crypto';

/**
 * The S3-compatible object bucket, in one file and with no dependency.
 *
 * WHY NOT AN SDK. `@aws-sdk/client-s3` plus `@aws-sdk/s3-request-presigner` is
 * ~2 MB of node_modules to do three things: sign a URL, PUT, DELETE. Everything
 * below is one signing function and three `fetch` calls, and the signing is
 * pinned by a published AWS test vector in `scripts/check-bucket.ts`. If the
 * bucket ever grows a real workload -- multipart uploads, listing, lifecycle
 * rules -- take the SDK; for writing and reading whole screenshots it is dead
 * weight.
 *
 * WHY NOT `Bun.s3`, which the design note proposed. Bun is this repo's package
 * manager and its `services/voice` runtime, but the Next server is NOT running
 * under it: `bun run start` executes `next`, whose bin shim carries a
 * `#!/usr/bin/env node` shebang, and `bun run` honours that shebang unless
 * invoked as `bun --bun run`. So `Bun.s3` is `undefined` in a route handler and
 * the failure would be a production-only TypeError. `node:crypto` and `fetch`
 * are present on BOTH runtimes, so this file cannot care which one wins.
 *
 * EVERY REQUEST IS A PRESIGNED URL, including the ones this server makes itself.
 * One code path signs the browser's 5-minute GET and the server's own PUT and
 * DELETE, so there is no second, less-tested signing routine for the paths a
 * human never sees.
 *
 * PATH STYLE, not virtual-host style: `<endpoint>/<bucket>/<key>`. Railway's
 * buckets, MinIO and every other S3-compatible endpoint accept it, and it needs
 * no DNS beyond the endpoint the provider handed over.
 */

export type BucketConfig = {
  /** Origin, no trailing slash. */
  endpoint: string;
  bucket: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
};

/**
 * Reads the five variables, or returns null when the bucket is not configured.
 *
 * NULL IS A SUPPORTED STATE, not an error: with no bucket the upload route
 * answers 503 and the rest of the application is untouched, exactly as it is
 * with no `RESEND_API_KEY`. Local development does not need a bucket to work on
 * anything else.
 *
 * `S3_REGION` defaults to `us-east-1` because SigV4 requires *a* region in the
 * credential scope and most S3-compatible endpoints ignore which one it is.
 * Railway's bucket variables map straight on (see `.env.example`).
 */
export function bucketConfig(): BucketConfig | null {
  const endpoint = process.env.S3_ENDPOINT?.trim().replace(/\/+$/, '');
  const bucket = process.env.S3_BUCKET?.trim();
  const accessKeyId = process.env.S3_ACCESS_KEY_ID?.trim();
  const secretAccessKey = process.env.S3_SECRET_ACCESS_KEY?.trim();
  const region = process.env.S3_REGION?.trim() || 'us-east-1';

  if (!endpoint || !bucket || !accessKeyId || !secretAccessKey) return null;
  return { endpoint, bucket, region, accessKeyId, secretAccessKey };
}

/* -------------------------------------------------------------------------- */
/* SigV4, query-string flavour                                                 */
/* -------------------------------------------------------------------------- */

/**
 * RFC 3986, which is stricter than `encodeURIComponent`: the four characters it
 * leaves alone are exactly the ones a mismatched canonical request is usually
 * hiding behind. `/` is encoded here and re-joined by the caller for paths.
 */
function encodeRfc3986(value: string): string {
  return encodeURIComponent(value).replace(
    /[!'()*]/g,
    (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

function encodePath(path: string): string {
  return path.split('/').map(encodeRfc3986).join('/');
}

function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function hmac(key: Buffer | string, value: string): Buffer {
  return createHmac('sha256', key).update(value, 'utf8').digest();
}

/**
 * Presign one request as a URL.
 *
 * Exported, and takes its config and clock as arguments, ONLY so
 * `scripts/check-bucket.ts` can reproduce AWS's published test vector byte for
 * byte. Application code calls `objectUrl` / `putObject` / `deleteObject` below.
 *
 * `headers` are additional SIGNED headers. `host` is always signed, because S3
 * requires it. Anything else the request sends unsigned is at the mercy of the
 * endpoint's own rules, which is why `putObject` signs `content-type` rather
 * than hoping the object inherits it.
 *
 * The payload hash is the literal `UNSIGNED-PAYLOAD`. That is what makes a
 * presigned URL usable at all: the body is not known when the URL is minted, and
 * for a PUT it would otherwise have to be hashed twice.
 */
export function presign(
  config: BucketConfig,
  method: string,
  url: string,
  expiresInSeconds: number,
  headers: Record<string, string> = {},
  now: Date = new Date(),
): string {
  const target = new URL(url);

  // 20260817T131500Z -- ISO 8601 basic, which is the only format SigV4 accepts.
  const amzDate = now.toISOString().replace(/[-:]|\.\d{3}/g, '');
  const dateStamp = amzDate.slice(0, 8);
  const scope = `${dateStamp}/${config.region}/s3/aws4_request`;

  const signed: Record<string, string> = { host: target.host };
  for (const [name, value] of Object.entries(headers)) {
    signed[name.toLowerCase()] = value;
  }
  const signedNames = Object.keys(signed).sort();
  const canonicalHeaders = signedNames
    .map((name) => `${name}:${signed[name].trim().replace(/\s+/g, ' ')}\n`)
    .join('');
  const signedHeaders = signedNames.join(';');

  const canonicalQuery = [
    ['X-Amz-Algorithm', 'AWS4-HMAC-SHA256'],
    ['X-Amz-Credential', `${config.accessKeyId}/${scope}`],
    ['X-Amz-Date', amzDate],
    ['X-Amz-Expires', String(expiresInSeconds)],
    ['X-Amz-SignedHeaders', signedHeaders],
  ]
    .map(([key, value]) => `${encodeRfc3986(key)}=${encodeRfc3986(value)}`)
    .sort()
    .join('&');

  const canonicalRequest = [
    method,
    target.pathname,
    canonicalQuery,
    canonicalHeaders,
    signedHeaders,
    'UNSIGNED-PAYLOAD',
  ].join('\n');

  const stringToSign = [
    'AWS4-HMAC-SHA256',
    amzDate,
    scope,
    sha256Hex(canonicalRequest),
  ].join('\n');

  const key = hmac(
    hmac(hmac(hmac(`AWS4${config.secretAccessKey}`, dateStamp), config.region), 's3'),
    'aws4_request',
  );
  const signature = createHmac('sha256', key).update(stringToSign, 'utf8').digest('hex');

  return `${target.origin}${target.pathname}?${canonicalQuery}&X-Amz-Signature=${signature}`;
}

/* -------------------------------------------------------------------------- */
/* Operations                                                                  */
/* -------------------------------------------------------------------------- */

/** Thrown when an operation is attempted with no bucket configured. */
export class BucketNotConfiguredError extends Error {
  constructor() {
    super('bucket_not_configured');
    this.name = 'BucketNotConfiguredError';
    Object.setPrototypeOf(this, BucketNotConfiguredError.prototype);
  }
}

function requireConfig(): BucketConfig {
  const config = bucketConfig();
  if (!config) throw new BucketNotConfiguredError();
  return config;
}

function unsignedUrl(config: BucketConfig, key: string): string {
  return `${config.endpoint}/${encodeRfc3986(config.bucket)}/${encodePath(key)}`;
}

/**
 * A presigned GET, for handing to a browser in a redirect.
 *
 * The expiry is the whole access-control window: the URL is a bearer credential
 * for one object, so it is minted per request, never stored, never logged, and
 * never put anywhere a page can be re-read from cache.
 */
export function objectUrl(key: string, expiresInSeconds: number): string {
  const config = requireConfig();
  return presign(config, 'GET', unsignedUrl(config, key), expiresInSeconds);
}

/**
 * Write one object. `content-type` is SIGNED so the endpoint has to honour it --
 * an object stored as `application/octet-stream` would download instead of
 * rendering in the page that asked for it.
 */
export async function putObject(
  key: string,
  body: ArrayBuffer,
  contentType: string,
): Promise<void> {
  const config = requireConfig();
  const url = presign(config, 'PUT', unsignedUrl(config, key), 60, {
    'content-type': contentType,
  });

  const response = await fetch(url, {
    method: 'PUT',
    body,
    headers: { 'content-type': contentType },
  });

  // The status only -- a bucket error body can echo the key and the presigned
  // query string, and that query string is a credential (SPEC 4.7).
  if (!response.ok) throw new Error(`bucket_put_${response.status}`);
}

/**
 * Delete one object. Returns false rather than throwing, because every caller is
 * cleaning up after a delete that has already been authorized and must not be
 * blocked by a bucket outage. A 404 counts as success: the object is gone, which
 * is the state being asked for.
 */
export async function deleteObject(key: string): Promise<boolean> {
  try {
    const config = requireConfig();
    const response = await fetch(presign(config, 'DELETE', unsignedUrl(config, key), 60), {
      method: 'DELETE',
    });
    return response.ok || response.status === 404;
  } catch {
    return false;
  }
}
