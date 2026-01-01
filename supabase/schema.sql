-- AngelFlow Database Schema for Supabase
-- Run this in the Supabase SQL Editor

-- Enable UUID extension
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- ============================================================================
-- PROFILES TABLE (extends Supabase auth.users)
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.profiles (
  id UUID REFERENCES auth.users(id) ON DELETE CASCADE PRIMARY KEY,
  email TEXT,
  full_name TEXT,
  avatar_url TEXT,
  provider TEXT,
  onboarding_complete BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Enable RLS
ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;

-- Policies
CREATE POLICY "Users can view own profile" ON public.profiles
  FOR SELECT USING (auth.uid() = id);

CREATE POLICY "Users can update own profile" ON public.profiles
  FOR UPDATE USING (auth.uid() = id);

CREATE POLICY "Users can insert own profile" ON public.profiles
  FOR INSERT WITH CHECK (auth.uid() = id);

-- Function to create profile on signup
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER AS $$
BEGIN
  INSERT INTO public.profiles (id, email, full_name, avatar_url, provider)
  VALUES (
    NEW.id,
    NEW.email,
    COALESCE(NEW.raw_user_meta_data->>'full_name', NEW.raw_user_meta_data->>'name', ''),
    COALESCE(NEW.raw_user_meta_data->>'avatar_url', NEW.raw_user_meta_data->>'picture', ''),
    NEW.raw_app_meta_data->>'provider'
  );
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Trigger for new user signup
DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();

-- ============================================================================
-- USER SETTINGS TABLE
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.user_settings (
  id UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
  user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE UNIQUE NOT NULL,
  investor_type TEXT, -- 'solo', 'syndicate', 'fund'
  deal_volume TEXT, -- 'low', 'medium', 'high'
  investment_stage TEXT, -- 'pre-seed', 'seed', 'mixed'
  check_size TEXT, -- 'small', 'medium', 'large'
  appearance TEXT DEFAULT 'light', -- 'light', 'dark', 'auto'
  notifications JSONB DEFAULT '{"push": false, "reminderFrequency": "daily"}'::jsonb,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Enable RLS
ALTER TABLE public.user_settings ENABLE ROW LEVEL SECURITY;

-- Policies
CREATE POLICY "Users can view own settings" ON public.user_settings
  FOR SELECT USING (auth.uid() = user_id);

CREATE POLICY "Users can update own settings" ON public.user_settings
  FOR UPDATE USING (auth.uid() = user_id);

CREATE POLICY "Users can insert own settings" ON public.user_settings
  FOR INSERT WITH CHECK (auth.uid() = user_id);

-- ============================================================================
-- DEALS TABLE
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.deals (
  id UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
  user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE NOT NULL,
  
  -- Basic info
  company_name TEXT NOT NULL,
  logo_url TEXT,
  website TEXT,
  industry TEXT,
  stage TEXT, -- 'pre-seed', 'seed', 'series-a', etc.
  
  -- Status
  status TEXT DEFAULT 'screening', -- 'screening', 'invested', 'deferred', 'passed'
  status_entered_at TIMESTAMPTZ DEFAULT NOW(),
  engagement TEXT DEFAULT 'active', -- 'active', 'inactive'
  needs_attention BOOLEAN DEFAULT FALSE,
  
  -- Source
  source_type TEXT, -- 'intro', 'cold', 'event', etc.
  source_name TEXT,
  
  -- Investment data (when invested)
  investment_amount INTEGER,
  investment_date DATE,
  investment_vehicle TEXT, -- 'SAFE', 'Convertible Note', 'Equity'
  investment_why_yes TEXT,
  
  -- Terms
  terms JSONB DEFAULT '{}'::jsonb,
  -- Structure: { instrument, cap, discount, proRata, mfn, boardSeat, notes }
  
  -- Defer data (when deferred)
  defer_type TEXT, -- 'watching', 'learning'
  defer_reason TEXT,
  defer_revisit_type TEXT, -- 'date', 'milestone', 'signal'
  defer_revisit_detail TEXT,
  defer_revisit_date DATE,
  
  -- Pass data (when passed)
  pass_reasons TEXT[], -- Array of reasons
  pass_why TEXT,
  pass_keep_tracking BOOLEAN DEFAULT FALSE,
  
  -- Portfolio metrics (for invested deals)
  portfolio_mrr INTEGER,
  portfolio_mrr_change TEXT,
  portfolio_arr INTEGER,
  portfolio_headcount INTEGER,
  portfolio_runway_months INTEGER,
  portfolio_last_contact DATE,
  
  -- LOI/Timeline
  loi_due TIMESTAMPTZ,
  
  -- Notes
  notes TEXT[],
  working_notes JSONB DEFAULT '[]'::jsonb,
  
  -- Timestamps
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  last_activity TIMESTAMPTZ DEFAULT NOW()
);

-- Enable RLS
ALTER TABLE public.deals ENABLE ROW LEVEL SECURITY;

-- Policies
CREATE POLICY "Users can view own deals" ON public.deals
  FOR SELECT USING (auth.uid() = user_id);

CREATE POLICY "Users can create own deals" ON public.deals
  FOR INSERT WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update own deals" ON public.deals
  FOR UPDATE USING (auth.uid() = user_id);

CREATE POLICY "Users can delete own deals" ON public.deals
  FOR DELETE USING (auth.uid() = user_id);

-- Index for faster queries
CREATE INDEX IF NOT EXISTS deals_user_id_idx ON public.deals(user_id);
CREATE INDEX IF NOT EXISTS deals_status_idx ON public.deals(status);
CREATE INDEX IF NOT EXISTS deals_user_status_idx ON public.deals(user_id, status);

-- ============================================================================
-- DEAL FOUNDERS TABLE
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.deal_founders (
  id UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
  deal_id UUID REFERENCES public.deals(id) ON DELETE CASCADE NOT NULL,
  user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE NOT NULL,
  
  name TEXT NOT NULL,
  role TEXT, -- 'CEO', 'CTO', etc.
  email TEXT,
  linkedin TEXT,
  background TEXT,
  years_experience INTEGER,
  
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Enable RLS
ALTER TABLE public.deal_founders ENABLE ROW LEVEL SECURITY;

-- Policies
CREATE POLICY "Users can view own deal founders" ON public.deal_founders
  FOR SELECT USING (auth.uid() = user_id);

CREATE POLICY "Users can create own deal founders" ON public.deal_founders
  FOR INSERT WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update own deal founders" ON public.deal_founders
  FOR UPDATE USING (auth.uid() = user_id);

CREATE POLICY "Users can delete own deal founders" ON public.deal_founders
  FOR DELETE USING (auth.uid() = user_id);

-- Index
CREATE INDEX IF NOT EXISTS deal_founders_deal_id_idx ON public.deal_founders(deal_id);

-- ============================================================================
-- DEAL MILESTONES TABLE
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.deal_milestones (
  id UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
  deal_id UUID REFERENCES public.deals(id) ON DELETE CASCADE NOT NULL,
  user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE NOT NULL,
  
  type TEXT, -- 'fundraising', 'growth', 'hire', 'product', 'partnership', 'press'
  title TEXT NOT NULL,
  description TEXT,
  date DATE,
  source TEXT,
  source_url TEXT,
  verified BOOLEAN DEFAULT FALSE,
  sentiment TEXT, -- 'positive', 'neutral', 'negative'
  
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Enable RLS
ALTER TABLE public.deal_milestones ENABLE ROW LEVEL SECURITY;

-- Policies
CREATE POLICY "Users can view own deal milestones" ON public.deal_milestones
  FOR SELECT USING (auth.uid() = user_id);

CREATE POLICY "Users can create own deal milestones" ON public.deal_milestones
  FOR INSERT WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update own deal milestones" ON public.deal_milestones
  FOR UPDATE USING (auth.uid() = user_id);

CREATE POLICY "Users can delete own deal milestones" ON public.deal_milestones
  FOR DELETE USING (auth.uid() = user_id);

-- Index
CREATE INDEX IF NOT EXISTS deal_milestones_deal_id_idx ON public.deal_milestones(deal_id);

-- ============================================================================
-- DEAL ATTACHMENTS TABLE
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.deal_attachments (
  id UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
  deal_id UUID REFERENCES public.deals(id) ON DELETE CASCADE NOT NULL,
  user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE NOT NULL,
  
  name TEXT NOT NULL,
  type TEXT, -- 'deck', 'financials', 'legal', 'update', 'other'
  file_url TEXT,
  file_size INTEGER,
  
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Enable RLS
ALTER TABLE public.deal_attachments ENABLE ROW LEVEL SECURITY;

-- Policies
CREATE POLICY "Users can view own deal attachments" ON public.deal_attachments
  FOR SELECT USING (auth.uid() = user_id);

CREATE POLICY "Users can create own deal attachments" ON public.deal_attachments
  FOR INSERT WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update own deal attachments" ON public.deal_attachments
  FOR UPDATE USING (auth.uid() = user_id);

CREATE POLICY "Users can delete own deal attachments" ON public.deal_attachments
  FOR DELETE USING (auth.uid() = user_id);

-- Index
CREATE INDEX IF NOT EXISTS deal_attachments_deal_id_idx ON public.deal_attachments(deal_id);

-- ============================================================================
-- UPDATED_AT TRIGGER FUNCTION
-- ============================================================================

CREATE OR REPLACE FUNCTION public.update_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Apply to tables
DROP TRIGGER IF EXISTS update_profiles_updated_at ON public.profiles;
CREATE TRIGGER update_profiles_updated_at
  BEFORE UPDATE ON public.profiles
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();

DROP TRIGGER IF EXISTS update_user_settings_updated_at ON public.user_settings;
CREATE TRIGGER update_user_settings_updated_at
  BEFORE UPDATE ON public.user_settings
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();

DROP TRIGGER IF EXISTS update_deals_updated_at ON public.deals;
CREATE TRIGGER update_deals_updated_at
  BEFORE UPDATE ON public.deals
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();

-- ============================================================================
-- STORAGE BUCKET FOR ATTACHMENTS (optional)
-- ============================================================================

-- Run this separately in Supabase dashboard under Storage
-- INSERT INTO storage.buckets (id, name, public) VALUES ('attachments', 'attachments', false);

-- ============================================================================
-- DONE!
-- ============================================================================

-- Verify tables were created
SELECT table_name FROM information_schema.tables WHERE table_schema = 'public';
