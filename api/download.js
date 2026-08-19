// Vercel serverless function (Node.js runtime): gated DMG delivery.
//
// GET /api/download
//
// Defense in depth: this endpoint re-checks the signed cookie itself rather
// than relying solely on middleware.js's matcher. Two delivery backends,
// chosen by DMG_SOURCE:
//   - DMG_SOURCE=vercel (default): 302 to the static file at
//     /portfolio/bluemonster/blueMonster.dmg, which is itself covered by
//     middleware.js's matcher (/portfolio/bluemonster/:path*) — so even a
//     direct hit on that static path without the cookie is redirected to
//     /demo, not just this function.
//   - DMG_SOURCE=r2: 302 to a short-lived (5 min) presigned Cloudflare R2 URL.
//
// Required env vars: DEMO_GATE_SECRET (unless DEMO_GATE_ENABLED=false)
// R2 backend also needs: R2_ACCOUNT_ID, R2_ACCESS_KEY_ID,
//   R2_SECRET_ACCESS_KEY, R2_BUCKET, R2_OBJECT_KEY

import {
  COOKIE_NAME,
  isGateEnabled,
  parseCookieHeader,
  verifySignedCookieValue,
} from '../lib/demo-gate.mjs';
import { presignR2GetUrl } from '../lib/r2-sign.mjs';

const VERCEL_STATIC_DMG_PATH = '/portfolio/bluemonster/blueMonster.dmg';

export default async function handler(req, res) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.setHeader('Allow', 'GET, HEAD');
    return res.status(405).send('Method not allowed');
  }

  if (isGateEnabled()) {
    const secret = process.env.DEMO_GATE_SECRET;
    if (!secret) {
      console.error('DEMO_GATE_SECRET is not set; refusing download.');
      res.status(503);
      return res.send('Demo gate misconfigured.');
    }

    const cookies = parseCookieHeader(req.headers.cookie);
    const ok = await verifySignedCookieValue(secret, cookies[COOKIE_NAME]);
    if (!ok) {
      res.writeHead(302, { Location: '/demo' });
      return res.end();
    }
  }

  const source = (process.env.DMG_SOURCE || 'vercel').toLowerCase();

  if (source === 'r2') {
    try {
      const url = await presignR2GetUrl({
        accountId: process.env.R2_ACCOUNT_ID,
        accessKeyId: process.env.R2_ACCESS_KEY_ID,
        secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
        bucket: process.env.R2_BUCKET,
        objectKey: process.env.R2_OBJECT_KEY,
        expiresInSeconds: 300,
      });
      res.writeHead(302, { Location: url });
      return res.end();
    } catch (err) {
      console.error('R2 presign failed:', err);
      res.status(500);
      return res.send('Download temporarily unavailable.');
    }
  }

  res.writeHead(302, { Location: VERCEL_STATIC_DMG_PATH });
  return res.end();
}
