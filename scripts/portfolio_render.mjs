// Shared renderer for the /portfolio page's product cards.
//
// Used by BOTH build_portfolio.mjs (writes the generated markup into
// portfolio.html) and check_portfolio_sync.mjs (regenerates it fresh and
// diffs against what's currently committed). Keeping one function used by
// both is what makes the drift check meaningful: if this file's output
// changes for any reason, both the build and the check move together.
//
// Band order is fixed: available -> releasing_soon -> in_development ->
// infrastructure. (Any legacy/unmapped status -- e.g. the blueHealthcare
// records this lane does not own -- is never rendered here.)
//
// Note on "infrastructure": Job 2's instructions list the visible bands as
// Available now / Releasing soon / In development / Areas of interest, with
// no infrastructure band named -- but Job 1 defines "infrastructure" as one
// of exactly four status values "matching the portfolio's status bands."
// Those two instructions conflict. Resolved here in favor of keeping Blue
// and slumberNet visible (as they are today, just data-driven instead of
// hardcoded) rather than silently dropping real content off the page.

function esc(s) {
  if (s == null) return "";
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function logoOrMonogram(p) {
  if (p.logo) {
    return `<img src="${esc(p.logo)}" alt="" />`;
  }
  const letter = esc((p.name || "?").replace(/^blue/i, "").charAt(0).toUpperCase() || "?");
  return `<span class="card-mono" aria-hidden="true">${letter}</span>`;
}

function renderAvailableCard(p) {
  const href = p.page ? esc(p.page) : "#";
  const versionBit = p.version
    ? `<div class="badges"><span class="badge ship">${esc(p.version)}</span></div>`
    : "";
  const notThis = p.not_this
    ? `<p class="not-this"><em>Not this:</em> ${esc(p.not_this)}</p>`
    : "";
  return `<a class="card" href="${href}">
        <div class="card-ico">${logoOrMonogram(p)}</div>
        <div>
          <h3>${esc(p.name)}</h3>
          <p>${esc(p.one_liner)}</p>
          ${notThis}
          ${versionBit}
        </div>
      </a>`;
}

function renderReleasingSoonCard(p) {
  const notThis = p.not_this
    ? `<p class="not-this"><em>Not this:</em> ${esc(p.not_this)}</p>`
    : "";
  // Title links to the product's own page when one exists, so the page is
  // reachable from portfolio.html without a second, nested <a> (the "Notify
  // me" link below is a sibling anchor, not a wrapper, to keep the markup
  // valid). The page itself carries the honest "releasing soon" framing --
  // linking to it is not a stronger claim than the badge already makes.
  const title = p.page
    ? `<a href="${esc(p.page)}">${esc(p.name)}</a>`
    : esc(p.name);
  return `<div class="card card--soon">
        <div class="card-ico">${logoOrMonogram(p)}</div>
        <div>
          <h3>${title}</h3>
          <p>${esc(p.one_liner)}</p>
          ${notThis}
          <div class="badges">
            <span class="badge pat">Releasing soon</span>
            <a class="badge notify-link" href="/waitlist?product=${esc(encodeURIComponent(p.name))}">Notify me</a>
          </div>
        </div>
      </div>`;
}

function renderInDevelopmentCard(p) {
  // Job 2 requirement: name + one-liner ONLY. No claims, no CTA, no date,
  // no version, no badges -- but the title itself may link to the product's
  // own page when one exists, so an in-development page that has actually
  // been written is reachable from portfolio.html rather than orphaned.
  const title = p.page
    ? `<a href="${esc(p.page)}">${esc(p.name)}</a>`
    : esc(p.name);
  return `<div class="card card--dev">
        <div class="card-ico">${logoOrMonogram(p)}</div>
        <div>
          <h3>${title}</h3>
          <p>${esc(p.one_liner)}</p>
        </div>
      </div>`;
}

function renderInfrastructureCard(p) {
  const notThis = p.not_this
    ? `<p class="not-this"><em>Not this:</em> ${esc(p.not_this)}</p>`
    : "";
  return `<a class="card" href="${p.page ? esc(p.page) : "#"}">
        <div class="card-ico">${logoOrMonogram(p)}</div>
        <div>
          <h3>${esc(p.name)}</h3>
          <p>${esc(p.one_liner)}</p>
          ${notThis}
          <div class="badges"><span class="badge ship">Infrastructure</span>${p.patent_pending ? '<span class="badge pat">Patent pending</span>' : ""}</div>
        </div>
      </a>`;
}

const RENDERABLE_STATUSES = new Set([
  "available",
  "releasing_soon",
  "in_development",
  "infrastructure",
]);

export function renderBands(data) {
  const products = (data && data.products) || [];
  const byStatus = { available: [], releasing_soon: [], in_development: [], infrastructure: [] };
  for (const p of products) {
    if (RENDERABLE_STATUSES.has(p.status)) {
      byStatus[p.status].push(p);
    }
  }

  const parts = [];

  if (byStatus.available.length) {
    parts.push(`<h2 class="sec-heading">Available now</h2>`);
    parts.push(`<div class="card-grid">`);
    parts.push(byStatus.available.map(renderAvailableCard).join("\n      "));
    parts.push(`</div>`);
  }

  if (byStatus.releasing_soon.length) {
    parts.push(`<h2 class="sec-heading">Releasing soon</h2>`);
    parts.push(`<div class="card-grid">`);
    parts.push(byStatus.releasing_soon.map(renderReleasingSoonCard).join("\n      "));
    parts.push(`</div>`);
  }

  if (byStatus.in_development.length) {
    parts.push(`<h2 class="sec-heading">In development</h2>`);
    parts.push(`<div class="card-grid">`);
    parts.push(byStatus.in_development.map(renderInDevelopmentCard).join("\n      "));
    parts.push(`</div>`);
  }

  if (byStatus.infrastructure.length) {
    parts.push(`<h2 class="sec-heading">Infrastructure</h2>`);
    parts.push(`<div class="card-grid">`);
    parts.push(byStatus.infrastructure.map(renderInfrastructureCard).join("\n      "));
    parts.push(`</div>`);
  }

  return parts.join("\n    ");
}
