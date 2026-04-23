// Vercel serverless function: AI investor triage
// POST /api/triage
// Body: { name, email, organization, message }
// Returns: { substantiveness, sender_type, confidence, route, reasoning }
//
// Required env var: ANTHROPIC_API_KEY (set in Vercel dashboard)
// Optional env var: TRIAGE_FORWARD_EMAIL (where to send "forward" results)

export default async function handler(req, res) {
  // CORS for the website itself
  res.setHeader('Access-Control-Allow-Origin', 'https://mobluehq.com');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    console.error('ANTHROPIC_API_KEY not set');
    return res.status(500).json({ error: 'Server not configured' });
  }

  let body;
  try {
    body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
  } catch (err) {
    return res.status(400).json({ error: 'Invalid JSON body' });
  }

  const { name = '', email = '', organization = '', message = '' } = body || {};

  if (!message || message.trim().length < 20) {
    return res.status(400).json({
      error: 'Message too short',
      substantiveness: 1,
      sender_type: 'unclear',
      confidence: 10,
      route: 'log',
      reasoning: 'Message did not meet minimum length for triage.'
    });
  }

  // Basic abuse guards
  if (message.length > 10000) {
    return res.status(413).json({ error: 'Message too long' });
  }

  const prompt = `You are the inbound triage filter for MOBLUEHQ, a stealth-mode AI intelligence holding company. An external party submitted a message via the website's investor inbox. Evaluate the submission and return ONLY a JSON object (no markdown, no preamble).

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

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 1000,
        messages: [{ role: 'user', content: prompt }]
      })
    });

    if (!response.ok) {
      const errText = await response.text();
      console.error('Anthropic API error:', response.status, errText);
      return res.status(502).json({
        error: 'Triage upstream error',
        route: 'review',
        reasoning: 'Triage failed; held for human review.'
      });
    }

    const data = await response.json();
    const text = (data.content || [])
      .filter(b => b.type === 'text')
      .map(b => b.text)
      .join('')
      .replace(/```json|```/g, '')
      .trim();

    let evaluation;
    try {
      evaluation = JSON.parse(text);
    } catch (err) {
      console.error('Failed to parse model output:', text);
      return res.status(500).json({
        error: 'Triage parse error',
        route: 'review',
        reasoning: 'Triage output unparseable; held for human review.'
      });
    }

    // Log every submission (Vercel logs are searchable in the dashboard)
    console.log('TRIAGE', JSON.stringify({
      timestamp: new Date().toISOString(),
      sender: { name, email, organization },
      messageLength: message.length,
      evaluation
    }));

    // TODO: when route === 'forward', also send Adam an email via Resend or similar.
    // Stub for now; Adam reads triage logs in Vercel dashboard until email is wired.

    return res.status(200).json(evaluation);

  } catch (err) {
    console.error('Triage error:', err);
    return res.status(500).json({
      error: 'Triage internal error',
      route: 'review',
      reasoning: 'Internal error; held for human review.'
    });
  }
}
