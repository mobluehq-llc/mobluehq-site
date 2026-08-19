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

export const config = {
  matcher: ['/portfolio/bluemonster', '/portfolio/bluemonster/:path*'],
};

export default async function middleware(request) {
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
