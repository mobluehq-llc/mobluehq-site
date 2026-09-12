// Pure logic for the consolidated website-contact route (api/contact.js).
//
// PURPOSE (owner instruction, 2026-09-12): every message submitted through
// the website — investor inquiries, launch-waitlist signups, and the
// general contact form — should reach blue@mobluehq.com, through ONE route,
// configured with ONE key. This file has no network calls and no
// environment reads, so it can be unit-tested without a live SendGrid key
// or a live Anthropic key: api/contact.js does the I/O, this file decides
// what the I/O should contain.
//
// DELIBERATE PROPERTY: nothing in this file can cause a submission to be
// dropped based on how "good" it looks. Triage's classification (built
// elsewhere, in lib/triage.mjs) is accepted here purely as a label to put
// IN the email — it never appears in a branch that decides whether to
// build a mail payload. See buildMailPayload(): the triage argument only
// ever touches the subject line and a header.

export const HONEYPOT_FIELD = '_honey';
export const CONTACT_TO_ADDRESS = 'blue@mobluehq.com';
export const CONTACT_FROM_ADDRESS = 'blue@mobluehq.com';
export const CONTACT_FROM_NAME = 'MOBLUEHQ Website';

export const MAX_SHORT_FIELD_LENGTH = 500; // name / email / organization / product
export const MAX_MESSAGE_LENGTH = 10000; // matches api/triage.js's existing cap
export const MIN_MESSAGE_LENGTH = 10;

const KNOWN_SOURCES = new Set(['contact', 'investors', 'waitlist']);

export class ValidationError extends Error {
  constructor(message, field) {
    super(message);
    this.name = 'ValidationError';
    this.field = field;
  }
}

/** True if the request is a honeypot fill — caller should return a neutral
 * success and send nothing. Any non-empty value trips it; the field is
 * never shown to a real visitor (see contact.html / investors.html /
 * waitlist.html), so a non-empty value only ever comes from an automated
 * filler that populates every input on a page. */
export function isHoneypotTriggered(body) {
  const value = body && body[HONEYPOT_FIELD];
  return typeof value === 'string' && value.trim().length > 0;
}

function trimToLength(value, maxLength) {
  if (typeof value !== 'string') return '';
  return value.trim().slice(0, maxLength);
}

// Deliberately simple and non-backtracking (no nested quantifiers) so it
// cannot become a ReDoS vector on attacker-controlled input: one
// non-whitespace/non-@ run, an "@", one more such run containing a ".".
const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Format-only check — this is an abuse/typo guard, not mail-deliverability
 * verification. Rejects control characters (including CR/LF) outright so a
 * "valid-shaped" email can never smuggle a header injection. */
export function isValidEmail(email) {
  if (typeof email !== 'string') return false;
  const trimmed = email.trim();
  if (!trimmed || trimmed.length > MAX_SHORT_FIELD_LENGTH) return false;
  if (/[\r\n\x00-\x08\x0b\x0c\x0e-\x1f]/.test(trimmed)) return false;
  if (trimmed.includes(',') || trimmed.includes(';')) return false; // multiple addresses
  return EMAIL_SHAPE.test(trimmed);
}

/** Server-side gate for the one field that becomes an email header
 * (reply_to). Never trust a raw form field into a header: reject anything
 * that isn't exactly one well-formed address with no control characters.
 * Returns the trimmed address, or null if it must not be used as reply_to
 * (the caller then simply omits reply_to — it never blocks the send). */
export function sanitizeReplyTo(email) {
  if (!isValidEmail(email)) return null;
  return email.trim();
}

/** Normalizes one of the three forms' payloads into a common shape.
 * Throws ValidationError (never silently drops a required field) so the
 * route can return a clear 400 rather than mis-sending. */
