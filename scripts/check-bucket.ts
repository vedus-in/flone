/**
 * Asserts the two pieces of the attachment path that nothing else can catch:
 * SigV4 presigning (`src/lib/bucket.ts`) and the upload rules
 * (`src/lib/attachments.ts`).
 *
 * WHY THE SIGNING NEEDS A TEST VECTOR. A canonical request is a string built from
 * eight parts, and every one of them is invisible in the result: a wrong byte
 * anywhere produces a URL that looks perfect and comes back
 * `403 SignatureDoesNotMatch`. There is no type error, no lint, and no way to tell
 * a bad signature from a wrong credential by reading the response. So this checks
 * against AWS's own published example, whose expected signature is documented in
 * "Signature Calculations for a Presigned URL" (Signature Version 4 examples) --
 * matching it means the URI encoding, the header canonicalization, the query
 * ordering, the scope, the `UNSIGNED-PAYLOAD` literal and the four-step key
 * derivation are all correct at once.
 *
 * WHY THE RULES NEED ONE. `validateUpload` and `sanitizeFilename` are the trust
 * boundary. `accept="image/*"` in the browser is not a control, and every hostile
 * case here -- a 25 MB file, an `.exe` with a `.png` name, `../../etc/passwd` as a
 * filename -- reaches the server as an ordinary well-formed request.
 *
 * Runs on Bun, for the tsconfig `@/` paths:
 *
 *   bun scripts/check-bucket.ts
 */

import assert from 'node:assert/strict';

// Type-only, so it does not execute the module before the stub below is in place.
import type { BucketConfig } from '../src/lib/bucket';

/**
 * `bucket.ts` opens with `import 'server-only'`, which throws outside a Server
 * Component -- it reads a bucket credential, and that guard is what keeps the
 * secret out of a client bundle. Stubbed for this script exactly as
 * `check-email.ts` does it, and for the same reason: the boundary is a build-time
 * assertion enforced by `check:boundary`, and nothing it protects is exercised
 * here. Registered before the imports, which is why they are dynamic.
 *
 * `attachments.ts` needs no stub -- the browser applies those same rules, so it is
 * deliberately not `server-only`. Its dynamic import below just keeps the two
 * side by side.
 */
declare const Bun: {
  plugin(plugin: {
    name: string;
    setup(build: {
      module(
        specifier: string,
        callback: () => { exports: Record<string, unknown>; loader: 'object' },
      ): void;
    }): void;
  }): void;
};

Bun.plugin({
  name: 'stub-server-only',
  setup(build) {
    build.module('server-only', () => ({ exports: {}, loader: 'object' }));
  },
});

const { presign } = await import('../src/lib/bucket.ts');
const {
  ATTACHMENT_ERRORS,
  MAX_ATTACHMENT_BYTES,
  attachmentKey,
  sanitizeFilename,
  rejectionMessage,
  validateUpload,
} = await import('../src/lib/attachments.ts');

let passed = 0;
function check(name: string, run: () => void) {
  run();
  passed += 1;
  void name;
}

/* -------------------------------------------------------------------------- */
/* 1. SigV4, against AWS's published example                                   */
/* -------------------------------------------------------------------------- */

/**
 * The credentials from AWS's documentation examples. They are a published test
 * fixture, not a secret, and they are the only reason the expected signature
 * below is a fixed string.
 */
const AWS_EXAMPLE: BucketConfig = {
  endpoint: 'https://examplebucket.s3.amazonaws.com',
  bucket: 'examplebucket',
  region: 'us-east-1',
  accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
  secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
};

