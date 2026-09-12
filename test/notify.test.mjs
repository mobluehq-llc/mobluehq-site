// Falsifier-first tests for the launch-notification capture endpoint.
// Run with: node --test test/notify.test.mjs
// (Node 24 prefixes summary lines with "ℹ", not "#" — read the
// PASS/FAIL counts and the individual "ok"/"not ok" TAP lines, never grep
// for "#".)
//
// No network calls anywhere in this file. The SendGrid client is a fake
// that records what it was called with; a test that expects SendGrid to
// be skipped (honeypot, missing API key) asserts the fake was never
// invoked, not just that the HTTP response looked right.

import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  isValidEmail,
  loadProductAllowlist,
  validateSubmission,
  createRateLimiter,
  getClientIp,
  createSendGridContactStore,
} from '../lib/notify.mjs';

import { handleRequest } from '../api/notify.js';

// ---------------------------------------------------------------------
// Test doubles
// ---------------------------------------------------------------------

function makeRes() {
  return {
    statusCode: null,
    headers: {},
    body: null,
    ended: false,
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
    writeHead(code, headers) {
      this.statusCode = code;
      Object.assign(this.headers, headers || {});
    },
    end() {
      this.ended = true;
    },
  };
}

function makeReq({ method = 'POST', body = {}, headers = {} } = {}) {
  return {
    method,
    body,
    headers: {
      accept: 'application/json',
      'content-type': 'application/json',
      ...headers,
    },
    socket: { remoteAddress: '203.0.113.9' },
  };
}

// Each handler test that isn't specifically exercising rate-limiting gets
// its own fresh, high-ceiling limiter — without this, every test in this
// file would share api/notify.js's module-level singleton limiter (same
// hardcoded test IP throughout), and an EARLIER test's requests would
// exhaust an UNRELATED LATER test's quota. That is a test-isolation bug,
// not a product bug; the rate-limit test below builds its own low-max
// limiter on purpose.
function freshLimiter() {
  return createRateLimiter({ windowMs: 60_000, max: 1000 });
}

function makeFakeStore(behavior) {
  const calls = [];
  return {
    calls,
    factory: () => ({
      async upsertContact(args) {
        calls.push(args);
        if (behavior === 'throw') {
          throw new Error('simulated SendGrid failure');
        }
        return true;
      },
    }),
  };
}

const ALLOWED = new Set(['bluemoat', 'blueparity', 'bluemonster']);

// ---------------------------------------------------------------------
// Pure logic: validateSubmission / isValidEmail
// ---------------------------------------------------------------------

test('validateSubmission rejects a honeypot fill regardless of otherwise-valid fields', () => {
  const result = validateSubmission(
    { email: 'real@example.com', product: 'bluemoat', _honey: 'i-am-a-bot' },
    ALLOWED,
  );
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'honeypot');
});

test('validateSubmission rejects an off-allow-list product', () => {
  const result = validateSubmission(
    { email: 'real@example.com', product: 'totally-made-up-product' },
    ALLOWED,
  );
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'invalid_product');
});

test('validateSubmission rejects a malformed email', () => {
  const result = validateSubmission(
    { email: 'not-an-email', product: 'bluemoat' },
    ALLOWED,
  );
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'invalid_email');
});

test('validateSubmission accepts a well-formed submission and normalises case', () => {
  const result = validateSubmission(
    { email: '  Real@Example.com  ', product: 'BlueMoat' },
    ALLOWED,
  );
  assert.deepEqual(result, { ok: true, email: 'real@example.com', product: 'bluemoat' });
});

test('isValidEmail rejects obvious garbage and accepts a normal address', () => {
  assert.equal(isValidEmail('nope'), false);
  assert.equal(isValidEmail('nope@'), false);
  assert.equal(isValidEmail('@nope.com'), false);
  assert.equal(isValidEmail(''), false);
  assert.equal(isValidEmail(null), false);
  assert.equal(isValidEmail('a@b.co'), true);
});

