export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { deal } = req.body;
  if (!deal?.company) return res.status(400).json({ error: 'deal required' });

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'ANTHROPIC_API_KEY not configured' });

  const fmt = (n) => n ? `$${(n/1000000).toFixed(1)}M` : null;

  const prompt = `Write a concise investment memo for an angel investor's portfolio company.

Company: ${deal.company}
Stage: ${deal.stage || 'unknown'} | Industry: ${deal.industry || 'unknown'}
Investment: ${deal.invested ? `$${deal.invested.toLocaleString()}` : 'unknown'} via ${deal.vehicle || 'unknown'}
${deal.cap ? `Cap: ${fmt(deal.cap)}` : ''}

Revenue data: ${deal.revenueLog?.length ? deal.revenueLog.map(r => `${r.value || r.metric} (${r.date?.substring(0,7)})`).join(', ') : 'None logged'}

Fundraise history: ${deal.fundraiseHistory?.length ? deal.fundraiseHistory.map(r => `${r.roundName} ${r.amountRaised ? fmt(r.amountRaised) : ''} ${r.date?.substring(0,7) || ''}`).join(' → ') : 'None logged'}

Recent founder updates: ${deal.founderUpdates?.length ? deal.founderUpdates.join('\n---\n') : 'None logged'}

External signals: ${deal.signals ? `Activity: ${deal.signals.activity}, Momentum: ${deal.signals.momentum}, Risk: ${deal.signals.risk}. ${deal.signals.summary || ''}` : 'Not yet fetched'}

Key milestones: ${deal.milestones?.length ? deal.milestones.map(m => m.title).join(', ') : 'None'}

Write a 3-4 paragraph investment memo covering:
1. Why I invested — thesis and key conviction
2. Current state — what's happened since investment, revenue/growth if known
3. Key risks and what to watch
4. Return potential — what would make this a winner

Write in first person, concise, honest. Use "unknown" or "not yet clear" where data is missing rather than speculating. Plain text, no markdown headers.`;

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
        max_tokens: 800,
        messages: [{ role: 'user', content: prompt }],
      }),
    });

    if (!response.ok) {
      const err = await response.text();
      return res.status(response.status).json({ error: err });
    }

    const data = await response.json();
    const text = data.content.find(b => b.type === 'text')?.text || '';
    return res.status(200).json({ memo: text });
  } catch (e) {
    console.error('Memo API error:', e);
    return res.status(500).json({ error: e.message });
  }
}
