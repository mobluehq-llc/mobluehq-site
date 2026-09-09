// Shared renderer for hours-based pricing copy, driven by data/pricing.json.
//
// Used by BOTH build_pricing.mjs (writes generated markup into the tracked
// HTML files) and check_pricing_sync.mjs (regenerates it fresh and diffs
// against what's currently committed) — one function used by both is what
// makes the drift check meaningful. Same pattern as portfolio_render.mjs /
// build_portfolio.mjs / check_portfolio_sync.mjs for the /portfolio page.
//
// Owner ruling A-104, 2026-09-09 (verbatim): "use hours pricing." The unit
// on every customer-facing surface is search-hours, never a vague
// "allowance." See data/pricing.json's "unitNote" for the local-vs-cloud
// wording constraint: the meter has no venue dimension, so copy must never
// imply a customer saves hours by running locally.

function esc(s) {
  if (s == null) return "";
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function fmtPrice(tier) {
  const dollars = Number.isInteger(tier.priceUsd) ? String(tier.priceUsd) : tier.priceUsd.toFixed(2);
  return `$${dollars}`;
}

function fmtHours(tier) {
  return `${tier.hours.toFixed(1)} search-hours`;
}

function tierById(data, id) {
  const t = data.tiers.find((x) => x.id === id);
  if (!t) throw new Error(`pricing_render: no tier with id "${id}" in data/pricing.json`);
  return t;
}

// Renders the two-tier summary used on the blueMonster product page's
// "Pro" mode card (the PRO / PRO MAX line). Kept as one string so the two
// call sites (build + check) can never disagree on formatting. This is the
// text content ONLY — it goes inside the existing <div class="price">...
// between the PRICING:START/END markers; the surrounding markup and the
// fixed venue-neutrality sentence below it are hand-authored, not generated.
function renderBluemonsterPriceLine(data) {
  const starter = tierById(data, "starter");
  const pro = tierById(data, "pro");
  return `${esc(starter.displayName.toUpperCase())} — ${esc(fmtPrice(starter))}/MO · ${esc(fmtHours(starter).toUpperCase())}<br>${esc(pro.displayName.toUpperCase())} — ${esc(fmtPrice(pro))}/MO · ${esc(fmtHours(pro).toUpperCase())}`;
}

// Renders the consumer-tier cards for pricing.html — a fourth "product
// line" alongside the existing B2B Pilot/Team/Enterprise tiers, clearly
// labeled so a visitor sees one coherent story instead of two unrelated
// pricing pages.
function renderConsumerPricingCards(data) {
  const order = ["entry", "starter", "pro", "topup"];
  return order
    .map((id) => {
      const t = tierById(data, id);
      const period = t.period === "one-time" ? "one-time" : `/${t.period}`;
      return `      <article class="pricing-card" role="listitem">
        <h2 class="pricing-tier">${esc(t.displayName)}</h2>
        <p class="pricing-price">${esc(fmtPrice(t))} ${esc(period)} — ${esc(fmtHours(t))}</p>
        <p class="pricing-desc">${esc(fmtHours(t))} of Pro search${t.id === "topup" ? " added to your account" : " per month"}. A search-hour is wall-clock time inside a Pro search, the same whether that step ran on your Mac or in the cloud — running locally never reduces the hours a search costs.</p>
      </article>`;
    })
    .join("\n");
}

export { esc, fmtPrice, fmtHours, tierById, renderBluemonsterPriceLine, renderConsumerPricingCards };
