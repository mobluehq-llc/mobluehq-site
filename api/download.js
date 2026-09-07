// Vercel serverless function (Node.js runtime): multi-product installer delivery.
//
// GET /api/download                      (defaults to product=bluemonster —
//                                          preserves the existing live link)
// GET /api/download?product=<id>
// GET /api/download/<id>                 (rewritten to the query form by
//                                          vercel.json; see rewrites there)
//
// Product registry (PRODUCTS below) is the single source of truth for which
// product IDs exist, whether each is gated behind the demo password, and
// where its artifact lives. An id not present in PRODUCTS is a 404 — this
// function never falls through to blueMonster's DMG for an unrecognised or
// misspelled product name.
//
// Defense in depth: for a gated product this endpoint re-checks the signed
// cookie itself rather than relying solely on middleware.js's matcher. Two
// delivery backends per product, chosen by that product's DMG_SOURCE env var
// (see envName() below):
//   - "vercel" (default): 302 to a static file under /portfolio/<id>/...,
//     which for a gated product is itself covered by middleware.js's
//     matcher — so even a direct hit on the static path without the cookie
//     is redirected to /demo, not just this function.
//   - "r2": 302 to a short-lived (5 min) presigned Cloudflare R2 URL.
//
// Env vars:
//   blueMonster (the default/legacy product) keeps its EXACT original bare
//   names so its current live behaviour is unchanged:
//     DEMO_GATE_SECRET (unless DEMO_GATE_ENABLED=false), DMG_SOURCE,
//     R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET,
//     R2_OBJECT_KEY
//   Every other product gets its own suffixed vars, e.g. for "blueglu":
//     DMG_SOURCE_BLUEGLU, R2_BUCKET_BLUEGLU, R2_OBJECT_KEY_BLUEGLU
//   R2 account-level credentials (R2_ACCOUNT_ID, R2_ACCESS_KEY_ID,
//   R2_SECRET_ACCESS_KEY) are shared across products by default — one
//   Cloudflare account, many buckets/keys — but can be overridden per
//   product with the same _<PRODUCT> suffix if a product ever needs its own
//   credentials.
//
// blueGlu is free at 0.1 and ships ungated — no demo password applies to it.

import {
  COOKIE_NAME,
  isGateEnabled,
  parseCookieHeader,
  verifySignedCookieValue,
} from '../lib/demo-gate.mjs';
import { presignR2GetUrl } from '../lib/r2-sign.mjs';

const DEFAULT_PRODUCT = 'bluemonster';

// Single source of truth for what this route knows how to serve.
// gated: true  -> demo password cookie is required (see middleware.js's
//                 matcher, which must cover the same static path).
// gated: false -> no password check; still fails closed for unknown ids.
const PRODUCTS = {
  bluemonster: {
    gated: true,
    staticPath: '/portfolio/bluemonster/blueMonster.dmg',
  },
  blueglu: {
    gated: false,
    staticPath: '/portfolio/blueglu/blueGlu.dmg',
  },
};

// bluemonster keeps bare, unsuffixed env var names (its current, live
// behaviour); every other product reads a name suffixed with its uppercased
// id. R2 account credentials additionally fall back to the shared bare name
// when no per-product override is set.
function envName(product, baseName) {
  return product === DEFAULT_PRODUCT ? baseName : `${baseName}_${product.toUpperCase()}`;
}

const SHARED_R2_CREDENTIAL_NAMES = new Set([
  'R2_ACCOUNT_ID',
  'R2_ACCESS_KEY_ID',
  'R2_SECRET_ACCESS_KEY',
]);

function readEnv(product, baseName) {
  const suffixed = process.env[envName(product, baseName)];
  if (suffixed !== undefined && suffixed !== '') return suffixed;
  if (product !== DEFAULT_PRODUCT && SHARED_R2_CREDENTIAL_NAMES.has(baseName)) {
    return process.env[baseName];
  }
  return undefined;
}

function resolveProductId(req) {
  // Prefer Vercel's parsed query (available in production); fall back to
  // parsing req.url directly so this also works under a plain Node harness.
  let fromQuery = req.query && req.query.product;
  if (Array.isArray(fromQuery)) fromQuery = fromQuery[0];
  if (!fromQuery && req.url) {
    try {
      const parsed = new URL(req.url, 'http://localhost');
      fromQuery = parsed.searchParams.get('product') || undefined;
    } catch {
      // ignore malformed req.url; fromQuery stays undefined
    }
  }
  const id = (fromQuery || DEFAULT_PRODUCT).trim().toLowerCase();
  return id;
}

export default async function handler(req, res) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.setHeader('Allow', 'GET, HEAD');
    return res.status(405).send('Method not allowed');
  }

  const productId = resolveProductId(req);
  const product = PRODUCTS[productId];

  // Fail CLOSED: an unrecognised product name is a 404, never a fallback to
  // blueMonster's (or any other product's) artifact.
  if (!product) {
    res.status(404);
    return res.send('Unknown product.');
  }

  if (product.gated) {
    if (!isGateEnabled()) {
      // Gate globally disabled — pure pass-through, matches middleware.js.
    } else {
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
  }

  const source = (readEnv(productId, 'DMG_SOURCE') || 'vercel').toLowerCase();

  if (source === 'r2') {
    const accountId = readEnv(productId, 'R2_ACCOUNT_ID');
    const accessKeyId = readEnv(productId, 'R2_ACCESS_KEY_ID');
    const secretAccessKey = readEnv(productId, 'R2_SECRET_ACCESS_KEY');
    const bucket = readEnv(productId, 'R2_BUCKET');
    const objectKey = readEnv(productId, 'R2_OBJECT_KEY');

    try {
      const url = await presignR2GetUrl({
        accountId,
        accessKeyId,
        secretAccessKey,
        bucket,
        objectKey,
        expiresInSeconds: 300,
      });
      res.writeHead(302, { Location: url });
      return res.end();
    } catch (err) {
      console.error(`R2 presign failed for product "${productId}":`, err);
      res.status(500);
      return res.send('Download temporarily unavailable.');
    }
  }

  res.writeHead(302, { Location: product.staticPath });
  return res.end();
}
