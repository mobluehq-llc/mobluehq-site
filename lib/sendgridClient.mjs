// Thin I/O boundary around SendGrid's Mail Send API. Everything that can be
// unit-tested without a real network call lives in lib/notify.mjs; this file
// is deliberately the only place that touches `fetch` and the key, so tests
// can inject a fake `httpClient` and never send real mail.
//
// KEY: process.env.SENDGRID_MAILSEND_API_KEY — NOT the bare
// SENDGRID_API_KEY (that name is already claimed on branch
// gtm/notify-capture-091226 for a separate, differently-scoped Marketing
// Contacts key; the two must stay distinct restricted keys). This module
// never reads, logs, or persists the key value anywhere other than the one
// Authorization header below.

const SENDGRID_MAIL_SEND_URL = 'https://api.sendgrid.com/v3/mail/send';

export class NotifyConfigError extends Error {
  constructor(message) {
    super(message);
    this.name = 'NotifyConfigError';
  }
}

export class NotifySendError extends Error {
  constructor(message, status, body) {
    super(message);
    this.name = 'NotifySendError';
    this.status = status;
    this.body = body;
  }
}

/**
 * Sends one SendGrid v3 mail payload. Fails loudly and distinctly for the
 * two ways this can go wrong — never returns anything that looks like
 * success on either path:
 *   - no key configured  -> NotifyConfigError (nothing was sent)
 *   - SendGrid non-202   -> NotifySendError (SendGrid rejected/failed it)
 *
 * `httpClient` defaults to the global fetch; tests pass a fake so no
 * outbound HTTP ever happens in the suite.
 */
export async function sendMail(payload, { apiKey, httpClient = fetch } = {}) {
  if (!apiKey || typeof apiKey !== 'string' || !apiKey.trim()) {
    throw new NotifyConfigError(
      'SENDGRID_MAILSEND_API_KEY is not set — refusing to report success for an unsent message.'
    );
  }

  const response = await httpClient(SENDGRID_MAIL_SEND_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });

  if (!response || response.status !== 202) {
    let bodyText = '';
    try {
      bodyText = typeof response?.text === 'function' ? await response.text() : '';
    } catch {
      // best-effort only — the failure itself is what matters
    }
    throw new NotifySendError(
      `SendGrid returned ${response ? response.status : 'no response'}`,
      response ? response.status : null,
      bodyText
    );
  }

  return true;
}
