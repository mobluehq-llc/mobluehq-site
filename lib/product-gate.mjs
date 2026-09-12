// Shared helpers for the non-healthcare PRODUCT PAGE password gate
// (blueMonster, blueGlu, blueMoat, blueAlibi, blueFloor, blueIntent,
// blueParity, bluePipeline, and any other portfolio/<product>.html page).
//
// NEW FILE — sibling to lib/healthcare-gate.mjs and lib/demo-gate.mjs, not an
// edit to either. Same reason lib/healthcare-gate.mjs gives for not editing
// lib/demo-gate.mjs: each gate gets its OWN copy of these small pure
// functions so changing one gate can never change another. This gate has:
//   - its OWN cookie name (pg_demo_gate) — distinct from bm_demo_gate and
//     bh_demo_gate, and never read or written by either of those gates,
//   - its OWN enable/disable toggle (PRODUCT_GATE_ENABLED) — independent of
//     DEMO_GATE_ENABLED and HEALTHCARE_GATE_ENABLED, so the owner can open
//     or close this gate without touching the other two,
//   - its OWN redirect target (see api/product-gate.js: /portfolio, the
//     public product index — not /demo, not /healthcare).
//
// DELIBERATE EXCEPTION, per the owner's explicit instruction (2026-09-12):
// the PASSWORD VALUE is read from process.env.HEALTHCARE_GATE_PASSWORD —
// the exact same env var blueHealthcare's own gate reads — rather than a new
// PRODUCT_GATE_PASSWORD. Nothing about the password is copied, printed, or
// stored anywhere new; it is compared server-side against the one value
// already configured for blueHealthcare. CONSEQUENCE: changing
// HEALTHCARE_GATE_PASSWORD in Vercel changes access to every product page
// gated by this file too. If that coupling ever becomes unwanted, add a
// PRODUCT_GATE_PASSWORD env var and read that instead — this file has no
// other opinion about where the password comes from.
//
// The signing SECRET has the same "nothing new to configure before publish"
// property, but via a fallback rather than a hard requirement: this gate
// reads PRODUCT_GATE_SECRET if it is set, and falls back to
// HEALTHCARE_GATE_SECRET (already configured and live for blueHealthcare)
// if it is not. A signing secret is not a password — reusing it as a
// fallback leaks nothing about blueHealthcare's password — and requiring a
// brand-new secret to be set in Vercel before this gate could work at all
// would block the publish the owner already authorized. Set
// PRODUCT_GATE_SECRET explicitly whenever this gate's cookies should be
// rotatable independently of blueHealthcare's.
//
// Uses ONLY the Web Crypto API (globalThis.crypto.subtle) so the exact same
// code runs unmodified on the Vercel Edge Middleware runtime (middleware.js)
// and the Vercel Node.js Function runtime (api/product-gate.js).
//
// The signed cookie is a simple, dependency-free token:
//   "<expiryEpochSeconds>.<hmacSha256Hex(secret, expiryEpochSeconds)>"
// It carries its own expiry, so verification needs only the shared secret —
// no server-side session store.

export const COOKIE_NAME = 'pg_demo_gate';
export const COOKIE_MAX_AGE_SECONDS = 30 * 24 * 60 * 60; // 30 days

async function hmacHex(secret, message) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    enc.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sigBuf = await crypto.subtle.sign('HMAC', key, enc.encode(message));
  return [...new Uint8Array(sigBuf)]
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

// Constant-time string comparison (equal-length inputs are the normal case
// here since both sides are hex digests of the same hash).
function constantTimeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const len = Math.max(a.length, b.length, 1);
  let diff = a.length === b.length ? 0 : 1;
  for (let i = 0; i < len; i++) {
    const ca = i < a.length ? a.charCodeAt(i) : 0;
    const cb = i < b.length ? b.charCodeAt(i) : 0;
    diff |= ca ^ cb;
  }
  return diff === 0;
}

/** The signing secret this gate uses: its own if set, else blueHealthcare's. */
export function resolveSecret() {
  return process.env.PRODUCT_GATE_SECRET || process.env.HEALTHCARE_GATE_SECRET;
}

/** Build a new signed cookie value good for COOKIE_MAX_AGE_SECONDS. */
export async function createSignedCookieValue(secret) {
  const expires = Math.floor(Date.now() / 1000) + COOKIE_MAX_AGE_SECONDS;
  const sig = await hmacHex(secret, String(expires));
  return `${expires}.${sig}`;
}

/**
 * Verify a signed cookie value. Returns true only if the HMAC signature
 * matches (recomputed server-side from `secret`) AND the token has not
 * expired. Never trusts the cookie's presence alone.
 */
export async function verifySignedCookieValue(secret, value) {
  if (!secret || !value || typeof value !== 'string') return false;
  const dot = value.indexOf('.');
  if (dot < 1) return false;
  const expiresStr = value.slice(0, dot);
  const sig = value.slice(dot + 1);
  if (!/^\d+$/.test(expiresStr) || !sig) return false;
  const expires = Number(expiresStr);
  if (!Number.isFinite(expires) || expires < Math.floor(Date.now() / 1000)) {
    return false;
  }
  const expectedSig = await hmacHex(secret, expiresStr);
  return constantTimeEqual(sig, expectedSig);
}

/** Build a `Set-Cookie` header value for a successful gate check. */
export function buildSetCookieHeader(value) {
  return `${COOKIE_NAME}=${encodeURIComponent(value)}; Path=/; Max-Age=${COOKIE_MAX_AGE_SECONDS}; HttpOnly; Secure; SameSite=Lax`;
}

/** Whether the gate is active. Defaults to true (fail-safe) unless explicitly "false". */
export function isGateEnabled() {
  return process.env.PRODUCT_GATE_ENABLED !== 'false';
}

/** Constant-time-ish equality for comparing the submitted password. */
export function timingSafeStringEqual(a, b) {
  return constantTimeEqual(a, b);
}

// The exact non-healthcare product pages this gate covers, as the clean
// (cleanUrls: true) pathnames Vercel routes portfolio/<slug>.html to. This
// is the single source of truth middleware.js consults — add a new product
// page here AND to vercel.json's headers list AND to middleware.js's
// `matcher`, all three, or a new page silently ships ungated.
export const GATED_PRODUCT_PATHS = new Set([
  '/portfolio/bluemonster',
  '/portfolio/blueglu',
  '/portfolio/bluemoat',
  '/portfolio/bluealibi',
  '/portfolio/bluefloor',
  '/portfolio/blueintent',
  '/portfolio/blueparity',
  '/portfolio/bluepipeline',
]);

/** True for exactly the pages this gate protects — never a prefix match. */
export function isGatedProductPath(pathname) {
  return GATED_PRODUCT_PATHS.has(pathname);
}
