# Convex

A lightweight portfolio tracker for angel investors. One job: know what's happening at your portfolio companies without having to chase it.

**Built in public by [@aliseramirez](https://github.com/aliseramirez) as a live PM credibility demo.**

---

## What it does

- **Add companies you've invested in** — stage, vehicle, thesis, founders, terms
- **Passive signals from third-party sources** — real news pulled via Claude AI web search (funding rounds, launches, grants, press) on page load and on demand
- **Update log with nudge** — log founder updates, get a banner when you've gone too long without checking in
- **Document links** — SAFEs, K-1s, cap table, equity docs all in one place per company

---

## Tech Stack

- **Frontend**: React + Tailwind CSS
- **Backend**: Supabase (PostgreSQL + Auth)
- **AI signals**: Anthropic Claude API with web search (proxied via Vercel serverless function)
- **Hosting**: Vercel

---

## Quick Start

### 1. Clone and install

```bash
git clone https://github.com/aliseramirez/convex.git
cd convex
npm install
```

### 2. Create a Supabase project

1. Go to [supabase.com](https://supabase.com) and create a free project
2. In the SQL Editor, run `supabase/schema.sql` to create all tables
3. Go to Settings → API and copy your Project URL and `anon public` key

### 3. Get an Anthropic API key

1. Go to [console.anthropic.com](https://console.anthropic.com) → API Keys
2. Create a new key (starts with `sk-ant-...`)

### 4. Configure environment

```bash
cp .env.example .env.local
```

Fill in `.env.local`:

```
VITE_SUPABASE_URL=https://your-project.supabase.co
VITE_SUPABASE_ANON_KEY=eyJ...
```

### 5. Run locally

```bash
npm run dev
# Open http://localhost:5173
```

> **Note:** The passive signals feature requires the Vercel serverless function (`api/signals.js`) to run. In local dev, signals will silently fail and the app falls back to showing milestones only. To test signals locally, run `vercel dev` instead of `npm run dev`.

---

## Deploy to Vercel

1. Push to GitHub
2. Import the repo at [vercel.com](https://vercel.com)
3. Add these environment variables in the Vercel dashboard:

| Variable | Description |
|----------|-------------|
| `VITE_SUPABASE_URL` | Your Supabase project URL |
| `VITE_SUPABASE_ANON_KEY` | Supabase anon/public key |
| `ANTHROPIC_API_KEY` | Your Anthropic API key (server-side only) |

4. Deploy

The `api/signals.js` serverless function is picked up automatically by Vercel from the `api/` folder at the repo root. It proxies AI signal fetches server-side so your Anthropic API key is never exposed in the browser.

---

## Project Structure

```
convex/
├── api/
│   └── signals.js           # Vercel serverless function — AI signal proxy
├── src/
│   ├── components/
│   │   └── App.jsx          # Entire frontend (single-file React app)
│   ├── lib/
│   │   └── supabase.js      # Supabase client
│   ├── hooks/
│   │   ├── useAuth.js
│   │   └── useDeals.js
│   ├── main.jsx
│   └── index.css
├── supabase/
│   ├── schema.sql           # Run this to set up your database
│   └── seed.sql             # Optional demo data
├── vercel.json              # CORS headers for /api routes
├── .env.example
└── README.md
```

---

## How passive signals work

When you open Portfolio Monitor, the app calls `/api/signals` once per portfolio company (sequentially, with a delay to respect rate limits). The serverless function sends a web search request to Claude, which finds recent news and returns structured JSON. Results appear in the feed with a **Live** badge.

You can refresh signals any time with the **Pull Updates** button.

**Rate limits:** The free Anthropic tier allows ~30k input tokens/minute. With 3 companies and a 4-second delay between requests, this stays comfortably within limits. If you add more companies or hit limits, increase the delay in `fetchAllSignals` in `App.jsx`.

---

## Authentication

Supports Google OAuth and email/password via Supabase Auth.

To enable Google OAuth:
1. Go to Supabase → Authentication → Providers → Google
2. Create an OAuth 2.0 Client ID in [Google Cloud Console](https://console.cloud.google.com)
3. Add authorized redirect URI: `https://YOUR_PROJECT.supabase.co/auth/v1/callback`
4. Paste the Client ID and Secret into Supabase

---

## Database

All tables have Row Level Security (RLS) enabled — users can only access their own data.

| Table | Description |
|-------|-------------|
| `profiles` | Auto-created on signup |
| `deals` | Portfolio companies |
| `deal_founders` | Founders per deal |
| `deal_milestones` | Update log entries |
| `deal_attachments` | File references |
| `user_settings` | Preferences |

---

## Contributing

PRs welcome. This is a focused POC — features should serve the core job: *know what's happening at your portfolio companies without chasing it.*

---

## License

MIT
