// api/signals.js — Vercel serverless function
// Proxies signal fetch to Anthropic API, keeping the API key server-side.
// Deploy to Vercel: the ANTHROPIC_API_KEY env var is set in the Vercel dashboard.

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { companyName, industry, website } = req.body;

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
        max_tokens: 1000,
        tools: [{ type: 'web_search_20250305', name: 'web_search' }],
        system: `You are a startup intelligence assistant. Search for recent news about a portfolio company and return ONLY a JSON array of signal objects. No preamble, no markdown, no code fences — just the raw JSON array.

Each signal object must have exactly these fields:
{
  "title": "short headline (max 10 words)",
  "description": "1-2 sentence factual summary of what happened",
  "type": one of: "fundraising" | "hiring" | "product" | "partnership" | "press" | "growth",
  "source": "publication or platform name",
  "sourceUrl": "full URL string if available, else null",
  "date": "ISO 8601 date string — best estimate of when this happened",
  "sentiment": "positive" | "neutral" | "negative"
}

Return 2–4 signals. Only include verifiable, specific, recent events from the last 6 months. If nothing meaningful is found, return [].`,
        messages: [{
          role: 'user',
          content: `Search for recent news (last 6 months) about ${companyName} — a ${industry || 'startup'}${website ? ` at ${website}` : ''}. Focus on: funding rounds, product launches, key hires, partnerships, press coverage, grants. Return the JSON array only.`
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
    return res.status(500).json({ error: err.message, signals: [] });
  }
}
