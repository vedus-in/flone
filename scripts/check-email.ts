/**
 * Asserts the parts of the email layer that fail silently.
 *
 * "Silently" is the operative word. Every failure mode below produces no error,
 * no stack trace and no failing page — it produces a message that was never
 * sent, or one that was sent to the wrong place. None of it shows up in a type
 * check and none of it shows up in the UI.
 *
 *   1. NO KEY MUST NOT MEAN NO BOOT, AND MUST NOT MEAN A NETWORK CALL. Local
 *      development runs without a Resend account. If `sendMail` ever threw on a
 *      missing key, every Server Action that queues mail would start failing on
 *      a fresh checkout.
 *
 *   2. A MISCONFIGURED PRODUCTION INSTANCE MUST SEND NOTHING. With a key but no
 *      `APP_URL`, every link in every message would be wrong. Sending a real
 *      email with a broken confirmation link is worse than sending none.
 *
 *   3. A FAILING PROVIDER MUST NOT FAIL THE ACTION. A 500 from Resend, a
 *      timeout, or a DNS failure has to be swallowed — assigning an issue
 *      succeeds whether or not the notification went out.
 *
 *   4. LINKS MUST SURVIVE THE PLAIN-TEXT CONVERSION. A one-time link that only
 *      exists inside an HTML button is unreachable for anyone whose client
 *      shows the text/plain part. This is the check that would have caught it.
 *
 *   5. THE TOKEN IS SINGLE USE. Two clicks, a double submit, or a mail scanner
 *      racing the human must not both succeed. Needs a database, so it is
 *      SKIPPED rather than failed when one is not reachable.
 *
 * Runs on Bun, because the templates are TSX and Node's type stripping does not
 * transform JSX:
 *
 *   bun scripts/check-email.ts
 */

import assert from 'node:assert/strict';

/* -------------------------------------------------------------------------- */
/* Module setup                                                                */
/* -------------------------------------------------------------------------- */

/**
 * `src/lib/email.ts` opens with `import 'server-only'`, which throws outside a
 * Server Component. The obvious fix -- running under `--conditions=react-server`
 * so that import resolves to a no-op -- does not work here: that same condition
 * makes `react-dom/server` throw, and `render()` needs it. The two requirements
 * are mutually exclusive in one process.
 *
 * So the guard is stubbed for this script only. It is a build-time boundary
 * assertion, not a runtime behaviour, and nothing it protects is exercised here.
 * `scripts/check-client-boundary.mjs` is what actually enforces it.
 *
 * Registered before the dynamic imports below, which is why they are dynamic.
 */

/**
 * Declared locally rather than pulling in `@types/bun`, which is a dependency
 * for the sake of one call in one script.
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

/* -------------------------------------------------------------------------- */
/* Environment                                                                 */
/* -------------------------------------------------------------------------- */

// Set before `@/lib/email` is imported: it reads `process.env` per call, but
// being explicit here keeps a developer's own `.env` from deciding the result.
delete process.env.RESEND_API_KEY;
delete process.env.EMAIL_FROM;
process.env.APP_URL = 'https://flone.test';

const { appUrl, sendMail, tokenUrl } = await import('../src/lib/email.ts');
const templates = await import('../src/emails/templates.tsx');
const { render } = await import('react-email');

let passed = 0;
function check(label: string, run: () => void | Promise<void>): Promise<void> {
  return Promise.resolve(run()).then(
    () => {
      passed += 1;
    },
    (error) => {
      console.error(`FAIL  ${label}`);
      throw error;
    },
  );
}

/** Replaces `fetch` for one call and reports what it saw. */
function captureFetch(response: () => Promise<Response>) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    calls.push({ url: String(url), init });
    return response();
  }) as unknown as typeof fetch;
  return {
    calls,
    restore: () => {
      globalThis.fetch = original;
    },
  };
}

const MAIL = {
  to: 'someone@example.test',
  subject: 'Subject',
  html: '<p>Body</p>',
  text: 'Body',
};

/** Stands in for a one-time link, so a log assertion has something to look for. */
const SECRET_LINK = 'https://flone.test/verify?token=SHOULD-NEVER-BE-LOGGED';

/* -------------------------------------------------------------------------- */
/* 1. No key: no throw, no network                                             */
/* -------------------------------------------------------------------------- */

