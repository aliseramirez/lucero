// api/signals.js — Vercel serverless function
// Proxies signal fetch to Anthropic API, keeping the API key server-side.
// Deploy to Vercel: the ANTHROPIC_API_KEY env var is set in the Vercel dashboard.

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // Vercel sometimes needs manual body parsing
  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch { body = {}; }
  }
  if (!body) body = {};

  const { companyName, industry, website } = body;

  if (!companyName) {
    return res.status(400).json({ error: 'companyName is required' });
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: 'ANTHROPIC_API_KEY not configured' });
  }

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'anthropic-beta': 'web-search-2025-03-05'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-5',
        max_tokens: 500,
        tools: [{ type: 'web_search_20250305', name: 'web_search' }],
        system: `Return ONLY a JSON array of 2-3 recent news signals about the company. No preamble, no markdown. Each object: {"title":"","description":"","type":"fundraising|hiring|product|partnership|press|growth","source":"","sourceUrl":"","date":"","sentiment":"positive|neutral|negative"}. If nothing found, return [].`,
        messages: [{
          role: 'user',
          content: `Recent news (last 6 months) about ${companyName} (${industry || 'startup'}). JSON array only.`
        }]
      })
    });

    if (!response.ok) {
      const err = await response.text();
      console.error('Anthropic API error:', err);
      return res.status(502).json({ error: err, signals: [] });
    }

    const data = await response.json();

    // Extract the final text block (after any tool-use blocks)
    const textBlock = data.content?.find(b => b.type === 'text');
    if (!textBlock) {
      return res.status(200).json({ signals: [] });
    }

    const raw = textBlock.text.trim().replace(/```json|```/g, '').trim();

    let signals = [];
    try {
      signals = JSON.parse(raw);
      if (!Array.isArray(signals)) signals = [];
    } catch {
      console.error('Failed to parse signals JSON:', raw);
      signals = [];
    }

    return res.status(200).json({ signals });

  } catch (err) {
    console.error('Handler error:', err);
    return res.status(500).json({ error: err.message, stack: err.stack, signals: [] });
  }
}