check('presigned GET matches the AWS example signature', () => {
  const url = presign(
    AWS_EXAMPLE,
    'GET',
    'https://examplebucket.s3.amazonaws.com/test.txt',
    86400,
    {},
    new Date('2013-05-24T00:00:00Z'),
  );

  assert.match(url, /X-Amz-Algorithm=AWS4-HMAC-SHA256/);
  assert.match(
    url,
    /X-Amz-Credential=AKIAIOSFODNN7EXAMPLE%2F20130524%2Fus-east-1%2Fs3%2Faws4_request/,
  );
  assert.match(url, /X-Amz-Date=20130524T000000Z/);
  assert.match(url, /X-Amz-Expires=86400/);
  assert.match(url, /X-Amz-SignedHeaders=host/);
  assert.ok(
    url.endsWith(
      'X-Amz-Signature=aeeed9bbccd4d02ee5c0109b86d86835f995330da4c265957d157751f604d404',
    ),
    `signature mismatch: ${url}`,
  );
});

/**
 * A signed `content-type` changes the signature. This is what makes `putObject`
 * able to insist the object is stored as `image/png` rather than as a download.
 */
check('signing an extra header changes the signature', () => {
  const at = new Date('2013-05-24T00:00:00Z');
  const plain = presign(AWS_EXAMPLE, 'PUT', 'https://examplebucket.s3.amazonaws.com/a.png', 60, {}, at);
  const typed = presign(
    AWS_EXAMPLE,
    'PUT',
    'https://examplebucket.s3.amazonaws.com/a.png',
    60,
    { 'content-type': 'image/png' },
    at,
  );

  assert.match(plain, /X-Amz-SignedHeaders=host&/);
  assert.match(typed, /X-Amz-SignedHeaders=content-type%3Bhost&/);
  assert.notEqual(plain, typed);
});

/** Same request, later clock, different signature -- the URL really does expire. */
check('the signature is bound to the clock', () => {
  const url = 'https://examplebucket.s3.amazonaws.com/test.txt';
  const first = presign(AWS_EXAMPLE, 'GET', url, 300, {}, new Date('2026-08-17T10:00:00Z'));
  const second = presign(AWS_EXAMPLE, 'GET', url, 300, {}, new Date('2026-08-17T10:00:01Z'));
  assert.notEqual(first, second);
});

/**
 * A key is a path, so its slashes must stay slashes while everything inside a
 * segment is encoded. Getting this backwards is the other classic 403.
 */
check('a space in a key is encoded without eating the slashes', () => {
  const url = presign(
    AWS_EXAMPLE,
    'GET',
    'https://examplebucket.s3.amazonaws.com/attachments/t1/id-my%20shot.png',
    60,
  );
  assert.ok(url.includes('/attachments/t1/id-my%20shot.png'), url);
});

/* -------------------------------------------------------------------------- */
/* 2. Upload rules                                                             */
/* -------------------------------------------------------------------------- */

check('the four image types are accepted', () => {
  for (const type of ['image/png', 'image/jpeg', 'image/gif', 'image/webp']) {
    assert.equal(validateUpload({ type, size: 1024 }), null, type);
  }
});

check('anything else is refused', () => {
  // An `.exe` renamed `.png`: the browser reports the real type, not the suffix.
  assert.equal(
    validateUpload({ type: 'application/octet-stream', size: 1024 }),
    ATTACHMENT_ERRORS.WRONG_TYPE,
  );
  // SVG is a document that can carry script. It must never be on the allowlist.
  assert.equal(validateUpload({ type: 'image/svg+xml', size: 512 }), ATTACHMENT_ERRORS.WRONG_TYPE);
  assert.equal(validateUpload({ type: 'text/html', size: 512 }), ATTACHMENT_ERRORS.WRONG_TYPE);
  assert.equal(validateUpload({ type: '', size: 512 }), ATTACHMENT_ERRORS.WRONG_TYPE);
});

check('the size limit is 10 MB, inclusive', () => {
  assert.equal(validateUpload({ type: 'image/png', size: MAX_ATTACHMENT_BYTES }), null);
  assert.equal(
    validateUpload({ type: 'image/png', size: MAX_ATTACHMENT_BYTES + 1 }),
    ATTACHMENT_ERRORS.TOO_LARGE,
  );
  assert.equal(
    validateUpload({ type: 'image/png', size: 25 * 1024 * 1024 }),
    ATTACHMENT_ERRORS.TOO_LARGE,
  );
});

