// Shared logic for the per-product launch-notification capture endpoint
// (api/notify.js). Deliberately split from that file so the validation /
// allow-list / honeypot / rate-limit logic can be exercised in tests with
// NO network calls, and so the SendGrid client is a plain injectable
// dependency rather than something baked into the handler.
//
// Nothing in this file sends email. It only ever prepares a Marketing
// Contacts upsert; SendGrid itself is the only thing that could ever email
// the address, and this endpoint's SendGrid call intentionally never
// triggers a single/double opt-in send (see api/notify.js header).

import { readFileSync } from 'node:fs';

export const MAX_EMAIL_LENGTH = 320;
export const MAX_BODY_BYTES = 4096;

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Reasonable-but-not-paranoid email shape check. Never trusts the client. */
export function isValidEmail(email) {
  if (typeof email !== 'string') return false;
  const trimmed = email.trim();
  return (
    trimmed.length > 0 &&
    trimmed.length <= MAX_EMAIL_LENGTH &&
    EMAIL_RE.test(trimmed)
  );
}

let cachedAllowlist = null;

/**
 * The allow-list of product ids a signup may be tagged with, derived from
 * data/products.json — the same file the portfolio page itself renders
 * from. An id absent from that file is refused; this endpoint never
 * accepts an arbitrary free-text product name into the CRM.
 *
 * Cached after first read (module-level; a warm Vercel function instance
 * re-reads on cold start, which is exactly when products.json could have
 * changed). Pass { forceReload: true } to bypass the cache, e.g. in tests
 * that swap in a different fixture file.
 */
export function loadProductAllowlist({ forceReload = false, productsPath } = {}) {
  if (cachedAllowlist && !forceReload) return cachedAllowlist;
  const url = productsPath || new URL('../data/products.json', import.meta.url);
  const raw = readFileSync(url, 'utf8');
  const data = JSON.parse(raw);
  const ids = Array.isArray(data.products)
    ? data.products.map((p) => p && p.id).filter((id) => typeof id === 'string' && id.length > 0)
    : [];
  cachedAllowlist = new Set(ids);
  return cachedAllowlist;
}

/**
 * Pure validation — no I/O, no SendGrid, no fs. Takes the raw submitted
 * fields plus the allow-list Set (from loadProductAllowlist) and returns
 * either { ok: true, email, product } (both normalised: trimmed,
 * lower-cased) or { ok: false, reason }.
 *
 * reason is one of: 'honeypot' | 'missing_email' | 'invalid_email' |
 * 'missing_product' | 'invalid_product'.
 *
 * The honeypot check runs FIRST and short-circuits everything else — a
 * filled honeypot is rejected regardless of whether the rest of the
 * submission looks legitimate, and the caller (api/notify.js) is
 * responsible for turning that rejection into a neutral, bot-invisible
 * response rather than an error.
 */
export function validateSubmission({ email, product, _honey } = {}, allowedProducts) {
  if (_honey) {
    return { ok: false, reason: 'honeypot' };
  }

  const trimmedEmail = typeof email === 'string' ? email.trim() : '';
  if (!trimmedEmail) {
    return { ok: false, reason: 'missing_email' };
  }
  if (!isValidEmail(trimmedEmail)) {
    return { ok: false, reason: 'invalid_email' };
  }

  const trimmedProduct = typeof product === 'string' ? product.trim().toLowerCase() : '';
  if (!trimmedProduct) {
    return { ok: false, reason: 'missing_product' };
  }
  if (!allowedProducts || !allowedProducts.has(trimmedProduct)) {
    return { ok: false, reason: 'invalid_product' };
  }

  return { ok: true, email: trimmedEmail.toLowerCase(), product: trimmedProduct };
}