export function buildSubmission(body, source) {
  const src = KNOWN_SOURCES.has(source) ? source : 'contact';
  const raw = body || {};

  const name = trimToLength(raw.name, MAX_SHORT_FIELD_LENGTH);
  const email = trimToLength(raw.email, MAX_SHORT_FIELD_LENGTH);
  const organization = trimToLength(raw.organization, MAX_SHORT_FIELD_LENGTH);
  const product = trimToLength(raw.product, MAX_SHORT_FIELD_LENGTH);
  const segment = trimToLength(raw.segment, MAX_SHORT_FIELD_LENGTH);
  const planInterest = trimToLength(raw.plan_interest, MAX_SHORT_FIELD_LENGTH);
  let message = trimToLength(raw.message, MAX_MESSAGE_LENGTH);

  if (src === 'waitlist' && !message) {
    // The waitlist form collects no free-text message — synthesize a body
    // so the mail is still a complete, readable message, not an empty one.
    message = `Launch waitlist signup${product ? ` for: ${product}` : ''}.`;
  }

  if (src !== 'waitlist' && message.length < MIN_MESSAGE_LENGTH) {
    throw new ValidationError('Message is required.', 'message');
  }

  if (src === 'contact') {
    if (!name) throw new ValidationError('Name is required.', 'name');
    if (!isValidEmail(email)) throw new ValidationError('A valid email is required.', 'email');
  }

  if (src === 'waitlist') {
    if (!isValidEmail(email)) throw new ValidationError('A valid email is required.', 'email');
  }

  // Investors form: message is the only required field (matches the
  // existing UI, which asks nothing else) — name/email stay optional.
  if (email && !isValidEmail(email)) {
    throw new ValidationError('Email is not a valid address.', 'email');
  }

  return { source: src, name, email, organization, product, segment, planInterest, message };
}

function subjectFor(submission, triageLabel) {
  const bySource = {
    contact: 'Contact form',
    investors: 'Investor inquiry',
    waitlist: 'Launch waitlist signup',
  };
  const base = bySource[submission.source] || 'Website submission';
  const suffix = submission.product ? ` — ${submission.product}` : '';
  const tag = triageLabel ? ` [${triageLabel}]` : '';
  return `${base}${suffix} — MOBLUEHQ${tag}`;
}

/** Best-effort one-word-ish label for the subject line / header. Never
 * throws; a missing or failed triage result just yields null, which
 * subjectFor() renders as no tag at all. */
export function triageLabel(triage) {
  if (!triage || typeof triage !== 'object') return null;
  const route = typeof triage.route === 'string' ? triage.route : 'unclassified';
  const senderType = typeof triage.sender_type === 'string' ? triage.sender_type : null;
  return senderType ? `${route}/${senderType}` : route;
}

function plainTextBody(submission, triage) {
  const lines = [
    `Source: ${submission.source}`,
    `Name: ${submission.name || '(not provided)'}`,
    `Email: ${submission.email || '(not provided)'}`,
  ];
  if (submission.organization) lines.push(`Organization: ${submission.organization}`);
  if (submission.product) lines.push(`Product: ${submission.product}`);
  if (submission.segment) lines.push(`Segment: ${submission.segment}`);
  if (submission.planInterest) lines.push(`Plan interest: ${submission.planInterest}`);
  lines.push('', submission.message, '');
  if (triage && typeof triage === 'object') {
    lines.push(
      '---',
      'Triage (advisory only — every message above was sent regardless of this result):',
      `route=${triage.route ?? 'unknown'} sender_type=${triage.sender_type ?? 'unknown'} ` +
        `substantiveness=${triage.substantiveness ?? 'unknown'} confidence=${triage.confidence ?? 'unknown'}`,
      triage.reasoning ? String(triage.reasoning) : ''
    );
  } else if (triage === null) {
    lines.push('---', 'Triage: not available for this message (classifier error or unconfigured) — sent anyway.');
  }
  return lines.join('\n');
}

/**
 * Builds the exact SendGrid v3 /mail/send request body. `triage` is either
 * a classification object, `null` (triage failed/unavailable), or omitted —
 * every case reaches this same code path and produces a payload. There is
 * no branch here that returns nothing based on triage's content: that is
 * the falsifiable property the owner asked for ("triage classifies as
 * low-value is STILL sent").
 */
export function buildMailPayload(submission, triage) {
  const label = triageLabel(triage);
  const payload = {
    personalizations: [{ to: [{ email: CONTACT_TO_ADDRESS }] }],
    from: { email: CONTACT_FROM_ADDRESS, name: CONTACT_FROM_NAME },
    subject: subjectFor(submission, label),
    content: [{ type: 'text/plain', value: plainTextBody(submission, triage) }],
  };
  const replyTo = sanitizeReplyTo(submission.email);
  if (replyTo) {
    payload.reply_to = { email: replyTo };
  }
  return payload;
}
