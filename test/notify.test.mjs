// Falsifiers for the consolidated contact route (api/notify.js) and its
// pure helpers (lib/notify.mjs). No real network call is ever made here —
// every external boundary (SendGrid, Anthropic) is a fake injected via
// createNotifyHandler(). Run with: node --test test/notify.test.mjs
//
// Node 24's `node --test` summary lines start with `ℹ`, not `#` — that is
// expected, not a failure.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createNotifyHandler } from '../api/notify.js';
import {
  buildMailPayload,
  buildSubmission,
  isHoneypotTriggered,
  sanitizeReplyTo,
} from '../lib/notify.mjs';
import { NotifyConfigError, NotifySendError, sendMail } from '../lib/sendgridClient.mjs';

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

test('a real submission sends exactly one correctly-shaped SendGrid request', async () => {
  const { httpClient, calls } = makeFakeHttpClient();
  const handler = createNotifyHandler({
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
  const handler = createNotifyHandler({
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

test('a missing SendGrid key produces a visible error and never a success response', async () => {
  const { httpClient, calls } = makeFakeHttpClient();
  const handler = createNotifyHandler({
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
  const handler = createNotifyHandler({
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
  const handler = createNotifyHandler({
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
  const handler = createNotifyHandler({ httpClient, sendGridApiKey: () => 'k' });
  const res = mockRes();
  await handler({ method: 'GET', body: {} }, res);
  assert.equal(res.statusCode, 405);
});
