// Vercel serverless function (Node.js runtime): per-product launch-
// notification capture. NEW FILE — follows the shape of api/demo-gate.js /
// api/healthcare-gate.js / api/download.js: explicit method check,
// explicit env check that fails CLOSED (500) when misconfigured, and a
// defensively-parsed body. Validation/allow-list/honeypot/rate-limit logic
// lives in ../lib/notify.mjs so it can be unit tested with zero network
// calls; the SendGrid client is injected via `storeFactory` in
// handleRequest for the same reason (see test/notify.test.mjs).
//
// POST /api/notify   { email, product, _honey }
//   - JSON body (Content-Type: application/json, sent by the
//     progressive-enhancement snippet at assets/notify-capture.js) ->
//     JSON response { ok: true } or { ok: false, error }.
//   - application/x-www-form-urlencoded body (a plain, real <form> POST
//     with no JavaScript at all — Vercel's default Node body parser
//     handles this content type the same way it handles JSON) -> 303
//     redirect back to the referring page with ?notified=1 (or
//     ?notify_error=1) appended, so the capture point works with
//     JavaScript fully disabled. See assets/notify-capture.js for the
//     exact markup this expects.
//
// Sends NO email of any kind — no confirmation, no welcome, nothing. This
// endpoint's only side effect is a SendGrid Marketing Contacts upsert.
// privacy.html is still a placeholder ("pending publication") as of
// 2026-09-12 and no sending has been cleared; double opt-in is the right
// eventual design and is explicitly follow-on work, not built here.
//
// Never handles a credential: this file only ever READS
// process.env.SENDGRID_API_KEY. It is never logged, echoed, returned to
// the client, or written anywhere. If it (or the custom-field id below) is
// unset, the endpoint fails CLOSED with a generic 500 — there is no
// fallback storage path of any kind.
//
// ---------------------------------------------------------------------
// Required env vars
//   SENDGRID_API_KEY          A key scoped to Marketing > Contacts (write).
//   SENDGRID_NOTIFY_FIELD_ID  The SendGrid-GENERATED id (not the name) of
//                              the "notify_product" custom field — see the
//                              setup checklist below for where this comes
//                              from.
//
// Optional env vars, one per product
//   SENDGRID_LIST_ID_<PRODUCT>   <PRODUCT> is the product's id from
//                                 data/products.json, upper-cased (e.g.
//                                 SENDGRID_LIST_ID_BLUEMOAT). When set, a
//                                 signup for that product is also added to
//                                 that SendGrid list, so the product can be
//                                 emailed as its own audience on launch day.
//                                 When UNSET for an otherwise-valid,
//                                 allow-listed product, the signup still
//                                 succeeds and is still tagged via the
//                                 custom field — only list membership is
//                                 skipped (logged server-side, not fatal).
//                                 This lets the allow-list (derived from
//                                 products.json, which changes often) stay
//                                 ahead of manual per-product SendGrid list
//                                 provisioning without ever breaking a
//                                 signup.
//
// ---------------------------------------------------------------------
// SendGrid one-time setup a human must perform in the SendGrid UI.
// NOTHING in this codebase creates any of this — no API calls against the
// live account are made by this lane.
//
//   1. Marketing > Contacts > Custom Fields > Add Custom Field
//        name: notify_product      type: Text
//      SendGrid assigns an opaque generated id (e.g. "e1_T") once created.
//      Copy THAT id (not the name "notify_product") into
//      SENDGRID_NOTIFY_FIELD_ID.
//   2. Marketing > Contacts > Lists > Add List — once per product you want
//      a dedicated launch-day send list for. Recommended: at minimum every
//      id in data/products.json that has a "page" (i.e. an actual product
//      page exists to link "Notify me" from). Name each list however is
//      readable to a human (e.g. "blueMoat — launch notify"); copy its
//      generated list id into SENDGRID_LIST_ID_<PRODUCT>.
//   3. Create/locate a SendGrid API key scoped to Marketing > Contacts
//      (write access is enough; this endpoint never reads contacts back)
//      and set it as SENDGRID_API_KEY in Vercel's environment variables.
//   4. Do NOT create a sender identity, template, Single/Double-Opt-In
//      list setting, or automation for this field/list pair. This
//      endpoint never triggers a send — see the HARD LIMITS note above.
//      (SendGrid's own "Double Opt-In" list setting, if ever turned on
//      later for one of these lists, WOULD cause SendGrid to email the
//      contact on our behalf — leave every list's opt-in setting off
//      until that is explicitly designed and cleared.)
//
// ---------------------------------------------------------------------
// Abuse resistance in this file — what it stops and what it does not:
//   - Honeypot (_honey, matching the convention already used by the lead
//     form in contact.html): a filled honeypot is rejected before
//     SendGrid is ever called, but the HTTP response is IDENTICAL to a
//     real success, so a bot cannot use the response to learn it was
//     caught. Stops naive bots that fill every field; does nothing
//     against a targeted bot that already knows to skip hidden fields.
//   - Server-side email/product validation: the client's own JS
//     validation is never trusted; the exact same checks run here
//     regardless of what (if anything) validated on the client.
//   - Body size cap (MAX_BODY_BYTES via Content-Length): stops a naive
//     oversized-body request. Content-Length can be omitted or spoofed by
//     a determined client (e.g. chunked transfer encoding carries none),
//     so this is a shallow check — Vercel's platform-level function body
//     size limit is the real backstop underneath it.
//   - Per-IP rate limiting (lib/notify.mjs createRateLimiter): in-memory,
//     per warm function instance only. Stops a burst from one IP hitting
//     one warm instance. Does NOT stop a distributed attacker rotating
//     IPs, or the same attacker landing on a different (cold) instance —
//     see that function's own header for the full statement. A durable
//     limiter needs a shared store (Vercel KV/Upstash); not built here.
//   - Neutral responses: success looks identical whether the address was
//     new or already subscribed (this falls out naturally, too — see
//     lib/notify.mjs's createSendGridContactStore doc comment: SendGrid's
//     own upsert endpoint is itself async and never tells the caller
//     which case it was).

