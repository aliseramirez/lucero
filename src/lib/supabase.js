import { createClient } from '@supabase/supabase-js'

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY

if (!supabaseUrl || !supabaseAnonKey) {
  throw new Error("Missing VITE_SUPABASE_URL or VITE_SUPABASE_ANON_KEY");
}

export const supabase = createClient(supabaseUrl || '', supabaseAnonKey || '', {
  auth: {
    autoRefreshToken: true,
    persistSession: true,
    detectSessionInUrl: true
  }
})

// Auth helper functions
export const auth = {
  // Sign in with OAuth provider
  async signInWithProvider(provider) {
    const { data, error } = await supabase.auth.signInWithOAuth({
      provider,
      options: {
        redirectTo: window.location.origin
      }
    })
    return { data, error }
  }
  ,

  // Sign in with email/password
  async signInWithEmail(email, password) {
    const { data, error } = await supabase.auth.signInWithPassword({
      email,
      password
    })
    return { data, error }
  },

  // Sign up with email/password
  async signUpWithEmail(email, password, fullName) {
    const { data, error } = await supabase.auth.signUp({
      email,
      password,
      options: {
        data: {
          full_name: fullName
        }
      }
    })
    return { data, error }
  },

  // Sign out
  async signOut() {
    const { error } = await supabase.auth.signOut()
    return { error }
  },

  // Get current session
  async getSession() {
    const { data: { session }, error } = await supabase.auth.getSession()
    return { session, error }
  },

  // Get current user
  async getUser() {
    const { data: { user }, error } = await supabase.auth.getUser()
    return { user, error }
  },

  // Listen to auth state changes
  onAuthStateChange(callback) {
    return supabase.auth.onAuthStateChange(callback)
  }
}

// Database helper functions
export const db = {
  // Profiles
  async getProfile(userId) {
    const { data, error } = await supabase
      .from('profiles')
      .select('*')
      .eq('id', userId)
      .single()
    return { data, error }
  },

  async updateProfile(userId, updates) {
    const { data, error } = await supabase
      .from('profiles')
      .update(updates)
      .eq('id', userId)
      .select()
      .single()
    return { data, error }
  },

  // Settings
  async getSettings(userId) {
    const { data, error } = await supabase
      .from('user_settings')
      .select('*')
      .eq('user_id', userId)
      .single()
    return { data, error }
  },

  async upsertSettings(userId, settings) {
    const { data, error } = await supabase
      .from('user_settings')
      .upsert({ user_id: userId, ...settings })
      .select()
      .single()
    return { data, error }
  },

  // Deals
  async getDeals(userId) {
    const { data, error } = await supabase
      .from('deals')
      .select(`
        *,
        founders:deal_founders(*),
        milestones:deal_milestones(*),
        attachments:deal_attachments(*)
      `)
      .eq('user_id', userId)
      .order('created_at', { ascending: false })
    return { data, error }
  },

  async getDeal(dealId) {
    const { data, error } = await supabase
      .from('deals')
      .select(`
        *,
        founders:deal_founders(*),
        milestones:deal_milestones(*),
        attachments:deal_attachments(*)
      `)
      .eq('id', dealId)
      .single()
    return { data, error }
  },

  async createDeal(userId, deal) {
    const { data, error } = await supabase
      .from('deals')
      .insert({ user_id: userId, ...deal })
      .select()
      .single()
    return { data, error }
  },

  async updateDeal(dealId, updates) {
    const { data, error } = await supabase
      .from('deals')
      .update(updates)
      .eq('id', dealId)
      .select()
      .single()
    return { data, error }
  },

  async deleteDeal(dealId) {
    const { error } = await supabase
      .from('deals')
      .delete()
      .eq('id', dealId)
    return { error }
  },

  // Founders
  async addFounder(dealId, userId, founder) {
    const { data, error } = await supabase
      .from('deal_founders')
      .insert({ deal_id: dealId, user_id: userId, ...founder })
      .select()
      .single()
    return { data, error }
  },

  async updateFounder(founderId, updates) {
    const { data, error } = await supabase
      .from('deal_founders')
      .update(updates)
      .eq('id', founderId)
      .select()
      .single()
    return { data, error }
  },

  async deleteFounder(founderId) {
    const { error } = await supabase
      .from('deal_founders')
      .delete()
      .eq('id', founderId)
    return { error }
  },

  // Milestones
  async addMilestone(dealId, userId, milestone) {
    const { data, error } = await supabase
      .from('deal_milestones')
      .insert({ deal_id: dealId, user_id: userId, ...milestone })
      .select()
      .single()
    return { data, error }
  },

  async updateMilestone(milestoneId, updates) {
    const { data, error } = await supabase
      .from('deal_milestones')
      .update(updates)
      .eq('id', milestoneId)
      .select()
      .single()
    return { data, error }
  },

  async deleteMilestone(milestoneId) {
    const { error } = await supabase
      .from('deal_milestones')
      .delete()
      .eq('id', milestoneId)
    return { error }
  },

  // Attachments
  async addAttachment(dealId, userId, attachment) {
    const { data, error } = await supabase
      .from('deal_attachments')
      .insert({ deal_id: dealId, user_id: userId, ...attachment })
      .select()
      .single()
    return { data, error }
  },

  async deleteAttachment(attachmentId) {
    const { error } = await supabase
      .from('deal_attachments')
      .delete()
      .eq('id', attachmentId)
    return { error }
  }
}

export default supabase