await check('no API key sends nothing and does not throw', async () => {
  const spy = captureFetch(async () => new Response('', { status: 200 }));
  try {
    await sendMail(MAIL);
    assert.equal(spy.calls.length, 0, 'sendMail contacted the network without an API key');
  } finally {
    spy.restore();
  }
});

await check('production with no key never logs the message body', async () => {
  const savedEnv = process.env.NODE_ENV;
  // @ts-expect-error -- NODE_ENV is typed as a literal union.
  process.env.NODE_ENV = 'production';

  const lines: string[] = [];
  const info = console.info;
  const error = console.error;
  console.info = (...args: unknown[]) => void lines.push(args.join(' '));
  console.error = (...args: unknown[]) => void lines.push(args.join(' '));

  const spy = captureFetch(async () => new Response('', { status: 200 }));
  try {
    await sendMail({ ...MAIL, text: `Confirm: ${SECRET_LINK}` });

    assert.equal(spy.calls.length, 0);
    const logged = lines.join('\n');
    // The development branch prints the whole body so links are clickable from
    // the dev server. In production that body is a working credential for any
    // account on the instance, and anyone with log access would have it.
    assert.ok(
      !logged.includes(SECRET_LINK),
      'a one-time link was written to the log in production',
    );
    assert.ok(!logged.includes(MAIL.to), 'a recipient address was written to the log');
    assert.ok(logged.includes('not_configured'), 'a misconfigured instance said nothing at all');
  } finally {
    spy.restore();
    console.info = info;
    console.error = error;
    // @ts-expect-error -- restoring the literal union.
    process.env.NODE_ENV = savedEnv;
  }
});

/* -------------------------------------------------------------------------- */
/* 2. Key but misconfigured: still nothing                                     */
/* -------------------------------------------------------------------------- */

await check('a key without EMAIL_FROM sends nothing', async () => {
  process.env.RESEND_API_KEY = 'test-key';
  const spy = captureFetch(async () => new Response('', { status: 200 }));
  try {
    await sendMail(MAIL);
    assert.equal(spy.calls.length, 0, 'sendMail sent with no EMAIL_FROM configured');
  } finally {
    spy.restore();
    delete process.env.RESEND_API_KEY;
  }
});

await check('a key without APP_URL sends nothing in production', async () => {
  process.env.RESEND_API_KEY = 'test-key';
  process.env.EMAIL_FROM = 'Flone <no-reply@flone.test>';
  const savedUrl = process.env.APP_URL;
  const savedEnv = process.env.NODE_ENV;
  delete process.env.APP_URL;
  // @ts-expect-error -- NODE_ENV is typed as a literal union.
  process.env.NODE_ENV = 'production';

  const spy = captureFetch(async () => new Response('', { status: 200 }));
  try {
    await sendMail(MAIL);
    assert.equal(
      spy.calls.length,
      0,
      'sendMail sent a message whose links could not be built correctly',
    );
  } finally {
    spy.restore();
    process.env.APP_URL = savedUrl;
    // @ts-expect-error -- restoring the literal union.
    process.env.NODE_ENV = savedEnv;
    delete process.env.RESEND_API_KEY;
    delete process.env.EMAIL_FROM;
  }
});

/* -------------------------------------------------------------------------- */
/* 3. Configured: one well-formed request, and failures are swallowed          */
/* -------------------------------------------------------------------------- */

await check('a configured instance posts one well-formed request', async () => {
  process.env.RESEND_API_KEY = 'test-key';
  process.env.EMAIL_FROM = 'Flone <no-reply@flone.test>';

  const spy = captureFetch(async () => new Response('{}', { status: 200 }));
  try {
    await sendMail(MAIL);
    assert.equal(spy.calls.length, 1);

    const [call] = spy.calls;
    assert.equal(call.url, 'https://api.resend.com/emails');
    assert.equal(call.init.method, 'POST');

    const headers = call.init.headers as Record<string, string>;
    assert.equal(headers.authorization, 'Bearer test-key');

    const body = JSON.parse(String(call.init.body));
    assert.deepEqual(body.to, [MAIL.to]);
    assert.equal(body.subject, MAIL.subject);
    assert.equal(body.html, MAIL.html);
    // Both parts, always: a text/plain alternative is not optional.
    assert.equal(body.text, MAIL.text);
  } finally {
    spy.restore();
  }
});

