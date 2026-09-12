/**
 * notify-capture.js — reusable progressive-enhancement snippet for the
 * per-product launch-notification endpoint (POST /api/notify; see
 * api/notify.js and lib/notify.mjs).
 *
 * NOT WIRED INTO ANY PAGE BY THIS LANE. Include it with a plain
 *   <script src="/assets/notify-capture.js" defer></script>
 * on any page that has one of the two markup shapes below. See the note at
 * the bottom of this file for exactly where it would plug into the
 * existing site.
 *
 * ---------------------------------------------------------------------
 * Shape 1 — a REAL no-JS-capable <form>, already usable with zero
 * JavaScript, that this script upgrades in place:
 *
 *   <form data-notify-capture action="/api/notify" method="POST" novalidate>
 *     <input type="hidden" name="product" value="bluemoat">
 *     <input type="text" name="_honey" class="notify-capture-hp"
 *            tabindex="-1" autocomplete="off" aria-hidden="true">
 *     <input type="email" name="email" required placeholder="you@example.com">
 *     <button type="submit">Notify me</button>
 *     <p class="notify-capture-consent">
 *       We'll use this address only to email you once when this ships.
 *       No account, no spam. <a href="/privacy#install-ping">Privacy Policy</a>.
 *     </p>
 *   </form>
 *
 *   With NO JavaScript at all, this form still works: it POSTs natively
 *   (application/x-www-form-urlencoded) to /api/notify, which recognises
 *   that content type, validates and stores the signup exactly the same
 *   way, and 303-redirects back to the referring page with ?notified=1 (or
 *   ?notify_error=1) — see api/notify.js. When this script DOES run, it
 *   intercepts submit and performs the same request via fetch instead, so
 *   the page never navigates and the visitor sees an inline status line.
 *
 * ---------------------------------------------------------------------
 * Shape 2 — wrapping an EXISTING affordance that is not a form at all,
 * e.g. today's mailto: "Request access" links or the /waitlist "Notify me"
 * badge already on portfolio.html:
 *
 *   <span data-notify-product="bluemoat" data-notify-label="Notify me">
 *     <a href="mailto:blue@mobluehq.com?subject=blueMoat%20access">Request access</a>
 *   </span>
 *
 *   Here there is no server-renderable form to begin with, so the no-JS
 *   fallback IS the original link: if this script never runs (JS
 *   disabled/blocked, or an error before it reaches this element), the
 *   mailto:/waitlist link is untouched and fully functional exactly as it
 *   is on the site today. When this script DOES run, it builds an inline
 *   form (same fields as Shape 1) and hides the original link.
 *
 * ---------------------------------------------------------------------
 * The honeypot field name (_honey) matches the convention already used by
 * the lead form in contact.html — this file does not invent a second
 * honeypot convention. Shape 2's synthesized form re-uses the exact same
 * hidden-input styling technique (off-screen absolute position + tabindex
 * -1 + autocomplete off + aria-hidden), matching both contact.html's and
 * waitlist.html's existing honeypot fields.
 *
 * This file talks ONLY to /api/notify on the current origin. It sends no
 * email itself and stores nothing client-side.
 */
