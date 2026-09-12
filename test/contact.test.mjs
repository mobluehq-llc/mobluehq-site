// Falsifiers for the consolidated contact route (api/contact.js) and its
// pure helpers (lib/contact.mjs). No real network call is ever made here —
// every external boundary (SendGrid, Anthropic) is a fake injected via
// createContactHandler(). Run with: node --test test/contact.test.mjs
//
// Node 24's `node --test` summary lines start with `ℹ`, not `#` — that is
// expected, not a failure.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createContactHandler } from '../api/contact.js';
import {
  buildMailPayload,
  buildSubmission,
  isHoneypotTriggered,
  sanitizeReplyTo,
} from '../lib/contact.mjs';
import { NotifyConfigError, NotifySendError, sendMail } from '../lib/sendgridClient.mjs';
import { createRateLimiter, getClientIp } from '../lib/rateLimiter.mjs';

const SENDGRID_URL = 'https://api.sendgrid.com/v3/mail/send';

function mockRes() {
  const res = {
    statusCode: null,
    body: undefined,
    ended: false,
    headers: {},
    setHeader(k, v) {
      this.headers[k] = v;
    },
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(obj) {
      this.body = obj;
      return this;
    },
    end() {
      this.ended = true;
      return this;
    },
  };
  return res;
}

/** Fake fetch that records every call and answers SendGrid (202) and
 * Anthropic (a canned classification) deterministically. Tests override
 * `sendgridStatus` / `anthropicEvaluation` per-case. */
function makeFakeHttpClient({ sendgridStatus = 202, anthropicEvaluation } = {}) {
  const calls = [];
  const httpClient = async (url, options) => {
    calls.push({ url, options });
    if (url === SENDGRID_URL) {
      return {
        status: sendgridStatus,
        async text() {
          return sendgridStatus === 202 ? '' : '{"errors":[{"message":"forced test failure"}]}';
        },
      };
    }
    // Anthropic messages endpoint
    const evaluation =
      anthropicEvaluation ??
      { substantiveness: 1, sender_type: 'spam', confidence: 9, route: 'log', reasoning: 'Low-value test fixture.' };
    return {
      ok: true,
      status: 200,
      async json() {
        return { content: [{ type: 'text', text: JSON.stringify(evaluation) }] };
      },
      async text() {
        return JSON.stringify(evaluation);
      },
    };
  };
  return { httpClient, calls };
}

function baseReq(body) {
  return { method: 'POST', body };
}

function reqFromIp(ip, body) {
  return { method: 'POST', body, headers: { 'x-forwarded-for': ip } };
}

test('a real submission sends exactly one correctly-shaped SendGrid request', async () => {
  const { httpClient, calls } = makeFakeHttpClient();
  const handler = createContactHandler({
    httpClient,
    sendGridApiKey: () => 'sg-test-key',
    anthropicApiKey: () => 'anthropic-test-key',
  });
  const res = mockRes();
  await handler(
    baseReq({
      source: 'contact',
      name: 'Jane Prospect',
      email: 'jane@example.com',
      message: 'We would like to license blueMonster for our team.',
    }),
    res
  );

  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, { ok: true });

  const sendgridCalls = calls.filter((c) => c.url === SENDGRID_URL);
  assert.equal(sendgridCalls.length, 1, 'expected exactly one SendGrid call');

  const { options } = sendgridCalls[0];
  assert.equal(options.method, 'POST');
  assert.equal(options.headers.Authorization, 'Bearer sg-test-key');
  const payload = JSON.parse(options.body);
  assert.deepEqual(payload.personalizations, [{ to: [{ email: 'blue@mobluehq.com' }] }]);
  assert.deepEqual(payload.from, { email: 'blue@mobluehq.com', name: 'MOBLUEHQ Website' });
  assert.deepEqual(payload.reply_to, { email: 'jane@example.com' });
  assert.equal(typeof payload.subject, 'string');
  assert.ok(payload.subject.length > 0);
  assert.equal(payload.content[0].type, 'text/plain');
  assert.match(payload.content[0].value, /license blueMonster/);
});