/**
 * Minimal in-memory-per-warm-instance rate limiter. Fixed window, keyed by
 * whatever string the caller passes (api/notify.js keys it by client IP).
 *
 * WHAT THIS STOPS: a burst from one client IP within one warm function
 * instance's lifetime — casual/naive abuse and a broken retry loop.
 * WHAT THIS DOES NOT STOP: a distributed attacker rotating IPs; an
 * attacker hitting a different (cold-started) instance, which starts with
 * an empty map — Vercel functions are not guaranteed to route the same IP
 * to the same warm instance, and this map is never shared across
 * instances/regions. A durable limiter would need Vercel KV/Upstash or
 * similar shared store; this is a best-effort speed bump only, documented
 * as such rather than oversold.
 */
export function createRateLimiter({ windowMs = 60_000, max = 5 } = {}) {
  const hits = new Map(); // key -> { count, resetAt }

  return {
    consume(key) {
      const now = Date.now();
      // Opportunistic cleanup so a long warm lifetime doesn't grow this
      // map unboundedly.
      if (hits.size > 10000) {
        for (const [k, v] of hits) {
          if (v.resetAt <= now) hits.delete(k);
        }
      }
      const entry = hits.get(key);
      if (!entry || entry.resetAt <= now) {
        hits.set(key, { count: 1, resetAt: now + windowMs });
        return true;
      }
      if (entry.count >= max) return false;
      entry.count += 1;
      return true;
    },
    // Test hook only.
    _size() {
      return hits.size;
    },
  };
}

/** Best-effort client IP from the headers Vercel's platform sets. */
export function getClientIp(req) {
  const headers = (req && req.headers) || {};
  const xff = headers['x-vercel-forwarded-for'] || headers['x-forwarded-for'];
  if (typeof xff === 'string' && xff.length > 0) {
    return xff.split(',')[0].trim();
  }
  if (req && req.socket && req.socket.remoteAddress) {
    return req.socket.remoteAddress;
  }
  return 'unknown';
}

/**
 * Builds the SendGrid Marketing Contacts client. `fetchImpl` is injectable
 * so tests never make a real network call and never need a real API key —
 * pass a fake that records calls and resolves/rejects as the test wants.
 *
 * Talks to PUT /v3/marketing/contacts, SendGrid's upsert endpoint: SendGrid
 * itself returns 202 with an async job id and does not tell the caller
 * whether the address was new or already present. That is used directly
 * as this endpoint's neutrality property — there is nothing synchronous
 * to leak even if we wanted to.
 *
 * Never logs the apiKey. On a non-2xx response only the HTTP status is
 * included in the thrown error, never the response body (which could
 * echo back the submitted email).
 */
export function createSendGridContactStore({ apiKey, fetchImpl, baseUrl = 'https://api.sendgrid.com' } = {}) {
  if (!apiKey) {
    throw new Error('createSendGridContactStore requires an apiKey');
  }
  const doFetch = fetchImpl || globalThis.fetch;
  if (typeof doFetch !== 'function') {
    throw new Error('createSendGridContactStore: no fetch implementation available');
  }

  return {
    /**
     * productId: the validated, allow-listed product id — written into the
     *   notify_product custom field (fieldId) so every contact is tagged.
     * listId: optional SendGrid list id for this product. When absent
     *   (list not yet provisioned for this product in SendGrid), the
     *   contact is still upserted and still tagged via the custom field —
     *   list membership is skipped, not fatal. See api/notify.js header
     *   for the env var that supplies this per product.
     * fieldId: the SendGrid-generated custom field id (not name) for
     *   notify_product — required; api/notify.js fails closed before
     *   calling this if it is unset.
     */
    async upsertContact({ email, productId, fieldId, listId }) {
      const contact = { email };
      if (fieldId) {
        contact.custom_fields = { [fieldId]: productId };
      }
      const payload = { contacts: [contact] };
      if (listId) {
        payload.list_ids = [listId];
      }

      const res = await doFetch(`${baseUrl}/v3/marketing/contacts`, {
        method: 'PUT',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
      });

      if (!res || !res.ok) {
        const status = res ? res.status : 'no response';
        throw new Error(`SendGrid contact upsert returned ${status}`);
      }
      return true;
    },
  };
}
