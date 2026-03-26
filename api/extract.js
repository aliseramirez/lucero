export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { content, pdfBase64, dealName, existingData } = req.body;
  if (!content && !pdfBase64) return res.status(400).json({ error: 'content or pdfBase64 required' });

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'ANTHROPIC_API_KEY not configured' });

  const extractionPrompt = `You are analyzing a founder update for an angel investor's portfolio company "${dealName}".

Existing known data:
- Revenue data points: ${JSON.stringify(existingData?.revenueLog || [])}
- Fundraise history: ${JSON.stringify(existingData?.fundraiseHistory || [])}

Extract ALL useful investment insights. Return ONLY valid JSON:

{
  "revenuePoints": [
    {
      "metric": "ARR" | "MRR" | "Revenue" | "GMV" | "Customers" | "Users",
      "value": "display string e.g. $2M ARR",
      "numericValue": 2000000,
      "date": "YYYY-MM",
      "confidence": "high" | "medium" | "low"
    }
  ],
  "fundingSignals": [
    {
      "type": "active_raise" | "closed_round" | "exploring",
      "roundName": "e.g. Series A",
      "amount": 5000000,
      "leadInvestor": "name or null",
      "participants": ["investor1"],
      "timeline": "e.g. closing Q2 2025",
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
    { "type": "hire" | "departure" | "promotion", "name": "person name or null", "role": "role title", "description": "1 sentence" }
  ],
  "keyTakeaway": "1-2 sentence summary of the most important thing",
  "sentiment": "positive" | "neutral" | "negative" | "mixed"
}

Rules:
- Only extract what is explicitly stated or strongly implied
- For revenue: only include if a specific number or metric is mentioned
- If nothing found for a category return empty array []
- numericValue should be raw number in dollars`;

  try {
    let messageContent;

    if (pdfBase64) {
      // Send PDF as document for Claude to read natively
      messageContent = [
        {
          type: 'document',
          source: { type: 'base64', media_type: 'application/pdf', data: pdfBase64 },
        },
        { type: 'text', text: extractionPrompt },
      ];
    } else {
      messageContent = `${extractionPrompt}\n\nFounder update content:\n---\n${content}\n---`;
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