test('loadProductAllowlist derives ids from a products.json fixture, not a hardcoded list', () => {
  const dir = mkdtempSync(join(tmpdir(), 'notify-test-'));
  const fixturePath = join(dir, 'products.json');
  writeFileSync(
    fixturePath,
    JSON.stringify({ products: [{ id: 'fooproduct' }, { id: 'barproduct' }, {}] }),
  );
  const allowlist = loadProductAllowlist({ forceReload: true, productsPath: fixturePath });
  assert.equal(allowlist.has('fooproduct'), true);
  assert.equal(allowlist.has('barproduct'), true);
  assert.equal(allowlist.has('nonexistent'), false);
  // Restore the real cache for any later test in this process.
  loadProductAllowlist({ forceReload: true });
});

// ---------------------------------------------------------------------
// Rate limiter
// ---------------------------------------------------------------------

test('createRateLimiter allows up to max, then blocks within the window', () => {
  const limiter = createRateLimiter({ windowMs: 60_000, max: 3 });
  assert.equal(limiter.consume('1.2.3.4'), true);
  assert.equal(limiter.consume('1.2.3.4'), true);
  assert.equal(limiter.consume('1.2.3.4'), true);
  assert.equal(limiter.consume('1.2.3.4'), false);
  // A different key is unaffected by the first key's usage.
  assert.equal(limiter.consume('5.6.7.8'), true);
});

test('getClientIp reads the first address from x-forwarded-for', () => {
  const ip = getClientIp({ headers: { 'x-forwarded-for': '9.9.9.9, 1.1.1.1' } });
  assert.equal(ip, '9.9.9.9');
});

// ---------------------------------------------------------------------
// createSendGridContactStore — network shape only, via a fake fetch
// ---------------------------------------------------------------------

test('createSendGridContactStore throws without an apiKey', () => {
  assert.throws(() => createSendGridContactStore({ apiKey: '' }));
});

test('createSendGridContactStore PUTs to the marketing contacts endpoint with the field and list ids', async () => {
  let captured = null;
  const fakeFetch = async (url, opts) => {
    captured = { url, opts };
    return { ok: true, status: 202 };
  };
  const store = createSendGridContactStore({ apiKey: 'fake-key', fetchImpl: fakeFetch });
  await store.upsertContact({
    email: 'a@b.com',
    productId: 'bluemoat',
    fieldId: 'e1_T',
    listId: 'list-123',
  });
  assert.equal(captured.url, 'https://api.sendgrid.com/v3/marketing/contacts');
  assert.equal(captured.opts.method, 'PUT');
  assert.equal(captured.opts.headers.Authorization, 'Bearer fake-key');
  const body = JSON.parse(captured.opts.body);
  assert.equal(body.list_ids[0], 'list-123');
  assert.equal(body.contacts[0].email, 'a@b.com');
  assert.equal(body.contacts[0].custom_fields.e1_T, 'bluemoat');
});

test('createSendGridContactStore throws on a non-ok response, never swallowing the failure', async () => {
  const fakeFetch = async () => ({ ok: false, status: 401 });
  const store = createSendGridContactStore({ apiKey: 'fake-key', fetchImpl: fakeFetch });
  await assert.rejects(() =>
    store.upsertContact({ email: 'a@b.com', productId: 'bluemoat', fieldId: 'e1_T' }),
  );
});

// ---------------------------------------------------------------------
// handleRequest (api/notify.js) — full handler, fake store injected,
// real env vars for SENDGRID_API_KEY / SENDGRID_NOTIFY_FIELD_ID
// save/restored around each test that touches them.
// ---------------------------------------------------------------------

function withEnv(vars, fn) {
  const prevValues = {};
  for (const k of Object.keys(vars)) {
    prevValues[k] = process.env[k];
    if (vars[k] === undefined) delete process.env[k];
    else process.env[k] = vars[k];
  }
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      for (const k of Object.keys(vars)) {
        if (prevValues[k] === undefined) delete process.env[k];
        else process.env[k] = prevValues[k];
      }
    });
}

test('handleRequest rejects non-POST with 405', async () => {
  const req = makeReq({ method: 'GET' });
  const res = makeRes();
  await handleRequest(req, res, {});
  assert.equal(res.statusCode, 405);
});

