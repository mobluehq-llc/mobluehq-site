// Vercel cron handler: monthly indexing + portfolio freshness check
// Triggered by vercel.json cron schedule "0 9 1 * *" (1st of month, 9am UTC)
// Also callable manually via GET /api/refresh?key=<INDEXNOW_KEY>
//
// What it does:
// 1. Pings IndexNow (Bing, Yandex) so they re-crawl the homepage
// 2. Pings Google's sitemap endpoint
// 3. Reads products.json and warns if lastReviewed is more than reviewCadenceDays ago
// 4. Logs everything to Vercel logs for the operator to review
//
// Required env var (recommended): INDEXNOW_KEY (any random string, also hosted at /<key>.txt)
// Optional env var: SITE_URL (defaults to https://mobluehq.com)

import fs from 'fs';
import path from 'path';

const SITE_URL = process.env.SITE_URL || 'https://mobluehq.com';
const INDEXNOW_KEY = process.env.INDEXNOW_KEY || 'mobluehq-default-indexnow-key';

const URLS_TO_REINDEX = [
  `${SITE_URL}/`,
  `${SITE_URL}/sitemap.xml`
];

export default async function handler(req, res) {
  // Allow Vercel cron (no auth header check needed when invoked by platform)
  // For manual trigger, require key match
  if (req.method !== 'GET' && req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const isManual = req.query && req.query.key;
  if (isManual && req.query.key !== INDEXNOW_KEY) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const log = {
    timestamp: new Date().toISOString(),
    triggered_by: isManual ? 'manual' : 'cron',
    site: SITE_URL,
    actions: []
  };

  // 1. Portfolio freshness check
  try {
    const productsPath = path.join(process.cwd(), 'data', 'products.json');
    const productsRaw = fs.readFileSync(productsPath, 'utf8');
    const productsData = JSON.parse(productsRaw);

    const lastReviewed = new Date(productsData.lastReviewed);
    const cadenceDays = productsData.reviewCadenceDays || 30;
    const daysSinceReview = Math.floor((Date.now() - lastReviewed.getTime()) / (1000 * 60 * 60 * 24));

    log.portfolio = {
      lastReviewed: productsData.lastReviewed,
      daysSinceReview,
      reviewCadenceDays: cadenceDays,
      productCount: productsData.products.length,
      isStale: daysSinceReview > cadenceDays
    };

    if (log.portfolio.isStale) {
      log.actions.push({
        type: 'portfolio_stale_warning',
        message: `Portfolio not reviewed in ${daysSinceReview} days (cadence: ${cadenceDays}). Edit data/products.json and update lastReviewed.`
      });
    }
  } catch (err) {
    log.portfolio_error = err.message;
  }

  // 2. IndexNow ping (Bing, Yandex)
  try {
    const indexNowResponse = await fetch('https://api.indexnow.org/indexnow', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        host: SITE_URL.replace(/^https?:\/\//, ''),
        key: INDEXNOW_KEY,
        keyLocation: `${SITE_URL}/${INDEXNOW_KEY}.txt`,
        urlList: URLS_TO_REINDEX
      })
    });

    log.actions.push({
      type: 'indexnow_ping',
      status: indexNowResponse.status,
      success: indexNowResponse.ok
    });
  } catch (err) {
    log.actions.push({
      type: 'indexnow_ping_error',
      error: err.message
    });
  }

  // 3. Google sitemap ping (deprecated 2023 but still occasionally honored;
  //    Google primarily relies on Search Console submission + organic crawl)
  try {
    const googleResponse = await fetch(
      `https://www.google.com/ping?sitemap=${encodeURIComponent(SITE_URL + '/sitemap.xml')}`,
      { method: 'GET' }
    );

    log.actions.push({
      type: 'google_sitemap_ping',
      status: googleResponse.status
    });
  } catch (err) {
    log.actions.push({
      type: 'google_sitemap_ping_error',
      error: err.message
    });
  }

  console.log('REFRESH_RUN', JSON.stringify(log));

  return res.status(200).json(log);
}
