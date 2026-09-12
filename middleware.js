// Vercel Routing Middleware — gates the blueMonster demo release page and
// its DMG download behind a signed, HttpOnly cookie.
//
// Runs on the Edge runtime (the file-convention default), so it must not
// import node:crypto — see lib/demo-gate.mjs, which uses only Web Crypto.
//
// This is what makes the gate non-bypassable: it runs on every request that
// matches the config.matcher below, BEFORE Vercel's CDN cache and before any
// static file (including the .dmg, when DMG_SOURCE=vercel) is served. A
// direct hit on the protected page or the DMG path with no valid cookie is
// redirected to /demo — there is no code path that serves the content
// without a signature check.
//
// Kill switch: set DEMO_GATE_ENABLED=false to make this a pure pass-through
// once the demo is ready to go fully public. That single env change (plus a
// redeploy) is the entire "open the gate" operation — no code change needed.

import { next } from '@vercel/functions';
import {
  COOKIE_NAME,
  isGateEnabled,
  parseCookieHeader,
  verifySignedCookieValue,
} from './lib/demo-gate.mjs';
// vvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvv
// ADDITIVE — blueHealthcare gate import. Independent module, independent
// cookie name and env vars (see lib/healthcare-gate.mjs). Nothing below this
// line changes what the blueMonster import above does.
import {
  COOKIE_NAME as HEALTHCARE_COOKIE_NAME,
  isGateEnabled as isHealthcareGateEnabled,
  verifySignedCookieValue as verifyHealthcareSignedCookieValue,
} from './lib/healthcare-gate.mjs';
// ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
// vvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvv
// ADDITIVE — non-healthcare PRODUCT PAGE gate import (A-127, 2026-09-12).
// Independent module, independent cookie name (pg_demo_gate) and its own
// enable/disable toggle (see lib/product-gate.mjs). Reads
// HEALTHCARE_GATE_PASSWORD for the password value ONLY (deliberate, owner
// instruction — see that file's header); never writes or reads
// bh_demo_gate, bm_demo_gate, DEMO_PASSWORD, or DEMO_GATE_SECRET.
import {
  COOKIE_NAME as PRODUCT_COOKIE_NAME,
  isGateEnabled as isProductGateEnabled,
  isGatedProductPath,
  resolveSecret as resolveProductGateSecret,
  verifySignedCookieValue as verifyProductSignedCookieValue,
} from './lib/product-gate.mjs';
// ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^

export const config = {
  matcher: [
    '/portfolio/bluemonster',
    '/portfolio/bluemonster/:path*',
    // vvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvv
    // ADDITIVE — the only change to the blueMonster matcher entries above is
    // that they now share this array with more entries. Neither existing
    // string changed.
    '/healthcare',
    '/healthcare/:path*',
    // ADDITIVE (A-127) — the other seven non-healthcare product pages.
    // '/portfolio/bluemonster' above already covers blueMonster's page; it
    // is now ALSO matched by the product-gate branch below (see the
    // isGatedProductPath check, which runs before the original blueMonster
    // gate code and returns early for exactly these eight paths — the DMG
    // wildcard '/portfolio/bluemonster/:path*' above is untouched by that
    // branch and keeps falling through to the original code, unchanged).
    '/portfolio/blueglu',
    '/portfolio/bluemoat',
    '/portfolio/bluealibi',
    '/portfolio/bluefloor',
    '/portfolio/blueintent',
    '/portfolio/blueparity',
    '/portfolio/bluepipeline',
    // ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
  ],
};

export default async function middleware(request) {
  const pathname = new URL(request.url).pathname;

  // vvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvv
  // ADDITIVE — blueHealthcare gate branch. Runs ONLY for paths under
  // /healthcare; every other request (including every
  // blueMonster request) falls through untouched to the unmodified code
  // below. This branch reads/writes only the bh_demo_gate cookie and the
  // HEALTHCARE_GATE_* env vars — it never touches DEMO_GATE_SECRET,
  // DEMO_PASSWORD, or the bm_demo_gate cookie.
  if (pathname === '/healthcare' || pathname.startsWith('/healthcare/')) {
    if (!isHealthcareGateEnabled()) {
      return next();
    }

    const hcSecret = process.env.HEALTHCARE_GATE_SECRET;
    if (!hcSecret) {
      // Fail CLOSED: a missing secret must never mean "let everyone through".
      console.error('HEALTHCARE_GATE_SECRET is not set; blocking healthcare access.');
      return new Response('blueHealthcare gate misconfigured.', { status: 503 });
    }

    const hcCookies = parseCookieHeader(request.headers.get('cookie'));
    const hcOk = await verifyHealthcareSignedCookieValue(hcSecret, hcCookies[HEALTHCARE_COOKIE_NAME]);

    if (!hcOk) {
      const url = new URL('/healthcare-gate', request.url);
      url.searchParams.set('next', pathname);
      return Response.redirect(url, 302);
    }

    return next();
  }
  // ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^

  // vvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvv
  // ADDITIVE — non-healthcare PRODUCT PAGE gate branch (A-127, 2026-09-12).
  // Runs ONLY for the exact clean-URL pathname of one of the eight
  // non-healthcare product pages (isGatedProductPath — an exact Set lookup,
  // never a prefix match). This deliberately includes
  // '/portfolio/bluemonster' itself: the owner authorized publishing that
  // page too, gated exactly like the other seven (A-127 amends the earlier
  // "never publish to the blueMonster product page" hard stop for the
  // gated page only — see CLAUDE.md). It deliberately does NOT match
  // '/portfolio/bluemonster/:path*' (the DMG subpath) — a request for the
  // actual installer still falls through, unmatched here, to the original
  // blueMonster demo-gate code below, unchanged. This branch reads/writes
  // only the pg_demo_gate cookie — it never touches DEMO_GATE_SECRET,
  // DEMO_PASSWORD, bm_demo_gate, HEALTHCARE_GATE_SECRET's cookie
  // (bh_demo_gate), or the healthcare gate's own redirect target.
  if (isGatedProductPath(pathname)) {
    if (!isProductGateEnabled()) {
      return next();
    }

    const pgSecret = resolveProductGateSecret();
    if (!pgSecret) {
      // Fail CLOSED: a missing secret must never mean "let everyone through".
      console.error('PRODUCT_GATE_SECRET/HEALTHCARE_GATE_SECRET is not set; blocking product-page access.');
      return new Response('Product gate misconfigured.', { status: 503 });
    }

    const pgCookies = parseCookieHeader(request.headers.get('cookie'));
    const pgOk = await verifyProductSignedCookieValue(pgSecret, pgCookies[PRODUCT_COOKIE_NAME]);

    if (!pgOk) {
      const url = new URL('/product-gate', request.url);
      url.searchParams.set('next', pathname);
      return Response.redirect(url, 302);
    }

    return next();
  }
  // ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^

  // --- Everything below is the original blueMonster gate, byte-for-byte ---
  if (!isGateEnabled()) {
    return next();
  }

  const secret = process.env.DEMO_GATE_SECRET;
  if (!secret) {
    // Fail CLOSED: a missing secret must never mean "let everyone through".
    console.error('DEMO_GATE_SECRET is not set; blocking demo access.');
    return new Response('Demo gate misconfigured.', { status: 503 });
  }

  const cookies = parseCookieHeader(request.headers.get('cookie'));
  const ok = await verifySignedCookieValue(secret, cookies[COOKIE_NAME]);

  if (!ok) {
    const url = new URL('/demo', request.url);
    url.searchParams.set('next', new URL(request.url).pathname);
    return Response.redirect(url, 302);
  }

  return next();
}