test('handleRequest fails CLOSED when SENDGRID_API_KEY is unset — never calls the store, never silently succeeds', async () => {
  await withEnv({ SENDGRID_API_KEY: undefined, SENDGRID_NOTIFY_FIELD_ID: 'e1_T' }, async () => {
    const fake = makeFakeStore();
    const req = makeReq({ body: { email: 'a@b.com', product: 'bluemoat' } });
    const res = makeRes();
    await handleRequest(req, res, { storeFactory: fake.factory, limiter: freshLimiter() });
    assert.equal(res.statusCode, 500);
    assert.equal(res.body.ok, false);
    assert.equal(fake.calls.length, 0, 'SendGrid must never be called when the key is missing');
  });
});

test('handleRequest fails CLOSED when SENDGRID_NOTIFY_FIELD_ID is unset', async () => {
  await withEnv({ SENDGRID_API_KEY: 'fake-key', SENDGRID_NOTIFY_FIELD_ID: undefined }, async () => {
    const fake = makeFakeStore();
    const req = makeReq({ body: { email: 'a@b.com', product: 'bluemoat' } });
    const res = makeRes();
    await handleRequest(req, res, { storeFactory: fake.factory, limiter: freshLimiter() });
    assert.equal(res.statusCode, 500);
    assert.equal(fake.calls.length, 0);
  });
});

test('handleRequest rejects a honeypot fill with the SAME neutral success shape, but never calls SendGrid', async () => {
  await withEnv({ SENDGRID_API_KEY: 'fake-key', SENDGRID_NOTIFY_FIELD_ID: 'e1_T' }, async () => {
    const fake = makeFakeStore();
    const req = makeReq({ body: { email: 'a@b.com', product: 'bluemoat', _honey: 'gotcha' } });
    const res = makeRes();
    await handleRequest(req, res, { storeFactory: fake.factory, limiter: freshLimiter() });
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.ok, true);
    assert.equal(fake.calls.length, 0, 'a honeypot fill must never reach SendGrid');
  });
});

test('handleRequest rejects an off-allow-list product with 400 and never calls SendGrid', async () => {
  await withEnv({ SENDGRID_API_KEY: 'fake-key', SENDGRID_NOTIFY_FIELD_ID: 'e1_T' }, async () => {
    const fake = makeFakeStore();
    const req = makeReq({ body: { email: 'a@b.com', product: 'not-a-real-product' } });
    const res = makeRes();
    await handleRequest(req, res, { storeFactory: fake.factory, limiter: freshLimiter() });
    assert.equal(res.statusCode, 400);
    assert.equal(res.body.ok, false);
    assert.equal(fake.calls.length, 0);
  });
});

test('handleRequest rejects a malformed email with 400 and never calls SendGrid', async () => {
  await withEnv({ SENDGRID_API_KEY: 'fake-key', SENDGRID_NOTIFY_FIELD_ID: 'e1_T' }, async () => {
    const fake = makeFakeStore();
    const req = makeReq({ body: { email: 'not-an-email', product: 'bluemoat' } });
    const res = makeRes();
    await handleRequest(req, res, { storeFactory: fake.factory, limiter: freshLimiter() });
    assert.equal(res.statusCode, 400);
    assert.equal(fake.calls.length, 0);
  });
});

test('handleRequest accepts a valid submission, calls SendGrid exactly once with the right tag, and returns neutral success', async () => {
  await withEnv({ SENDGRID_API_KEY: 'fake-key', SENDGRID_NOTIFY_FIELD_ID: 'e1_T' }, async () => {
    const fake = makeFakeStore();
    const req = makeReq({ body: { email: 'Real@Example.com', product: 'BlueMoat' } });
    const res = makeRes();
    await handleRequest(req, res, { storeFactory: fake.factory, limiter: freshLimiter() });
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.ok, true);
    assert.equal(fake.calls.length, 1);
    assert.equal(fake.calls[0].email, 'real@example.com');
    assert.equal(fake.calls[0].productId, 'bluemoat');
    assert.equal(fake.calls[0].fieldId, 'e1_T');
  });
});

