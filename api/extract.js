export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { content, pdfBase64, dealName, existingData } = req.body;
  if (!content && !pdfBase64) return res.status(400).json({ error: 'content or pdfBase64 required' });

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'ANTHROPIC_API_KEY not configured' });

  const prompt = `You are analyzing an investment document for an angel investor tracking portfolio company "${dealName || 'unknown'}".

This may be a founder update, call notes, OR a financial statement (SPV financials, Carta report, etc.).

Extract ALL useful insights. Return ONLY valid JSON with no markdown or preamble:

{
  "revenuePoints": [{"metric":"string","value":"display string","numericValue":0,"date":"YYYY-MM","confidence":"high"}],
  "fundingSignals": [{"type":"closed_round","roundName":"string","amount":0,"leadInvestor":null,"participants":[],"timeline":null,"confidence":"high"}],
  "risks": [{"title":"string","description":"string","severity":"medium"}],
  "positives": [{"title":"string","description":"string"}],
  "teamChanges": [{"type":"hire","name":null,"role":"string","description":"string"}],
  "navUpdate": {"nav":0,"date":"YYYY-MM","costBasis":0,"totalFees":0},
  "keyTakeaway": "string",
  "sentiment": "positive"
}

SPV/fund statement rules (Carta, AngelList):
- "Total members equity" or "Members equity end of year" = navUpdate.nav
- "Investment at fair value (cost $X)" = navUpdate.costBasis  
- Sum of management + admin fees = navUpdate.totalFees
- Statement date = navUpdate.date in YYYY-MM format
- If navUpdate.nav is 0 or not found, omit the navUpdate field entirely
- Return empty arrays for categories with no findings`;

  const tryExtract = async (messageContent, headers) => {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, ...headers },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 1500,
        messages: [{ role: 'user', content: messageContent }],
      }),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error?.message || `HTTP ${response.status}`);
    const text = data.content?.find(b => b.type === 'text')?.text || '';
    return JSON.parse(text.replace(/```json\n?|```\n?/g, '').trim());
  };

  try {
    let result;

    if (pdfBase64) {
      // Try native PDF support first
      try {
        result = await tryExtract(
          [
            { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: pdfBase64 } },
            { type: 'text', text: prompt },
          ],
          { 'anthropic-version': '2023-06-01', 'anthropic-beta': 'pdfs-2024-09-25' }
        );
      } catch (pdfErr) {
        console.error('PDF native failed, falling back to text extraction:', pdfErr.message);
        // Fallback: decode base64 to binary, extract readable ASCII text from PDF
        const binaryStr = atob(pdfBase64);
        const bytes = new Uint8Array(binaryStr.length);
        for (let i = 0; i < binaryStr.length; i++) bytes[i] = binaryStr.charCodeAt(i);
        // Extract text between parentheses in PDF streams (text objects)
        let raw = '';
        for (let i = 0; i < bytes.length; i++) {
          const c = bytes[i];
          if (c >= 32 && c < 127) raw += String.fromCharCode(c);
          else if (c === 10 || c === 13) raw += '\n';
        }
        // Pull text from PDF BT/ET blocks and parenthesized strings
        const parens = raw.match(/\(([^)]{2,80})\)/g) || [];
        const extracted = parens.map(p => p.slice(1,-1).replace(/\\n/g,' ').trim()).filter(s => /[a-zA-Z0-9]/.test(s)).join(' ');
        const textContent = extracted.length > 100 ? extracted : raw.replace(/\s+/g, ' ').substring(0, 6000);
        result = await tryExtract(
          `${prompt}\n\nDocument text:\n---\n${textContent}\n---`,
          { 'anthropic-version': '2023-06-01' }
        );
      }
    } else {
      result = await tryExtract(
        `${prompt}\n\nDocument content:\n---\n${content}\n---`,
        { 'anthropic-version': '2023-06-01' }
      );
    }

    return res.status(200).json(result);
  } catch (e) {
    console.error('Extract API error:', e.message);
    return res.status(500).json({ error: e.message });
  }
}