test('a message triage classifies as low-value is STILL sent', async () => {
  const { httpClient, calls } = makeFakeHttpClient({
    anthropicEvaluation: {
      substantiveness: 1,
      sender_type: 'spam',
      confidence: 10,
      route: 'log', // the lowest-priority triage verdict
      reasoning: 'Looks like spam.',
    },
  });
  const handler = createContactHandler({
    httpClient,
    sendGridApiKey: () => 'sg-test-key',
    anthropicApiKey: () => 'anthropic-test-key',
  });
  const res = mockRes();
  await handler(
    baseReq({
      source: 'investors',
      message: 'This message is deliberately low-substance filler text for the test.',
    }),
    res
  );

  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, { ok: true });

  const sendgridCalls = calls.filter((c) => c.url === SENDGRID_URL);
  assert.equal(sendgridCalls.length, 1, 'a "log"-routed, low-substantiveness message must still be sent');
  const payload = JSON.parse(sendgridCalls[0].options.body);
  // The verdict is allowed to appear IN the email; it must never have kept
  // the email from being sent (asserted above by the call count).
  assert.match(payload.content[0].value, /route=log/);
});

test('triage failing outright (classifier throws) still sends the message', async () => {
  const { httpClient, calls } = makeFakeHttpClient();
  const throwingClassify = async () => {
    throw new Error('simulated classifier failure (e.g. a dead model pin returning a non-2xx)');
  };
  const handler = createContactHandler({
    httpClient,
    classify: throwingClassify,
    sendGridApiKey: () => 'sg-test-key',
    anthropicApiKey: () => 'anthropic-test-key',
  });
  const res = mockRes();
  await handler(
    baseReq({
      source: 'contact',
      name: 'A',
      email: 'a@example.com',
      message: 'A perfectly fine message body for this test.',
    }),
    res
  );

  assert.equal(res.statusCode, 200, 'a triage failure must never prevent the send');
  assert.deepEqual(res.body, { ok: true });
  const sendgridCalls = calls.filter((c) => c.url === SENDGRID_URL);
  assert.equal(sendgridCalls.length, 1, 'exactly one send must happen despite the classifier throwing');
  const payload = JSON.parse(sendgridCalls[0].options.body);
  assert.match(
    payload.content[0].value,
    /Triage: not available for this message \(classifier error or unconfigured\) — sent anyway\./
  );
});

test('a missing SendGrid key produces a visible error and never a success response', async () => {
  const { httpClient, calls } = makeFakeHttpClient();
  const handler = createContactHandler({
    httpClient,
    sendGridApiKey: () => undefined, // key not configured
    anthropicApiKey: () => undefined,
  });
  const res = mockRes();
  await handler(baseReq({ source: 'waitlist', email: 'lead@example.com' }), res);

  assert.notEqual(res.statusCode, 200, 'must not report success for an unsent message');
  assert.equal(res.body.ok, false);
  const sendgridCalls = calls.filter((c) => c.url === SENDGRID_URL);
  assert.equal(sendgridCalls.length, 0, 'no SendGrid call should be attempted without a key');
});

test('sendMail() itself throws NotifyConfigError with no key, without calling httpClient', async () => {
  const { httpClient, calls } = makeFakeHttpClient();
  await assert.rejects(() => sendMail({ subject: 'x' }, { apiKey: undefined, httpClient }), NotifyConfigError);
  assert.equal(calls.length, 0);
});

test('a SendGrid non-202 surfaces as failure, never success', async () => {
  const { httpClient } = makeFakeHttpClient({ sendgridStatus: 400 });
  const handler = createContactHandler({
    httpClient,
    sendGridApiKey: () => 'sg-test-key',
    anthropicApiKey: () => undefined,
  });
  const res = mockRes();
  await handler(
    baseReq({ source: 'contact', name: 'A', email: 'a@example.com', message: 'Please get back to us soon.' }),
    res
  );

  assert.notEqual(res.statusCode, 200);
  assert.equal(res.body.ok, false);
});

test('sendMail() throws NotifySendError on a non-202 response', async () => {
  const { httpClient } = makeFakeHttpClient({ sendgridStatus: 500 });
  await assert.rejects(() => sendMail({ subject: 'x' }, { apiKey: 'k', httpClient }), NotifySendError);
});

test('a honeypot fill sends nothing and returns neutral success', async () => {
  const { httpClient, calls } = makeFakeHttpClient();
  const handler = createContactHandler({
    httpClient,
    sendGridApiKey: () => 'sg-test-key',
    anthropicApiKey: () => 'anthropic-test-key',
  });
  const res = mockRes();
  await handler(
    baseReq({
      source: 'contact',
      name: 'Bot',
      email: 'bot@example.com',
      message: 'This should never arrive.',
      _honey: 'I am a bot',
    }),
    res
  );

  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, { ok: true }, 'response must look identical to a real success — no tell for the bot');
  assert.equal(calls.length, 0, 'neither SendGrid nor Anthropic should be called');
});