await check('a 500 from the provider does not throw', async () => {
  const spy = captureFetch(async () => new Response('nope', { status: 500 }));
  try {
    await sendMail(MAIL);
  } finally {
    spy.restore();
  }
});

await check('a network error does not throw', async () => {
  const spy = captureFetch(async () => {
    throw new Error('ECONNREFUSED');
  });
  try {
    await sendMail(MAIL);
  } finally {
    spy.restore();
    delete process.env.RESEND_API_KEY;
    delete process.env.EMAIL_FROM;
  }
});

/* -------------------------------------------------------------------------- */
/* 4. Links                                                                    */
/* -------------------------------------------------------------------------- */

await check('links are built from APP_URL, never a request header', () => {
  assert.equal(appUrl('/verify'), 'https://flone.test/verify');
  // A trailing slash on the env var must not produce a double slash.
  process.env.APP_URL = 'https://flone.test/';
  assert.equal(appUrl('/verify'), 'https://flone.test/verify');
  process.env.APP_URL = 'https://flone.test';
});

await check('a token is URL-encoded into the link', () => {
  // base64url can contain `-` and `_`, which are safe; the encoding is what
  // stops anything else from ending the query string early.
  const url = tokenUrl('/reset', 'abc-_123');
  assert.equal(url, 'https://flone.test/reset?token=abc-_123');
  assert.ok(tokenUrl('/reset', 'a+b/c=').endsWith('?token=a%2Bb%2Fc%3D'));
});

/* -------------------------------------------------------------------------- */
/* 5. Every template renders, and every link survives to plain text            */
/* -------------------------------------------------------------------------- */

const LINK = 'https://flone.test/one-time-link';

const RENDERABLE = [
  ['VerifyEmail', templates.VerifyEmail({ name: 'Dana', url: LINK }), true],
  [
    'AccountExistsEmail',
    templates.AccountExistsEmail({ signInUrl: LINK, resetUrl: LINK }),
    true,
  ],
  ['PasswordResetEmail', templates.PasswordResetEmail({ name: 'Dana', url: LINK }), true],
  [
    'PasswordChangedEmail',
    templates.PasswordChangedEmail({ name: 'Dana', resetUrl: LINK }),
    true,
  ],
  [
    'InviteEmail',
    templates.InviteEmail({
      orgName: 'Acme',
      inviterName: 'Dana',
      role: 'a member',
      url: LINK,
    }),
    true,
  ],
  [
    'AddedToOrgEmail',
    templates.AddedToOrgEmail({
      orgName: 'Acme',
      inviterName: 'Dana',
      role: 'a member',
      url: LINK,
    }),
    true,
  ],
  [
    'IssueAssignedEmail',
    templates.IssueAssignedEmail({
      actorName: 'Dana',
      issueKey: 'ENG-42',
      issueTitle: 'Title',
      projectName: 'Eng',
      url: LINK,
    }),
    true,
  ],
  [
    'NewCommentEmail',
    templates.NewCommentEmail({
      actorName: 'Dana',
      issueKey: 'ENG-42',
      issueTitle: 'Title',
      projectName: 'Eng',
      body: 'A comment body.',
      url: LINK,
    }),
    true,
  ],
  [
    'McpTokenCreatedEmail',
    templates.McpTokenCreatedEmail({ name: 'Dana', tokensUrl: LINK }),
    true,
  ],
  [
    'ReminderEmail',
    templates.ReminderEmail({
      title: 'Post the deploy notes',
      when: 'Wed 12 Aug, 09:00 (UTC+02:00)',
      scope: 'Engineering',
      repeat: 'Every day',
      setBy: 'Dana',
      url: LINK,
    }),
    true,
  ],
  [
    // The self-scheduled branch: `setBy` null changes the copy, and a template
    // that only ever renders one of its two branches in a check is half checked.
    'ReminderEmail (self)',
    templates.ReminderEmail({
      title: 'Post the deploy notes',
      when: 'Wed 12 Aug, 09:00 (UTC+02:00)',
      scope: 'Acme',
      repeat: 'Once',
      setBy: null,
      url: LINK,
    }),
    true,
  ],
] as const;

