// SEE ALSO api/triage.js — this file is a DELIBERATE DUPLICATE of that
// file's prompt/rules (not a shared import from it), kept in sync by hand.
// If you edit the prompt or routing rules in either file, edit both or they
// will drift; api/triage.js is left fully untouched by this task on
// purpose (zero risk to a live external contract nothing here needed to
// change), so there was no lower-risk way to reuse it in-process than to
// copy it.
//
// Shared AI-triage classifier. Same prompt, same routing rules, same error
// types as api/triage.js, reused here purely as a LABEL generator for
// api/contact.js — no extra HTTP hop. See api/contact.js: triage's verdict
// here never decides whether a message gets emailed. api/triage.js keeps
// its own existing external contract (POST /api/triage) completely
// unmodified; nothing currently calls that endpoint.
//
// ROOT CAUSE (2026-09-12), first real production email ending in "Triage:
// not available for this message (classifier error or unconfigured) — sent
// anyway.": this file and api/triage.js both read process.env.ANTHROPIC_API_KEY
// — the names DO match, so a variable-name mismatch between the two files is
// NOT the bug. What was confirmed wrong is the model pin: both files called
// 'claude-sonnet-4-20250514', a dated snapshot that predates the current
// model line (claude-opus-5 / claude-sonnet-5 / claude-haiku-4-5-20251001) —
// the same class of dead-pin defect found in blueMoat's arbiter today
// (claude-opus-4-1 -> 404). A dead model returns an error response, which
// classifySubmission() below turns into a TriageUpstreamError, which
// api/contact.js's advisory try/catch swallows into triage=null — exactly
// the observed "classifier error" text. Fixed here and in api/triage.js to
// claude-haiku-4-5-20251001 (triage is cheap classification; smallest
// current model is correct). This does NOT rule out the OTHER half of that
// same log line, "...or unconfigured": if ANTHROPIC_API_KEY is genuinely
// unset in Vercel Production, api/contact.js skips classify() entirely by
// design (see its own header comment) and triage is null for that reason
// instead. This file has no way to detect from code alone whether the key
// is set in production — confirm in the Vercel dashboard that
// ANTHROPIC_API_KEY (exact name, matching api/triage.js) exists for the
// Production environment.

export class TriageInputError extends Error {
  constructor(message, details) {
    super(message);
    this.name = 'TriageInputError';
    this.details = details;
  }
}

export class TriageUpstreamError extends Error {
  constructor(message, details) {
    super(message);
    this.name = 'TriageUpstreamError';
    this.details = details;
  }
}

const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';

function buildPrompt({ name, email, organization, message }) {
  return `You are the inbound triage filter for MOBLUEHQ, a stealth-mode AI intelligence holding company. An external party submitted a message via the website's investor inbox. Evaluate the submission and return ONLY a JSON object (no markdown, no preamble).

Submission:
- Name: ${name || '(not provided)'}
- Email: ${email || '(not provided)'}
- Organization: ${organization || '(not provided)'}
- Message: ${message}

Return JSON with exactly these fields:
{
  "substantiveness": <integer 1-10>,
  "sender_type": <one of: "investor", "acquirer", "partner", "press", "researcher", "spam", "curious", "unclear">,
  "confidence": <integer 1-10>,
  "route": <one of: "forward", "log", "review">,
  "reasoning": <one short sentence>
}

Routing rules:
- "forward" if substantive AND likely a real investor/acquirer/partner/press
- "review" if substantive but sender_type is unclear or confidence is below 7
- "log" if low substantiveness, spam, or merely curious

Return only the JSON object.`;
}

/**
 * Classifies one submission. `httpClient` defaults to global fetch; tests
 * inject a fake. Throws TriageInputError for a submission that fails the
 * same pre-checks api/triage.js has always applied (message too
 * short/long), and TriageUpstreamError for anything that goes wrong talking
 * to Anthropic or parsing its output. Callers that treat triage as
 * advisory-only (api/contact.js) should catch both and proceed without a
 * label rather than let either become a delivery failure.
 */
export async function classifySubmission(
  { name = '', email = '', organization = '', message = '' } = {},
  { apiKey, httpClient = fetch } = {}
) {
  if (!message || message.trim().length < 20) {
    throw new TriageInputError('Message too short', {
      substantiveness: 1,
      sender_type: 'unclear',
      confidence: 10,
      route: 'log',
      reasoning: 'Message did not meet minimum length for triage.',
    });
  }
  if (message.length > 10000) {
    throw new TriageInputError('Message too long');
  }
  if (!apiKey) {
    throw new TriageUpstreamError('ANTHROPIC_API_KEY not set');
  }

  const response = await httpClient(ANTHROPIC_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      // Kept in sync with api/triage.js by hand — see the ROOT CAUSE note
      // in this file's header comment above.
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 1000,
      messages: [{ role: 'user', content: buildPrompt({ name, email, organization, message }) }],
    }),
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new TriageUpstreamError('Triage upstream error', { status: response.status, body: errText });
  }

  const data = await response.json();
  const text = (data.content || [])
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('')
    .replace(/```json|```/g, '')
    .trim();

  let evaluation;
  try {
    evaluation = JSON.parse(text);
  } catch (err) {
    throw new TriageUpstreamError('Triage parse error', { text });
  }

  return evaluation;
}