test('isHoneypotTriggered() is true only for a non-empty value', () => {
  assert.equal(isHoneypotTriggered({ _honey: 'x' }), true);
  assert.equal(isHoneypotTriggered({ _honey: '' }), false);
  assert.equal(isHoneypotTriggered({ _honey: '   ' }), false);
  assert.equal(isHoneypotTriggered({}), false);
});

test('a malicious reply_to with a newline is rejected (no header injection)', () => {
  assert.equal(sanitizeReplyTo('victim@example.com\r\nBcc: attacker@evil.com'), null);
  assert.equal(sanitizeReplyTo('victim@example.com\nX-Injected: true'), null);
});

test('a malicious reply_to with multiple addresses is rejected', () => {
  assert.equal(sanitizeReplyTo('a@example.com,b@example.com'), null);
  assert.equal(sanitizeReplyTo('a@example.com;b@example.com'), null);
});

test('a well-formed reply_to is accepted and trimmed', () => {
  assert.equal(sanitizeReplyTo('  person@example.com  '), 'person@example.com');
});

test('buildMailPayload never sets reply_to for a malicious or missing email', () => {
  const submission = buildSubmission(
    { source: 'investors', message: 'A perfectly fine investor message of sufficient length.' },
    'investors'
  );
  const payload = buildMailPayload(submission, null);
  assert.equal('reply_to' in payload, false);
});

test('buildSubmission requires name+email+message for contact, throws ValidationError otherwise', () => {
  assert.throws(() => buildSubmission({ email: 'a@example.com', message: 'hello there world' }, 'contact'));
  assert.throws(() => buildSubmission({ name: 'A', message: 'hello there world' }, 'contact'));
  assert.throws(() => buildSubmission({ name: 'A', email: 'a@example.com', message: 'short' }, 'contact'));
  const ok = buildSubmission(
    { name: 'A', email: 'a@example.com', message: 'A perfectly adequate message body.' },
    'contact'
  );
  assert.equal(ok.name, 'A');
});

test('buildSubmission requires only a valid email for waitlist and synthesizes a message', () => {
  const ok = buildSubmission({ email: 'lead@example.com', product: 'blueGlu' }, 'waitlist');
  assert.match(ok.message, /blueGlu/);
  assert.throws(() => buildSubmission({ email: 'not-an-email' }, 'waitlist'));
});

test('buildSubmission requires only a message for investors', () => {
  assert.throws(() => buildSubmission({ message: 'short' }, 'investors'));
  const ok = buildSubmission({ message: 'A sufficiently long investor message body here.' }, 'investors');
  assert.equal(ok.source, 'investors');
  assert.equal(ok.name, '');
});

test('a non-POST method is rejected', async () => {
  const { httpClient } = makeFakeHttpClient();
  const handler = createContactHandler({ httpClient, sendGridApiKey: () => 'k' });
  const res = mockRes();
  await handler({ method: 'GET', body: {} }, res);
  assert.equal(res.statusCode, 405);
});

test('a working triage response puts its verdict in the subject line', async () => {
  const { httpClient, calls } = makeFakeHttpClient({
    anthropicEvaluation: {
      substantiveness: 9,
      sender_type: 'investor',
      confidence: 9,
      route: 'forward',
      reasoning: 'Looks like a real fund reaching out.',
    },
  });
  const handler = createContactHandler({
    httpClient,
    sendGridApiKey: () => 'sg-test-key',
    anthropicApiKey: () => 'anthropic-test-key',
  });
  const res = mockRes();
  await handler(
    baseReq({
      source: 'investors',
      name: 'Jamie Fund',
      email: 'jamie@examplefund.com',
      message: 'We are evaluating a term sheet and would like to talk this week.',
    }),
    res
  );

  assert.equal(res.statusCode, 200);
  const sendgridCalls = calls.filter((c) => c.url === SENDGRID_URL);
  assert.equal(sendgridCalls.length, 1);
  const payload = JSON.parse(sendgridCalls[0].options.body);
  assert.match(payload.subject, /\[forward\/investor\]/, 'a working triage verdict must appear in the subject line');
});

