export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { content, pdfBase64, dealName, existingData } = req.body;
  if (!content && !pdfBase64) return res.status(400).json({ error: 'content or pdfBase64 required' });

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'ANTHROPIC_API_KEY not configured' });

  const prompt = `You are analyzing an investment document for an angel investor's portfolio company "${dealName}".

This may be a founder update email, call notes, OR a financial statement (SPV financials, fund statement, Carta report, etc.).

Existing data:
- Revenue: ${JSON.stringify(existingData?.revenueLog || [])}
- Fundraise history: ${JSON.stringify(existingData?.fundraiseHistory || [])}

Extract ALL useful investment insights. Return ONLY valid JSON:

{
  "revenuePoints": [
    {
      "metric": "ARR" | "MRR" | "Revenue" | "GMV" | "Customers" | "Users" | "NAV" | "Members Equity",
      "value": "display string e.g. $760,200 NAV",
      "numericValue": 760200,
      "date": "YYYY-MM",
      "confidence": "high" | "medium" | "low"
    }
  ],
  "fundingSignals": [
    {
      "type": "active_raise" | "closed_round" | "exploring",
      "roundName": "e.g. Series AA-2",
      "amount": 740000,
      "leadInvestor": null,
      "participants": [],
      "timeline": null,
      "confidence": "high" | "medium" | "low"
    }
  ],
  "risks": [
    { "title": "short title", "description": "1-2 sentences", "severity": "high" | "medium" | "low" }
  ],
  "positives": [
    { "title": "short title", "description": "1-2 sentences" }
  ],
  "teamChanges": [
    { "type": "hire" | "departure" | "promotion", "name": null, "role": "role title", "description": "1 sentence" }
  ],
  "navUpdate": {
    "nav": 760200,
    "date": "2025-12",
    "costBasis": 740000,
    "totalFees": 22750
  },
  "keyTakeaway": "1-2 sentence summary",
  "sentiment": "positive" | "neutral" | "negative" | "mixed"
}

Special rules for SPV/fund financial statements (Carta, AngelList, etc.):
- "Members' equity" or "Total members' equity" = NAV → put in navUpdate.nav AND revenuePoints with metric "NAV"
- "Investment at fair value" = current fair value of the underlying investment
- "Cost" next to the investment = cost basis → navUpdate.costBasis
- "Management fees" + "admin fees" = total fees → navUpdate.totalFees
- Statement date = navUpdate.date
- If investment is at cost (fair value = cost), note this as a positive: "Marked at cost — no write-down"
- If unrealized gain/loss is positive, note as positive signal

For all other documents: only extract what is explicitly stated.
Return empty arrays [] for categories with nothing found.
numericValue should be raw integer dollars.`;

  try {
    let messageContent;
    if (pdfBase64) {
      messageContent = [
        { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: pdfBase64 } },
        { type: 'text', text: prompt },
      ];
    } else {
      messageContent = `${prompt}\n\nDocument content:\n---\n${content}\n---`;
    }

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'anthropic-beta': 'pdfs-2024-09-25',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 1500,
        messages: [{ role: 'user', content: messageContent }],
      }),
    });

    if (!response.ok) {
      const err = await response.text();
      return res.status(response.status).json({ error: err });
    }

    const data = await response.json();
    const text = data.content.find(b => b.type === 'text')?.text || '';
    const parsed = JSON.parse(text.replace(/```json|```/g, '').trim());
    return res.status(200).json(parsed);
  } catch (e) {
    console.error('Extract API error:', e);
    return res.status(500).json({ error: e.message });
  }
}
