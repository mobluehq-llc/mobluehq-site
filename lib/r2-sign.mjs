// Minimal SigV4 presigned-GET URL generator for Cloudflare R2 (S3-compatible),
// with zero extra dependencies (no @aws-sdk/*). Node-only (uses node:crypto);
// only imported from api/download.js, which runs on the Node.js Function
// runtime, never from middleware.js (Edge).
//
// R2 always uses region "auto" and endpoint
// `https://<accountId>.r2.cloudflarestorage.com`.

import { createHash, createHmac } from 'node:crypto';

const REGION = 'auto';
const SERVICE = 's3';

function sha256Hex(input) {
  return createHash('sha256').update(input).digest('hex');
}

function hmac(key, data) {
  return createHmac('sha256', key).update(data).digest();
}

function amzDateParts(now = new Date()) {
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, ''); // YYYYMMDDTHHMMSSZ
  return { amzDate, dateStamp: amzDate.slice(0, 8) };
}

// RFC 3986 encoder — encodeURIComponent leaves a few chars (!'()*) unescaped
// that SigV4 requires escaped.
function rfc3986Encode(str) {
  return encodeURIComponent(str).replace(
    /[!'()*]/g,
    (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase(),
  );
}

function encodePathSegment(segment) {
  return rfc3986Encode(segment);
}

/**
 * Returns a presigned HTTPS GET URL for a single R2 object, valid for
 * `expiresInSeconds` (default 5 minutes).
 */
export async function presignR2GetUrl({
  accountId,
  accessKeyId,
  secretAccessKey,
  bucket,
  objectKey,
  expiresInSeconds = 300,
}) {
  if (!accountId || !accessKeyId || !secretAccessKey || !bucket || !objectKey) {
    throw new Error(
      'Missing R2 configuration: need R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET, R2_OBJECT_KEY',
    );
  }

  const host = `${accountId}.r2.cloudflarestorage.com`;
  const { amzDate, dateStamp } = amzDateParts();
  const credentialScope = `${dateStamp}/${REGION}/${SERVICE}/aws4_request`;
  const canonicalUri =
    '/' + [bucket, ...objectKey.split('/')].map(encodePathSegment).join('/');

  const queryParams = {
    'X-Amz-Algorithm': 'AWS4-HMAC-SHA256',
    'X-Amz-Credential': `${accessKeyId}/${credentialScope}`,
    'X-Amz-Date': amzDate,
    'X-Amz-Expires': String(expiresInSeconds),
    'X-Amz-SignedHeaders': 'host',
  };
  const canonicalQueryString = Object.keys(queryParams)
    .sort()
    .map((k) => `${rfc3986Encode(k)}=${rfc3986Encode(queryParams[k])}`)
    .join('&');

  const canonicalHeaders = `host:${host}\n`;
  const signedHeaders = 'host';
  const payloadHash = 'UNSIGNED-PAYLOAD';

  const canonicalRequest = [
    'GET',
    canonicalUri,
    canonicalQueryString,
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join('\n');

  const stringToSign = [
    'AWS4-HMAC-SHA256',
    amzDate,
    credentialScope,
    sha256Hex(canonicalRequest),
  ].join('\n');

  const kDate = hmac(`AWS4${secretAccessKey}`, dateStamp);
  const kRegion = hmac(kDate, REGION);
  const kService = hmac(kRegion, SERVICE);
  const kSigning = hmac(kService, 'aws4_request');
  const signature = hmac(kSigning, stringToSign).toString('hex');

  return `https://${host}${canonicalUri}?${canonicalQueryString}&X-Amz-Signature=${signature}`;
}
