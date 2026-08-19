// Vercel serverless function (Node.js runtime): checks the demo password.
//
// POST /api/demo-gate   { password: string }
// Returns 200 { ok: true, redirect } and sets the signed, HttpOnly cookie on
// success; 401 { ok: false, error } on a wrong password. The password itself
// is NEVER sent to the client — it is only compared here, server-side,
// against process.env.DEMO_PASSWORD.
//
// Required env vars: DEMO_PASSWORD, DEMO_GATE_SECRET
// Optional env var: DEMO_GATE_ENABLED (default "true"; "false" disables the
//   whole gate — this endpoint then just confirms success without checking
//   anything, matching middleware.js's pass-through behavior).

import {
  buildSetCookieHeader,
  createSignedCookieValue,
  isGateEnabled,
  timingSafeStringEqual,
} from '../lib/demo-gate.mjs';

const DEMO_TARGET = '/portfolio/bluemonster';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ ok: false, error: 'Method not allowed' });
  }

  if (!isGateEnabled()) {
    // Gate is switched off: nothing to protect, nothing to check.
    return res.status(200).json({ ok: true, redirect: DEMO_TARGET });
  }

  const secret = process.env.DEMO_GATE_SECRET;
  const expected = process.env.DEMO_PASSWORD;
  if (!secret || !expected) {
    console.error('DEMO_GATE_SECRET or DEMO_PASSWORD not set');
    return res.status(500).json({ ok: false, error: 'Server not configured' });
  }

  let body;
  try {
    body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
  } catch {
    return res.status(400).json({ ok: false, error: 'Invalid request body' });
  }

  const submitted = body && typeof body.password === 'string' ? body.password : '';

  if (!submitted || !timingSafeStringEqual(submitted, expected)) {
    return res.status(401).json({ ok: false, error: 'Incorrect password.' });
  }

  const cookieValue = await createSignedCookieValue(secret);
  res.setHeader('Set-Cookie', buildSetCookieHeader(cookieValue));
  return res.status(200).json({ ok: true, redirect: DEMO_TARGET });
}