check('an empty file is refused', () => {
  assert.equal(validateUpload({ type: 'image/png', size: 0 }), ATTACHMENT_ERRORS.NO_FILE);
});

/* -------------------------------------------------------------------------- */
/* 3. Filenames, which end up inside an object key                             */
/* -------------------------------------------------------------------------- */

check('traversal and separators cannot survive', () => {
  for (const hostile of [
    '../../etc/passwd',
    '..\\..\\windows\\system32\\config',
    '/absolute/path.png',
    'C:\\Users\\me\\shot.png',
    '....//....//x.png',
  ]) {
    const safe = sanitizeFilename(hostile);
    assert.doesNotMatch(safe, /[\\/]/, hostile);
    assert.doesNotMatch(safe, /^\.\.?$/, hostile);
    assert.doesNotMatch(safe, /^\./, hostile);
  }
});

check('a name that sanitizes to nothing still has one', () => {
  assert.equal(sanitizeFilename(''), 'image');
  assert.equal(sanitizeFilename('...'), 'image');
  assert.equal(sanitizeFilename('/'), 'image');
});

check('ordinary names are left readable', () => {
  assert.equal(sanitizeFilename('Screenshot 2026-08-17.png'), 'Screenshot-2026-08-17.png');
  assert.equal(sanitizeFilename('bug_report.PNG'), 'bug_report.PNG');
});

check('a long name is capped', () => {
  assert.ok(sanitizeFilename(`${'a'.repeat(500)}.png`).length <= 80);
});

/**
 * Keyed on the PROJECT, not the issue: an image can be pasted into an issue that
 * does not exist yet, and an object key cannot be rewritten once written.
 */
check('the key names its project and its row', () => {
  const key = attachmentKey('prj_123', 'att_456', 'my shot.png');
  assert.equal(key, 'attachments/prj_123/att_456-my-shot.png');
});


/* -------------------------------------------------------------------------- */
/* 4. Refusals have to say something                                           */
/*                                                                             */
/* Dropping an unsupported file used to do nothing at all -- the silence read as */
/* a broken feature. These assert that every refusal produces a sentence, that   */
/* it names the file, and that an acceptable batch produces none.                */
/* -------------------------------------------------------------------------- */

const file = (name: string, type: string, size: number) => ({ name, type, size });

check('nothing refused, nothing said', () => {
  assert.equal(rejectionMessage([]), null);
});

check('a wrong type is named, with what would work', () => {
  const message = rejectionMessage([file('quarterly.pdf', 'application/pdf', 2048)]) ?? '';
  assert.match(message, /quarterly\.pdf/);
  assert.match(message, /PNG, JPEG, GIF and WebP/);
  assert.match(message, /10 MB/);
});

check('an oversized image is told how far over it is', () => {
  const message = rejectionMessage([file('shot.png', 'image/png', 25 * 1024 * 1024)]) ?? '';
  assert.match(message, /shot\.png/);
  assert.match(message, /25\.0 MB/);
  assert.doesNotMatch(message, /not an image/);
});

check('an empty file says so rather than blaming its type', () => {
  const message = rejectionMessage([file('shot.png', 'image/png', 0)]) ?? '';
  assert.match(message, /empty/);
});

check('a batch is counted rather than listed', () => {
  const message =
    rejectionMessage([
      file('a.pdf', 'application/pdf', 10),
      file('b.zip', 'application/zip', 10),
      file('c.mov', 'video/quicktime', 10),
    ]) ?? '';
  assert.match(message, /^3 files were not attached\./);
});

check('a hostile filename cannot push the layout around', () => {
  const message = rejectionMessage([file(`${'x'.repeat(400)}.pdf`, 'application/pdf', 10)]) ?? '';
  assert.ok(message.length < 200, `message was ${message.length} chars`);
  assert.match(message, /…/);
});

/** The accepted case must stay silent, or every good paste shows an error. */
check('an acceptable image is not refused', () => {
  assert.equal(rejectionMessage([file('shot.png', 'image/png', 1024)].filter((f) => validateUpload(f) !== null)), null);
});

console.log(`check-bucket: ${passed} checks passed`);