import {
  createRateLimiter,
  createSendGridContactStore,
  getClientIp,
  loadProductAllowlist,
  validateSubmission,
  MAX_BODY_BYTES,
} from '../lib/notify.mjs';

const defaultLimiter = createRateLimiter({ windowMs: 60_000, max: 5 });

function listIdEnvVar(productId) {
  return `SENDGRID_LIST_ID_${productId.toUpperCase()}`;
}

function wantsJson(req) {
  const accept = (req.headers && req.headers.accept) || '';
  const contentType = (req.headers && req.headers['content-type']) || '';
  return accept.includes('application/json') || contentType.includes('application/json');
}

function fallbackRedirectTarget(req) {
  const referer = req.headers && req.headers.referer;
  if (referer) {
    try {
      const u = new URL(referer);
      return `${u.origin}${u.pathname}`;
    } catch {
      // fall through to default below
    }
  }
  return '/';
}

function respondSuccess(req, res) {
  if (wantsJson(req)) {
    return res.status(200).json({ ok: true });
  }
  const target = fallbackRedirectTarget(req);
  const sep = target.includes('?') ? '&' : '?';
  res.writeHead(303, { Location: `${target}${sep}notified=1` });
  return res.end();
}

function respondFailure(req, res, status, message) {
  if (wantsJson(req)) {
    return res.status(status).json({ ok: false, error: message });
  }
  const target = fallbackRedirectTarget(req);
  const sep = target.includes('?') ? '&' : '?';
  res.writeHead(303, { Location: `${target}${sep}notify_error=1` });
  return res.end();
}

function submissionErrorMessage(reason) {
  switch (reason) {
    case 'missing_email':
    case 'invalid_email':
      return 'Please enter a valid email address.';
    case 'missing_product':
    case 'invalid_product':
      return 'Unknown product.';
    default:
      return 'Invalid submission.';
  }
}

/**
 * The real, wired-to-production handler. Vercel calls this directly.
 */
export default async function handler(req, res) {
  return handleRequest(req, res, {});
}

/**
 * Exported separately so tests can inject a fake SendGrid store (and a
 * fresh rate limiter, to avoid cross-test interference) without touching
 * the real SendGrid API, a real API key, or the module-level limiter.
 * `storeFactory({ apiKey })` must return an object with an
 * `upsertContact(...)` method matching lib/notify.mjs's
 * createSendGridContactStore shape.
 */
export async function handleRequest(req, res, { storeFactory, limiter } = {}) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ ok: false, error: 'Method not allowed' });
  }

  const contentLength = Number((req.headers && req.headers['content-length']) || 0);
  if (Number.isFinite(contentLength) && contentLength > MAX_BODY_BYTES) {
    return res.status(413).json({ ok: false, error: 'Request too large' });
  }

  const activeLimiter = limiter || defaultLimiter;
  const ip = getClientIp(req);
  if (!activeLimiter.consume(ip)) {
    return respondFailure(req, res, 429, 'Too many requests. Try again shortly.');
  }

  const apiKey = process.env.SENDGRID_API_KEY;
  const fieldId = process.env.SENDGRID_NOTIFY_FIELD_ID;
  if (!apiKey || !fieldId) {
    console.error('SENDGRID_API_KEY or SENDGRID_NOTIFY_FIELD_ID not set; refusing signup.');
    return respondFailure(req, res, 500, 'Server not configured');
  }

  let body;
  try {
    body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
  } catch {
    return respondFailure(req, res, 400, 'Invalid request body');
  }
  body = body || {};

  const allowlist = loadProductAllowlist();
  const result = validateSubmission(
    { email: body.email, product: body.product, _honey: body._honey },
    allowlist,
  );

  if (!result.ok) {
    if (result.reason === 'honeypot') {
      // Never reveal that the honeypot was tripped: respond with the exact
      // same success a real signup gets, but skip SendGrid entirely.
      return respondSuccess(req, res);
    }
    return respondFailure(req, res, 400, submissionErrorMessage(result.reason));
  }

  const buildStore = storeFactory || (({ apiKey: key }) => createSendGridContactStore({ apiKey: key }));
  const contactStore = buildStore({ apiKey });
  const listId = process.env[listIdEnvVar(result.product)] || undefined;

  try {
    await contactStore.upsertContact({
      email: result.email,
      productId: result.product,
      fieldId,
      listId,
    });
  } catch (err) {
    console.error('SendGrid contact upsert failed:', err instanceof Error ? err.message : err);
    return respondFailure(req, res, 502, 'Could not save signup — please try again.');
  }

  // Neutral success: identical response whether this address was already
  // on the list or brand new — this endpoint can never be used to test
  // whether an address is subscribed.
  return respondSuccess(req, res);
}
