# AngelFlow - Angel Investment Tracking App

A modern web application for angel investors to track deals, make decisions, and learn from outcomes.

## Tech Stack

- **Frontend**: React + Tailwind CSS
- **Backend**: Supabase (PostgreSQL + Auth + Real-time)
- **Hosting**: Vercel (frontend) + Supabase (backend)

## Quick Start (15 minutes)

### Step 1: Create Supabase Project

1. Go to [supabase.com](https://supabase.com) and sign up (free)
2. Click "New Project"
3. Name it `angelflow` and set a database password
4. Wait ~2 minutes for project to provision
5. Go to Settings → API and copy:
   - `Project URL` (looks like `https://xxxxx.supabase.co`)
   - `anon public` key (long string starting with `eyJ...`)

### Step 2: Set Up Database

1. In Supabase dashboard, go to **SQL Editor**
2. Click "New Query"
3. Paste the contents of `supabase/schema.sql` (included in this project)
4. Click "Run" to create all tables

### Step 3: Configure Authentication

1. In Supabase dashboard, go to **Authentication → Providers**
2. Enable **Google**:
   - Go to [Google Cloud Console](https://console.cloud.google.com)
   - Create new project (or use existing)
   - Go to APIs & Services → Credentials
   - Create OAuth 2.0 Client ID (Web application)
   - Add authorized redirect URI: `https://YOUR_PROJECT.supabase.co/auth/v1/callback`
   - Copy Client ID and Client Secret back to Supabase

3. (Optional) Enable **Email** for email/password login:
   - Just toggle it on in Supabase

### Step 4: Configure Environment

1. Copy `.env.example` to `.env.local`:
   ```bash
   cp .env.example .env.local
   ```

2. Fill in your Supabase credentials:
   ```
   VITE_SUPABASE_URL=https://your-project.supabase.co
   VITE_SUPABASE_ANON_KEY=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...
   ```

### Step 5: Install & Run

```bash
# Install dependencies
npm install

# Run development server
npm run dev

# Open http://localhost:5173
```

### Step 6: Deploy to Vercel

1. Push code to GitHub
2. Go to [vercel.com](https://vercel.com) and import your repo
3. Add environment variables in Vercel dashboard:
   - `VITE_SUPABASE_URL`
   - `VITE_SUPABASE_ANON_KEY`
4. Deploy!

---

## Project Structure

```
angelflow-app/
├── public/
│   └── favicon.svg
├── src/
│   ├── lib/
│   │   └── supabase.js      # Supabase client setup
│   ├── hooks/
│   │   ├── useAuth.js       # Authentication hook
│   │   └── useDeals.js      # Deals CRUD hook
│   ├── components/
│   │   └── App.jsx          # Main app (from AngelFlow.jsx)
│   ├── main.jsx             # React entry point
│   └── index.css            # Tailwind CSS
├── supabase/
│   ├── schema.sql           # Database schema
│   └── seed.sql             # Optional demo data
├── index.html
├── package.json
├── vite.config.js
├── tailwind.config.js
├── postcss.config.js
├── .env.example
└── README.md
```

---

## Database Schema

### Tables

- **profiles** - User profiles (auto-created on signup)
- **deals** - Investment opportunities
- **deal_founders** - Founders for each deal
- **deal_milestones** - Milestones/signals for deals
- **deal_attachments** - Files attached to deals
- **user_settings** - User preferences

### Row Level Security (RLS)

All tables have RLS enabled so users can only access their own data.

---

## Features

### Authentication
- Google OAuth (primary)
- Email/password (optional)
- Persistent sessions
- Automatic token refresh

### Deal Management
- Create, edit, delete deals
- Status workflow: Screening → Invested/Deferred/Passed
- Rich deal data: founders, terms, milestones, attachments

### Portfolio Tracking
- Track invested companies
- Log milestones and signals
- Monitor performance

### Dashboard
- Capital deployment overview
- Signal detection
- Pattern analysis

---

## Environment Variables

| Variable | Description |
|----------|-------------|
| `VITE_SUPABASE_URL` | Your Supabase project URL |
| `VITE_SUPABASE_ANON_KEY` | Supabase anonymous/public key |

---

## Common Issues

### "Invalid API key"
- Make sure you copied the `anon public` key, not the `service_role` key

### "No user found"
- Check that Google OAuth is configured correctly in Supabase
- Verify redirect URI matches exactly

### "Permission denied"
- RLS policies might not be applied - run schema.sql again

---

## Development

```bash
# Run dev server
npm run dev

# Build for production
npm run build

# Preview production build
npm run preview
```

---

## Support

For issues, check:
1. Supabase dashboard logs
2. Browser console for errors
3. Network tab for API failures

---

## License

MIT