for (const [name, element, expectsLink] of RENDERABLE) {
  await check(`${name} renders both parts and keeps its link`, async () => {
    const html = await render(element);
    const text = await render(element, { plainText: true });

    assert.ok(html.length > 0, `${name} rendered empty HTML`);
    assert.ok(text.trim().length > 0, `${name} rendered empty plain text`);
    assert.ok(html.includes('<html'), `${name} did not render a document`);

    if (expectsLink) {
      assert.ok(html.includes(LINK), `${name} lost its link in the HTML part`);
      // The one that actually rots: a link that lives only inside a styled
      // button disappears when the client shows text/plain.
      assert.ok(text.includes(LINK), `${name} lost its link in the plain-text part`);
    }
  });
}

/* -------------------------------------------------------------------------- */
/* 6. Single use -- skipped without a database                                 */
/* -------------------------------------------------------------------------- */

async function tokenChecks(): Promise<boolean> {
  if (!process.env.DATABASE_URL) return false;

  const { PrismaClient, EmailTokenPurpose } = await import('@prisma/client');
  const prisma = new PrismaClient();

  try {
    await prisma.$queryRaw`SELECT 1`;
  } catch {
    await prisma.$disconnect();
    return false;
  }

  const { consumeToken, issueToken, peekToken } = await import('../src/lib/email-token.ts');
  const email = `check-email-${Date.now()}@example.invalid`;

  try {
    const user = await prisma.user.create({
      data: {
        email,
        name: 'check-email',
        passwordHash: 'x',
        emailVerified: new Date(),
      },
      select: { id: true },
    });

    try {
      const token = await issueToken({
        purpose: EmailTokenPurpose.EMAIL_VERIFY,
        email,
        userId: user.id,
      });

      await check('peek does not spend the token', async () => {
        assert.ok(await peekToken(token, EmailTokenPurpose.EMAIL_VERIFY));
        assert.ok(await peekToken(token, EmailTokenPurpose.EMAIL_VERIFY));
      });

      await check('a token is rejected under the wrong purpose', async () => {
        assert.equal(await peekToken(token, EmailTokenPurpose.PASSWORD_RESET), null);
        assert.equal(await consumeToken(token, EmailTokenPurpose.PASSWORD_RESET), null);
      });

      await check('a token is spent exactly once', async () => {
        const [first, second] = await Promise.all([
          consumeToken(token, EmailTokenPurpose.EMAIL_VERIFY),
          consumeToken(token, EmailTokenPurpose.EMAIL_VERIFY),
        ]);
        // Concurrent, because that is the real case: a double submit, or a link
        // scanner racing the human. Exactly one must win.
        const winners = [first, second].filter(Boolean);
        assert.equal(winners.length, 1, 'a token was spendable more than once');
        assert.equal(winners[0]?.userId, user.id);
      });

      await check('a spent token is dead to peek as well', async () => {
        assert.equal(await peekToken(token, EmailTokenPurpose.EMAIL_VERIFY), null);
      });

      await check('an expired token is rejected', async () => {
        const expiring = await issueToken({
          purpose: EmailTokenPurpose.PASSWORD_RESET,
          email,
          userId: user.id,
        });
        await prisma.emailToken.updateMany({
          where: { userId: user.id, purpose: EmailTokenPurpose.PASSWORD_RESET },
          data: { expiresAt: new Date(Date.now() - 1000) },
        });
        assert.equal(await consumeToken(expiring, EmailTokenPurpose.PASSWORD_RESET), null);
      });

      await check('issuing supersedes the previous token of that purpose', async () => {
        const first = await issueToken({
          purpose: EmailTokenPurpose.PASSWORD_RESET,
          email,
          userId: user.id,
        });
        const second = await issueToken({
          purpose: EmailTokenPurpose.PASSWORD_RESET,
          email,
          userId: user.id,
        });
        assert.equal(await consumeToken(first, EmailTokenPurpose.PASSWORD_RESET), null);
        assert.ok(await consumeToken(second, EmailTokenPurpose.PASSWORD_RESET));
      });
    } finally {
      // Tokens cascade with the user.
      await prisma.user.deleteMany({ where: { id: user.id } });
    }
  } finally {
    await prisma.$disconnect();
  }

  return true;
}

const ranTokenChecks = await tokenChecks();

console.log(`check-email: ${passed} assertions passed`);
if (!ranTokenChecks) {
  console.log('check-email: token single-use checks SKIPPED (no reachable database)');
}
