// Shared helpers for the blueMonster demo password gate.
//
// Uses ONLY the Web Crypto API (globalThis.crypto.subtle) so the exact same
// code runs unmodified on both:
//   - the Vercel Routing Middleware Edge runtime (middleware.js), which has
//     no access to Node's `node:crypto`, and
//   - the Vercel Node.js Function runtime (api/demo-gate.js, api/download.js),
//     which also exposes Web Crypto globally.
//
// The signed cookie is a simple, dependency-free token:
//   "<expiryEpochSeconds>.<hmacSha256Hex(secret, expiryEpochSeconds)>"
// It carries its own expiry, so verification needs only the shared secret —
// no server-side session store.

export const COOKIE_NAME = 'bm_demo_gate';
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

/** Parse a raw `Cookie` request header into a plain object. */
export function parseCookieHeader(cookieHeader) {
  const out = {};
  if (!cookieHeader) return out;
  for (const part of cookieHeader.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    const k = part.slice(0, eq).trim();
    const v = part.slice(eq + 1).trim();
    if (k) {
      try {
        out[k] = decodeURIComponent(v);
      } catch {
        out[k] = v;
      }
    }
  }
  return out;
}

/** Build a `Set-Cookie` header value for a successful gate check. */
export function buildSetCookieHeader(value) {
  return `${COOKIE_NAME}=${encodeURIComponent(value)}; Path=/; Max-Age=${COOKIE_MAX_AGE_SECONDS}; HttpOnly; Secure; SameSite=Lax`;
}

/** Whether the gate is active. Defaults to true (fail-safe) unless explicitly "false". */
export function isGateEnabled() {
  return process.env.DEMO_GATE_ENABLED !== 'false';
}

/** Constant-time-ish equality for comparing the submitted password. */
export function timingSafeStringEqual(a, b) {
  return constantTimeEqual(a, b);
}
