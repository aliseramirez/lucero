export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { companyName, website, stage, industry } = req.body;

  if (!companyName) {
    return res.status(400).json({ error: 'companyName required' });
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: 'ANTHROPIC_API_KEY not configured' });
  }

  const prompt = `You are an investment research assistant. Search for recent information about the company "${companyName}" (${industry || 'startup'}, ${stage || 'early stage'}${website ? `, website: ${website}` : ''}) and return a JSON object.

Research tasks:
1. Check if their website is active and what it currently says
2. Find any recent news, press coverage, or announcements (last 12 months)
3. Look for funding rounds, investor announcements, or valuation changes
4. Find any revenue figures, growth metrics, or customer wins mentioned publicly
5. Check for leadership changes, product launches, or pivots
6. Look for any negative signals: layoffs, shutdowns, pivots away from core business

Return ONLY valid JSON (no markdown):
{
  "websiteStatus": "active" | "down" | "changed" | "unknown",
  "websiteSummary": "brief description of what site says now",
  "signals": [
    {
      "type": "funding" | "revenue" | "product" | "partnership" | "team" | "news" | "risk",
      "title": "short title",
      "description": "1-2 sentence summary",
      "sentiment": "positive" | "neutral" | "negative",
      "date": "ISO date or approximate like 2024-06",
      "source": "source name",
      "url": "url or null"
    }
  ],
  "summary": "2-3 sentence overall assessment of company trajectory",
  "lastFundingRound": "e.g. Series A $10M - 2024 or null",
  "estimatedRevenue": "e.g. $2M ARR or null",
  "checkInRecommended": true | false,
  "checkInReason": "specific reason or null"
}

If nothing found: return signals: [], summary: "No recent public signals found."`;

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 1000,
        tools: [{ type: 'web_search_20250305', name: 'web_search' }],
        messages: [{ role: 'user', content: prompt }],
      }),
    });

    if (!response.ok) {
      const err = await response.text();
      return res.status(response.status).json({ error: err });
    }

    const data = await response.json();
    const textBlock = data.content.filter(b => b.type === 'text').pop();
    if (!textBlock?.text) {
      return res.status(200).json({ signals: [], summary: 'No data returned.', websiteStatus: 'unknown' });
    }

    const parsed = JSON.parse(textBlock.text.replace(/```json|```/g, '').trim());
    return res.status(200).json(parsed);
  } catch (e) {
    console.error('Signals API error:', e);
    return res.status(500).json({ error: e.message });
  }
}
