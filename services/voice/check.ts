import assert from 'node:assert/strict';

import { escapeXml, parseCall, twiml } from './index.ts';

/**
 * The voice service's self-check. `bun services/voice/check.ts`.
 *
 * Plain asserts under Bun, the same shape as `scripts/check-model.ts`. Two
 * things are worth a check here and the rest is not:
 *
 *   1. XML escaping, because it is the boundary between a reminder title and a
 *      document Twilio executes, and every way it can fail is silent until it
 *      is expensive;
 *   2. request validation, because this service's only defence against being
 *      turned into a dialer is that it refuses anything that is not a phone
 *      number.
 *
 * NOTE: importing `./index.ts` starts the server, which is why this file exits
 * explicitly at the end.
 */

let checks = 0;
const check = (name: string, run: () => void) => {
  run();
  checks += 1;
  console.log(`  ok  ${name}`);
};

console.log('\nvoice\n');

/* -------------------------------------------------------------------------- */
/* escapeXml                                                                   */
/* -------------------------------------------------------------------------- */

check('escapes every character that can close a tag or an attribute', () => {
  assert.equal(escapeXml(`<>&'"`), '&#60;&#62;&#38;&#39;&#34;');
});

check('leaves ordinary reminder text untouched', () => {
  const plain = 'Post the deploy notes before standup';
  assert.equal(escapeXml(plain), plain);
});

check('neutralises a title that tries to inject a Dial verb', () => {
  const attack = 'hi</Say><Dial>+19005550000</Dial><Say>';
  const document = twiml(attack, 'Polly.Joanna');

  // The payload survives as TEXT -- it is still spoken, just not executed.
  assert.ok(!document.includes('<Dial>'), 'a Dial verb reached the document');
  assert.equal(document.match(/<Say/g)?.length, 1, 'the attack opened a second Say');
  assert.ok(document.includes('&#60;Dial&#62;'), 'the payload was dropped rather than escaped');
});

check('an injected voice attribute cannot escape its own quotes', () => {
  const document = twiml('hello', 'Polly.Joanna" onX="');
  assert.equal(document.match(/"/g)?.length, 2, 'the voice attribute grew extra quotes');
});

check('the document is a single well-formed Response', () => {
  const document = twiml('hello', 'Polly.Joanna');
  assert.ok(document.startsWith('<Response><Say voice="Polly.Joanna">'));
  assert.ok(document.endsWith('</Say></Response>'));
});

/* -------------------------------------------------------------------------- */
/* parseCall                                                                   */
/* -------------------------------------------------------------------------- */

const good = { to: '+918448417051', say: 'Test reminder' };

check('accepts a well-formed request and defaults the voice', () => {
  const parsed = parseCall(good);
  assert.ok(parsed.ok);
  assert.equal(parsed.call.to, '+918448417051');
  assert.equal(parsed.call.voice, 'Polly.Joanna');
});

check('trims the spoken text', () => {
  const parsed = parseCall({ ...good, say: '  padded  ' });
  assert.ok(parsed.ok);
  assert.equal(parsed.call.say, 'padded');
});

check('rejects anything that is not E.164', () => {
  for (const to of ['8448417051', '+0448417051', '+91 8448 417051', '+91844841705112345', '', 'tel:+911234567']) {
    const parsed = parseCall({ ...good, to });
    assert.ok(!parsed.ok, `accepted ${JSON.stringify(to)}`);
    assert.equal(parsed.reason, 'to');
  }
});

check('rejects an empty or whitespace-only sentence', () => {
  for (const say of ['', '   ', '\n']) {
    const parsed = parseCall({ ...good, say });
    assert.ok(!parsed.ok, `accepted ${JSON.stringify(say)}`);
  }
});

check('bounds the sentence', () => {
  const parsed = parseCall({ ...good, say: 'a'.repeat(1001) });
  assert.ok(!parsed.ok);
  assert.equal(parsed.reason, 'say_too_long');
});

check('rejects a voice name that is not a bare identifier', () => {
  const parsed = parseCall({ ...good, voice: 'Polly.Joanna"><Dial>' });
  assert.ok(!parsed.ok);
  assert.equal(parsed.reason, 'voice');
});

check('rejects a non-object body', () => {
  for (const body of [null, 'string', 42, undefined]) {
    assert.ok(!parseCall(body).ok, `accepted ${JSON.stringify(body)}`);
  }
});

console.log(`\n${checks} checks passed\n`);

// `./index.ts` started a listener on import; nothing here needs it.
process.exit(0);