test('rate limiting: the 6th request from one IP inside the window gets 429 and sends nothing', async () => {
  const { httpClient, calls } = makeFakeHttpClient();
  const rateLimiter = createRateLimiter({ windowMs: 10 * 60 * 1000, max: 5 });
  const handler = createContactHandler({
    httpClient,
    sendGridApiKey: () => 'sg-test-key',
    anthropicApiKey: () => undefined,
    rateLimiter,
  });

  const ip = '203.0.113.7';
  const submission = () =>
    reqFromIp(ip, { source: 'contact', name: 'A', email: 'a@example.com', message: 'A perfectly fine message body.' });

  const results = [];
  for (let i = 0; i < 6; i++) {
    const res = mockRes();
    await handler(submission(), res);
    results.push(res);
  }

  const allowed = results.slice(0, 5);
  const blocked = results[5];

  for (const res of allowed) {
    assert.equal(res.statusCode, 200, 'the first 5 requests in the window must all succeed');
  }
  assert.equal(blocked.statusCode, 429, 'the 6th request in the window must be rejected');
  assert.equal(blocked.body.ok, false);
  assert.ok(blocked.headers['Retry-After'], 'a 429 should tell the client when to retry');

  const sendgridCalls = calls.filter((c) => c.url === SENDGRID_URL);
  assert.equal(sendgridCalls.length, 5, 'exactly 5 sends happened; the 6th (blocked) request sent nothing');
});

test('rate limiting: a normal person resubmitting once (2 requests) is not blocked', async () => {
  const { httpClient, calls } = makeFakeHttpClient();
  const rateLimiter = createRateLimiter({ windowMs: 10 * 60 * 1000, max: 5 });
  const handler = createContactHandler({
    httpClient,
    sendGridApiKey: () => 'sg-test-key',
    anthropicApiKey: () => undefined,
    rateLimiter,
  });

  const ip = '198.51.100.42';
  const body = { source: 'contact', name: 'Typo Fixer', email: 'typo@example.com', message: 'Wooops, meant to say hi.' };

  const res1 = mockRes();
  await handler(reqFromIp(ip, body), res1);
  const res2 = mockRes();
  await handler(reqFromIp(ip, { ...body, message: 'Oops, meant to say hi properly this time.' }), res2);

  assert.equal(res1.statusCode, 200, 'first submission must succeed');
  assert.equal(res2.statusCode, 200, 'a single resubmission (typo fix) must not be blocked');
  const sendgridCalls = calls.filter((c) => c.url === SENDGRID_URL);
  assert.equal(sendgridCalls.length, 2);
});

test('rate limiting: a request from a different IP is unaffected by another IP exhausting its limit', async () => {
  const { httpClient, calls } = makeFakeHttpClient();
  const rateLimiter = createRateLimiter({ windowMs: 10 * 60 * 1000, max: 5 });
  const handler = createContactHandler({
    httpClient,
    sendGridApiKey: () => 'sg-test-key',
    anthropicApiKey: () => undefined,
    rateLimiter,
  });

  const floodedIp = '203.0.113.99';
  const otherIp = '203.0.113.100';
  const body = { source: 'contact', name: 'A', email: 'a@example.com', message: 'A perfectly fine message body.' };

  for (let i = 0; i < 5; i++) {
    const res = mockRes();
    await handler(reqFromIp(floodedIp, body), res);
    assert.equal(res.statusCode, 200);
  }
  // floodedIp is now exhausted for this window.
  const blockedRes = mockRes();
  await handler(reqFromIp(floodedIp, body), blockedRes);
  assert.equal(blockedRes.statusCode, 429);

  // A different IP must be completely unaffected.
  const otherRes = mockRes();
  await handler(reqFromIp(otherIp, body), otherRes);
  assert.equal(otherRes.statusCode, 200, 'a different IP must not be rate limited by another IP\'s activity');

  const sendgridCalls = calls.filter((c) => c.url === SENDGRID_URL);
  assert.equal(sendgridCalls.length, 6, '5 from the flooded IP + 1 from the other IP');
});

test('getClientIp() reads the first entry of x-forwarded-for, ignoring later (spoofable) hops', () => {
  assert.equal(getClientIp({ headers: { 'x-forwarded-for': '1.2.3.4, 5.6.7.8' } }), '1.2.3.4');
  assert.equal(getClientIp({ headers: { 'x-forwarded-for': '1.2.3.4' } }), '1.2.3.4');
  assert.equal(getClientIp({ headers: { 'x-real-ip': '9.9.9.9' } }), '9.9.9.9');
  assert.equal(getClientIp({ headers: {} }), 'unknown');
  assert.equal(getClientIp({}), 'unknown');
});
