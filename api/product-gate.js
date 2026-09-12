// Vercel serverless function (Node.js runtime): checks the non-healthcare
// product-page password. NEW FILE — mirrors api/healthcare-gate.js's shape
// exactly but is fully independent of it and of api/demo-gate.js: own
// cookie (lib/product-gate.mjs), own redirect target, own enable/disable
// toggle. Does not read or write DEMO_PASSWORD, DEMO_GATE_SECRET, or the
// bm_demo_gate cookie, and does not write the bh_demo_gate cookie.
//
// POST /api/product-gate   { password: string }
// Returns 200 { ok: true, redirect } and sets the signed, HttpOnly cookie on
// success; 401 { ok: false, error } on a wrong password. The password itself
// is NEVER sent to the client — it is only compared here, server-side.
//
// Password source (deliberate, owner instruction 2026-09-12): the SAME
// HEALTHCARE_GATE_PASSWORD value blueHealthcare's own gate reads — see
// lib/product-gate.mjs's header for why, and the consequence (rotating the
// healthcare password also rotates access to every page this gate covers).
// Required env vars: HEALTHCARE_GATE_PASSWORD, and a signing secret — see
// resolveSecret() (PRODUCT_GATE_SECRET, falling back to
// HEALTHCARE_GATE_SECRET so nothing new must be configured before publish).
// Optional env var: PRODUCT_GATE_ENABLED (default "true"; "false" disables
//   the whole gate — this endpoint then just confirms success without
//   checking anything, matching middleware.js's pass-through behavior).

import {
  buildSetCookieHeader,
  createSignedCookieValue,
  isGateEnabled,
  isGatedProductPath,
  resolveSecret,
  timingSafeStringEqual,
} from '../lib/product-gate.mjs';

const PRODUCT_GATE_TARGET = '/portfolio';

// Unlike blueHealthcare (one section, one landing page), this gate covers
// eight distinct product pages — send the visitor back to the specific one
// they were trying to reach, not always to /portfolio. Only ever honor a
// same-site path this gate actually protects (or the portfolio index
// itself); anything else falls back to PRODUCT_GATE_TARGET.
function resolveRedirect(candidate) {
  if (typeof candidate === 'string' && (candidate === PRODUCT_GATE_TARGET || isGatedProductPath(candidate))) {
    return candidate;
  }
  return PRODUCT_GATE_TARGET;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ ok: false, error: 'Method not allowed' });
  }

  if (!isGateEnabled()) {
    // Gate is switched off: nothing to protect, nothing to check.
    return res.status(200).json({ ok: true, redirect: PRODUCT_GATE_TARGET });
  }

  const secret = resolveSecret();
  const expected = process.env.HEALTHCARE_GATE_PASSWORD;
  if (!secret || !expected) {
    console.error('PRODUCT_GATE_SECRET/HEALTHCARE_GATE_SECRET or HEALTHCARE_GATE_PASSWORD not set');
    return res.status(500).json({ ok: false, error: 'Server not configured' });
  }

  let body;
  try {
    body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
  } catch {
    return res.status(400).json({ ok: false, error: 'Invalid request body' });
  }

  const submitted = body && typeof body.password === 'string' ? body.password : '';
  const redirect = resolveRedirect(body && body.next);

  if (!submitted || !timingSafeStringEqual(submitted, expected)) {
    return res.status(401).json({ ok: false, error: 'Incorrect password.' });
  }

  const cookieValue = await createSignedCookieValue(secret);
  res.setHeader('Set-Cookie', buildSetCookieHeader(cookieValue));
  return res.status(200).json({ ok: true, redirect });
}
