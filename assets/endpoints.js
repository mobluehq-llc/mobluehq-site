/** Site → contact-route endpoint config (single place to update on deploy).
 * Consolidated 2026-09-12: every website submission (contact, investors,
 * waitlist) now posts to this site's own /api/notify — same-origin, no
 * third party, no separate Cloudflare Worker. See api/notify.js. */
window.MOBLUEHQ_ENDPOINTS = {
  LEAD_INGEST_URL: "/api/notify",
};
