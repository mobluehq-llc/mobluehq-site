// Vercel serverless function: the ONE consolidated inbound-contact route.
//
// POST /api/contact
// Body: { source: 'contact'|'investors'|'waitlist', name?, email?,
//         organization?, message?, product?, segment?, plan_interest?,
//         _honey? }
// Always responds 200 { ok: true } on a real send, and NEVER on anything
// else — see the design note in lib/sendgridClient.mjs's sendMail().
//
// OWNER INSTRUCTION (2026-09-12): "i basically want anyone sending anything
// to the company to have the messages go to blue@mobluehq.com right now."
// This route replaces three previously-separate paths:
//   - investors.html          -> was formsubmit.co
//   - waitlist.html           -> was formsubmit.co
//   - contact.html (via assets/endpoints.js LEAD_INGEST_URL)
//                              -> was the mobluehq-bug-triage Worker, whose
//                                 outboundAdapter.ts is an [outbound:email-stub]
//                                 that logs and sends nothing (never reached
//                                 blue@mobluehq.com in production)
//
// DESIGN: pure decision logic lives in lib/contact.mjs (validation,
// honeypot, the exact SendGrid payload shape); the only network calls live
// in lib/sendgridClient.mjs (SendGrid) and lib/triage.mjs (Anthropic,
// reused as a label generator — see below). This file just wires them
// together, which is what createContactHandler()'s injected `classify` /
// `sendMail` let tests replace with fakes.
//
// TRIAGE IS ADVISORY ONLY. It runs best-effort, in a try/catch, purely to
// put a label in the subject line / a header. Its result — including
// "log", low substantiveness, or an outright failure to classify — can
// NEVER prevent a send. That is deliberate: the owner's instruction is that
// every message reaches blue@mobluehq.com, not a filtered subset. If this
// invariant is ever violated, treat it as a regression, not a feature.
//
// KEY: process.env.SENDGRID_MAILSEND_API_KEY. If it is unset, this route
// FAILS LOUDLY (5xx, logged) — it must never tell a visitor "message sent"
// for a message that was not sent. See lib/sendgridClient.mjs.
//
// Optional env var: ANTHROPIC_API_KEY — reused from api/triage.js's own
// config; if unset, triage is simply skipped (no label), sending proceeds.

import { classifySubmission } from '../lib/triage.mjs';
import { sendMail, NotifyConfigError, NotifySendError } from '../lib/sendgridClient.mjs';
import { ValidationError, buildMailPayload, buildSubmission, isHoneypotTriggered } from '../lib/contact.mjs';

function parseBody(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  if (typeof req.body === 'string') return JSON.parse(req.body);
  return {};
}

/**
 * Factory so tests can inject fakes for both external calls without
 * touching global fetch. The default export below wires the real ones.
 */
export function createContactHandler({
  classify = classifySubmission,
  sendMail: sendMailFn = sendMail,
  sendGridApiKey = () => process.env.SENDGRID_MAILSEND_API_KEY,
  anthropicApiKey = () => process.env.ANTHROPIC_API_KEY,
  httpClient,
} = {}) {
  return async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', 'https://mobluehq.com');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
      return res.status(200).end();
    }
    if (req.method !== 'POST') {
      res.setHeader('Allow', 'POST, OPTIONS');
      return res.status(405).json({ ok: false, error: 'Method not allowed' });
    }

    let body;
    try {
      body = parseBody(req);
    } catch {
      return res.status(400).json({ ok: false, error: 'Invalid JSON body' });
    }

    // Honeypot: neutral success, nothing sent, nothing logged as an error —
    // a bot should not learn it was caught.
    if (isHoneypotTriggered(body)) {
      return res.status(200).json({ ok: true });
    }

    let submission;
    try {
      submission = buildSubmission(body, body.source);
    } catch (err) {
      if (err instanceof ValidationError) {
        return res.status(400).json({ ok: false, error: err.message, field: err.field });
      }
      throw err;
    }

    // Best-effort triage label. ANY failure here — missing key, upstream
    // error, unparseable output, message shape triage itself rejects — is
    // swallowed and logged, never surfaced to the visitor and never a
    // reason to skip the send below.
    let triage = null;
    try {
      const apiKey = anthropicApiKey();
      if (apiKey) {
        triage = await classify(
          {
            name: submission.name,
            email: submission.email,
            organization: submission.organization,
            message: submission.message,
          },
          httpClient ? { apiKey, httpClient } : { apiKey }
        );
      }
    } catch (err) {
      console.error('contact: triage classification failed (advisory only, sending regardless)', err);
      triage = null;
    }

    const mailPayload = buildMailPayload(submission, triage);

    try {
      const apiKey = sendGridApiKey();
      await sendMailFn(mailPayload, httpClient ? { apiKey, httpClient } : { apiKey });
    } catch (err) {
      if (err instanceof NotifyConfigError) {
        console.error('contact: SENDGRID_MAILSEND_API_KEY not set — message NOT sent', {
          source: submission.source,
        });
        return res.status(500).json({ ok: false, error: 'Server not configured — message not sent.' });
      }
      if (err instanceof NotifySendError) {
        console.error('contact: SendGrid rejected the send', { status: err.status, body: err.body });
        return res.status(502).json({ ok: false, error: 'Could not send — please try again.' });
      }
      console.error('contact: unexpected error sending mail', err);
      return res.status(500).json({ ok: false, error: 'Could not send — please try again.' });
    }

    return res.status(200).json({ ok: true });
  };
}

export default createContactHandler();
