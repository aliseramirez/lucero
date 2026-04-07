export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { companyName, website, stage, industry } = req.body;
  if (!companyName) return res.status(400).json({ error: 'companyName required' });

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'ANTHROPIC_API_KEY not configured' });

  const prompt = `You are an investment research assistant analyzing "${companyName}" (${industry || 'startup'}, ${stage || 'early stage'}${website ? `, website: ${website}` : ''}) for an angel investor.

Search the web thoroughly and return ONLY valid JSON with this exact structure:

{
  "activity": {
    "status": "active" | "quiet" | "dark",
    "websiteStatus": "active" | "changed" | "down" | "unknown",
    "websiteSummary": "1 sentence what site currently shows or null",
    "lastPublicSignal": "e.g. 'Blog post 2 months ago' or null",
    "lastSignalDate": "YYYY-MM or null",
    "linkedInActive": true | false | null,
    "signals": [
      { "title": "short title", "description": "1-2 sentences", "date": "YYYY-MM", "source": "name", "sourceUrl": "url or null" }
    ]
  },

  "momentum": {
    "trend": "up" | "flat" | "down" | "unknown",
    "fundingRounds": [
      {
        "roundName": "e.g. Series A",
        "date": "YYYY-MM",
        "amountRaised": 10000000,
        "leadInvestor": "name or null",
        "followOns": ["investor1"],
        "postMoneyVal": 50000000,
        "source": "name",
        "sourceUrl": "url or null"
      }
    ],
    "revenueData": [
      {
        "metric": "ARR" | "MRR" | "Revenue" | "GMV" | "Customers" | "Users",
        "value": "$2M",
        "numericValue": 2000000,
        "date": "YYYY-MM",
        "source": "name",
        "sourceUrl": "url or null"
      }
    ],
    "signals": [
      { "type": "product" | "partnership" | "team" | "award", "title": "short title", "description": "1-2 sentences", "sentiment": "positive" | "neutral", "date": "YYYY-MM", "source": "name", "sourceUrl": "url or null" }
    ]
  },

  "risk": {
    "level": "none" | "watch" | "alert",
    "signals": [
      { "type": "silence" | "founder_departure" | "pivot" | "domain" | "layoffs" | "other", "title": "short title", "description": "1-2 sentences", "date": "YYYY-MM or null", "source": "name or null", "sourceUrl": "url or null" }
    ]
  },

  "summary": "2-3 sentence overall assessment for an angel investor",
  "checkInRecommended": true | false,
  "checkInReason": "specific reason or null"
}

Rules:
- activity.status: "active" = public signal in last 3mo, "quiet" = 3-12mo, "dark" = 12mo+ or nothing found
- momentum.trend: based on funding recency, revenue growth, hiring signals
- risk.level: "none" = all good, "watch" = something worth monitoring, "alert" = urgent concern
- Only include fundingRounds and revenueData with high confidence from public sources
- Use raw numbers for amounts (no $ signs), null if unknown
- If nothing found for a section return empty arrays
- Dates: YYYY-MM if month known, YYYY if only year
- Return ONLY the JSON object. No preamble, no explanation, no markdown fences.`;

  const FALLBACK = {
    activity: { status: 'unknown', websiteStatus: 'unknown', signals: [] },
    momentum: { trend: 'unknown', fundingRounds: [], revenueData: [], signals: [] },
    risk: { level: 'none', signals: [] },
    summary: 'No data returned.',
    checkInRecommended: false,
    checkInReason: null,
  };

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
        max_tokens: 2000,
        system: 'You are a JSON-only investment research API. You must respond with a single valid JSON object and absolutely nothing else — no preamble, no explanation, no markdown, no code fences. Your entire response must be parseable by JSON.parse().',
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
    if (!textBlock?.text) return res.status(200).json(FALLBACK);

    // Robustly extract JSON: find the first { and last } in the response
    // This handles any preamble or trailing text Claude might add
    const raw = textBlock.text;
    const start = raw.indexOf('{');
    const end = raw.lastIndexOf('}');
    if (start === -1 || end === -1 || end <= start) {
      console.error('No JSON object found in response:', raw.slice(0, 200));
      return res.status(200).json(FALLBACK);
    }

    const parsed = JSON.parse(raw.slice(start, end + 1));
    return res.status(200).json(parsed);

  } catch (e) {
    console.error('Signals API error:', e);
    return res.status(500).json({ error: e.message });
  }
}