test('handleRequest returns the identical success body for a brand-new address and a SendGrid-already-knows-it address', async () => {
  await withEnv({ SENDGRID_API_KEY: 'fake-key', SENDGRID_NOTIFY_FIELD_ID: 'e1_T' }, async () => {
    // SendGrid's real PUT /v3/marketing/contacts is itself async (202, no
    // new-vs-existing signal) — the fake here just proves our handler adds
    // no leak of its own on top of that.
    const fake = makeFakeStore();
    const resNew = makeRes();
    await handleRequest(makeReq({ body: { email: 'new@example.com', product: 'bluemoat' } }), resNew, {
      storeFactory: fake.factory,
    });
    const resExisting = makeRes();
    await handleRequest(
      makeReq({ body: { email: 'existing@example.com', product: 'bluemoat' } }),
      resExisting,
      { storeFactory: fake.factory, limiter: freshLimiter() },
    );
    assert.deepEqual(resNew.body, resExisting.body);
  });
});

test('handleRequest surfaces a SendGrid failure as a 502 without pretending success', async () => {
  await withEnv({ SENDGRID_API_KEY: 'fake-key', SENDGRID_NOTIFY_FIELD_ID: 'e1_T' }, async () => {
    const fake = makeFakeStore('throw');
    const req = makeReq({ body: { email: 'a@b.com', product: 'bluemoat' } });
    const res = makeRes();
    await handleRequest(req, res, { storeFactory: fake.factory, limiter: freshLimiter() });
    assert.equal(res.statusCode, 502);
    assert.equal(res.body.ok, false);
  });
});

test('handleRequest rejects an oversized body with 413 before touching SendGrid', async () => {
  await withEnv({ SENDGRID_API_KEY: 'fake-key', SENDGRID_NOTIFY_FIELD_ID: 'e1_T' }, async () => {
    const fake = makeFakeStore();
    const req = makeReq({
      body: { email: 'a@b.com', product: 'bluemoat' },
      headers: { 'content-length': String(10 * 1024 * 1024) },
    });
    const res = makeRes();
    await handleRequest(req, res, { storeFactory: fake.factory, limiter: freshLimiter() });
    assert.equal(res.statusCode, 413);
    assert.equal(fake.calls.length, 0);
  });
});

test('handleRequest rate-limits repeated requests from the same IP', async () => {
  await withEnv({ SENDGRID_API_KEY: 'fake-key', SENDGRID_NOTIFY_FIELD_ID: 'e1_T' }, async () => {
    const fake = makeFakeStore();
    const limiter = createRateLimiter({ windowMs: 60_000, max: 2 });
    const results = [];
    for (let i = 0; i < 3; i++) {
      const res = makeRes();
      await handleRequest(
        makeReq({ body: { email: 'a@b.com', product: 'bluemoat' } }),
        res,
        { storeFactory: fake.factory, limiter },
      );
      results.push(res.statusCode);
    }
    assert.deepEqual(results, [200, 200, 429]);
    assert.equal(fake.calls.length, 2, 'the rate-limited 3rd request must not reach SendGrid');
  });
});

test('handleRequest falls back to a 303 redirect (not JSON) for a native no-JS form POST', async () => {
  await withEnv({ SENDGRID_API_KEY: 'fake-key', SENDGRID_NOTIFY_FIELD_ID: 'e1_T' }, async () => {
    const fake = makeFakeStore();
    const req = makeReq({
      body: { email: 'a@b.com', product: 'bluemoat' },
      headers: {
        accept: 'text/html,application/xhtml+xml',
        'content-type': 'application/x-www-form-urlencoded',
        referer: 'https://www.mobluehq.com/portfolio/bluemoat',
      },
    });
    const res = makeRes();
    await handleRequest(req, res, { storeFactory: fake.factory, limiter: freshLimiter() });
    assert.equal(res.statusCode, 303);
    assert.match(res.headers.Location, /^https:\/\/www\.mobluehq\.com\/portfolio\/bluemoat\?notified=1$/);
  });
});