(function () {
  'use strict';

  var ENDPOINT = '/api/notify';
  var STYLE_ID = 'notify-capture-styles';

  function injectStyles() {
    if (document.getElementById(STYLE_ID)) return;
    var style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent =
      '.notify-capture-form{display:flex;flex-direction:column;gap:10px;max-width:420px;font-family:inherit;}' +
      '.notify-capture-row{display:flex;gap:8px;flex-wrap:wrap;align-items:stretch;}' +
      '.notify-capture-input{flex:1 1 200px;background:#11203A;border:1px solid #2A3B58;' +
      "color:var(--text-primary,#e8eef7);font-family:'JetBrains Mono',monospace;font-size:13px;" +
      'padding:10px 14px;border-radius:10px;}' +
      '.notify-capture-input::placeholder{color:var(--text-muted,#7d8ba3);}' +
      '.notify-capture-input:focus{outline:none;border-color:rgba(77,159,255,.45);' +
      'box-shadow:0 0 0 3px rgba(77,159,255,.08);}' +
      '.notify-capture-btn{background:var(--accent,#4d9fff);color:#04101f;border:none;' +
      'border-radius:10px;padding:10px 16px;font-size:13px;font-weight:600;cursor:pointer;}' +
      '.notify-capture-btn:disabled{opacity:.6;cursor:default;}' +
      '.notify-capture-consent{font-size:11px;line-height:1.5;color:var(--text-muted,#7d8ba3);margin:0;}' +
      '.notify-capture-note{font-size:12px;margin:0;min-height:1em;}' +
      '.notify-capture-note--ok{color:#5fd88f;}' +
      '.notify-capture-note--warn{color:#ff8a8a;}' +
      '.notify-capture-hp{position:absolute;left:-9999px;width:1px;height:1px;overflow:hidden;}';
    document.head.appendChild(style);
  }

  function makeHoneypot() {
    var honey = document.createElement('input');
    honey.type = 'text';
    honey.name = '_honey';
    honey.className = 'notify-capture-hp';
    honey.tabIndex = -1;
    honey.autocomplete = 'off';
    honey.setAttribute('aria-hidden', 'true');
    return honey;
  }

  function makeNote() {
    var note = document.createElement('div');
    note.className = 'notify-capture-note';
    note.setAttribute('role', 'status');
    note.setAttribute('aria-live', 'polite');
    return note;
  }

  function setNote(note, text, kind) {
    note.textContent = text;
    note.className = 'notify-capture-note' + (kind ? ' notify-capture-note--' + kind : '');
  }

  /**
   * Wires inline-fetch submission onto ANY <form> (whether authored
   * server-side, per Shape 1, or synthesized below for Shape 2), given the
   * fields it must already contain: name="email", name="product",
   * name="_honey". Shared by both shapes so there is exactly one
   * submit-handling code path.
   */
  function wireForm(form, note) {
    var submitBtn = form.querySelector('button[type="submit"], input[type="submit"]');
    form.addEventListener('submit', function (e) {
      e.preventDefault();
      var honeyEl = form.elements._honey;
      if (honeyEl && honeyEl.value) return; // bot path: do nothing visible

      var emailEl = form.elements.email;
      var productEl = form.elements.product;
      var email = (emailEl && emailEl.value ? emailEl.value : '').trim();
      var product = productEl ? productEl.value : '';

      if (!email || email.indexOf('@') === -1) {
        setNote(note, 'Please enter a valid email address.', 'warn');
        return;
      }
      if (submitBtn) submitBtn.disabled = true;
      setNote(note, 'Sending…', null);

      fetch(ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ email: email, product: product, _honey: honeyEl ? honeyEl.value : '' }),
      })
        .then(function (r) {
          return r
            .json()
            .catch(function () {
              return {};
            })
            .then(function (data) {
              return { ok: r.ok && data.ok !== false, data: data };
            });
        })
        .then(function (result) {
          if (submitBtn) submitBtn.disabled = false;
          if (result.ok) {
            if (emailEl) emailEl.value = '';
            setNote(note, "You're on the list — we'll email you once when it ships.", 'ok');
          } else {
            setNote(note, (result.data && result.data.error) || 'Could not save — please try again.', 'warn');
          }
        })
        .catch(function () {
          if (submitBtn) submitBtn.disabled = false;
          setNote(note, 'Could not save — please try again.', 'warn');
        });
    });
  }

  // --- Shape 1: enhance an already-real, already-working <form> --------
  function enhanceRealForm(form) {
    if (form.dataset.notifyCaptureWired) return;
    form.dataset.notifyCaptureWired = '1';
    injectStyles();
    var note = form.querySelector('.notify-capture-note') || makeNote();
    if (!note.parentNode) form.appendChild(note);
    wireForm(form, note);
  }

  // --- Shape 2: build a form around an existing link/button ------------
  function enhanceWrapper(host) {
    var product = host.getAttribute('data-notify-product');
    if (!product) return;
    var label = host.getAttribute('data-notify-label');
    var original = host.querySelector('a, button');

    var form = document.createElement('form');
    form.className = 'notify-capture-form';
    form.setAttribute('novalidate', 'novalidate');

    var productField = document.createElement('input');
    productField.type = 'hidden';
    productField.name = 'product';
    productField.value = product;

    var honey = makeHoneypot();

    var row = document.createElement('div');
    row.className = 'notify-capture-row';

    var email = document.createElement('input');
    email.type = 'email';
    email.name = 'email';
    email.required = true;
    email.autocomplete = 'email';
    email.placeholder = 'you@example.com';
    email.className = 'notify-capture-input';
    email.setAttribute('aria-label', 'Email address');

    var button = document.createElement('button');
    button.type = 'submit';
    button.className = 'notify-capture-btn';
    button.textContent = label || (original ? original.textContent.trim() : 'Notify me');

    row.appendChild(email);
    row.appendChild(button);

    var consent = document.createElement('p');
    consent.className = 'notify-capture-consent';
    consent.innerHTML =
      'We will use this address only to email you once when this ships. ' +
      'No account, no spam. <a href="/privacy#install-ping">Privacy Policy</a>.';

    var note = makeNote();

    form.appendChild(productField);
    form.appendChild(honey);
    form.appendChild(row);
    form.appendChild(consent);
    form.appendChild(note);

    injectStyles();
    wireForm(form, note);

    if (original) original.style.display = 'none';
    host.appendChild(form);
  }

  function init() {
    var realForms = document.querySelectorAll('form[data-notify-capture]');
    for (var i = 0; i < realForms.length; i++) enhanceRealForm(realForms[i]);

    var wrappers = document.querySelectorAll('[data-notify-product]');
    for (var j = 0; j < wrappers.length; j++) {
      if (wrappers[j].tagName !== 'FORM') enhanceWrapper(wrappers[j]);
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();

/**
 * WHERE THIS WOULD BE WIRED (not done in this lane — portfolio.html and
 * other site pages are being actively reworked by another session):
 *
 *   - portfolio.html already has two "Notify me" badges
 *     (<a class="badge notify-link" href="/waitlist?product=blueMonster">
 *     and the blueGlu equivalent) that today link out to waitlist.html,
 *     which itself posts to a third-party form-relay (formsubmit.co) — see
 *     the note in this lane's final report about that inconsistency. The
 *     six other in-development products (bluealibi, bluefloor, blueintent,
 *     blueparity, bluepipeline) and bluemoat currently offer only a
 *     mailto: "Request access"/"start a matter" link on their own product
 *     pages — no capture at all. Wrapping each of those mailto: links in
 *     a <span data-notify-product="..."> (Shape 2 above) would be the
 *     minimal-risk way to add real capture there without touching page
 *     structure beyond one wrapping element per link.
 *   - waitlist.html is the more natural home for Shape 1: replace its
 *     existing form's formsubmit.co fetch call with a real
 *     <form data-notify-capture action="/api/notify" method="POST"> and
 *     drop the custom inline JS it currently has, since this script now
 *     covers the same job (including the true no-JS path waitlist.html's
 *     current formsubmit.co-only design does not have).
 */
