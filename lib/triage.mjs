// Shared AI-triage classifier. Extracted from api/triage.js unchanged
// (same prompt, same routing rules, same error types) so api/notify.js can
// call it in-process — no extra HTTP hop — and reuse it purely as a LABEL
// generator. See api/notify.js: triage's verdict here never decides
// whether a message gets emailed; api/triage.js keeps its own existing
// external contract (POST /api/triage) untouched, now as a thin wrapper
// around this function.

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
 * advisory-only (api/notify.js) should catch both and proceed without a
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
      model: 'claude-sonnet-4-20250514',
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
