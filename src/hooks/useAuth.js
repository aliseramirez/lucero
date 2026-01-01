import { useState, useEffect, useCallback, createContext, useContext } from 'react'
import { auth, db } from '../lib/supabase'

// Create context
const AuthContext = createContext(null)

// Auth Provider component
export function AuthProvider({ children }) {
  const [user, setUser] = useState(null)
  const [profile, setProfile] = useState(null)
  const [settings, setSettings] = useState(null)
  const [isLoading, setIsLoading] = useState(true)
  const [error, setError] = useState(null)

  // Load profile and settings
  const loadUserData = useCallback(async (userId) => {
    try {
      // Get profile
      const { data: profileData, error: profileError } = await db.getProfile(userId)
      if (profileError && profileError.code !== 'PGRST116') {
        console.error('Error loading profile:', profileError)
      } else if (profileData) {
        setProfile(profileData)
      }

      // Get settings
      const { data: settingsData, error: settingsError } = await db.getSettings(userId)
      if (settingsError && settingsError.code !== 'PGRST116') {
        console.error('Error loading settings:', settingsError)
      } else if (settingsData) {
        setSettings(settingsData)
      }
    } catch (e) {
      console.error('Error loading user data:', e)
    }
  }, [])

  // Initialize auth state
  useEffect(() => {
    let mounted = true

    const initAuth = async () => {
      try {
        // Check for existing session
        const { session } = await auth.getSession()
        
        if (mounted) {
          if (session?.user) {
            setUser(session.user)
            await loadUserData(session.user.id)
          }
          setIsLoading(false)
        }
      } catch (e) {
        console.error('Auth init error:', e)
        if (mounted) {
          setError(e.message)
          setIsLoading(false)
        }
      }
    }

    initAuth()

    // Listen for auth changes
    const { data: { subscription } } = auth.onAuthStateChange(async (event, session) => {
      if (mounted) {
        if (event === 'SIGNED_IN' && session?.user) {
          setUser(session.user)
          await loadUserData(session.user.id)
        } else if (event === 'SIGNED_OUT') {
          setUser(null)
          setProfile(null)
          setSettings(null)
        }
      }
    })

    return () => {
      mounted = false
      subscription?.unsubscribe()
    }
  }, [loadUserData])

  // Sign in with OAuth
  const signInWithProvider = useCallback(async (provider) => {
    setIsLoading(true)
    setError(null)
    
    try {
      const { error } = await auth.signInWithProvider(provider)
      if (error) throw error
    } catch (e) {
      setError(e.message)
      setIsLoading(false)
    }
  }, [])

  // Sign in with email
  const signInWithEmail = useCallback(async (email, password) => {
    setIsLoading(true)
    setError(null)
    
    try {
      const { data, error } = await auth.signInWithEmail(email, password)
      if (error) throw error
      return { data }
    } catch (e) {
      setError(e.message)
      setIsLoading(false)
      return { error: e }
    }
  }, [])

  // Sign up with email
  const signUpWithEmail = useCallback(async (email, password, fullName) => {
    setIsLoading(true)
    setError(null)
    
    try {
      const { data, error } = await auth.signUpWithEmail(email, password, fullName)
      if (error) throw error
      return { data }
    } catch (e) {
      setError(e.message)
      setIsLoading(false)
      return { error: e }
    }
  }, [])

  // Sign out
  const signOut = useCallback(async () => {
    setIsLoading(true)
    
    try {
      await auth.signOut()
      setUser(null)
      setProfile(null)
      setSettings(null)
    } catch (e) {
      console.error('Sign out error:', e)
    } finally {
      setIsLoading(false)
    }
  }, [])

  // Update profile
  const updateProfile = useCallback(async (updates) => {
    if (!user) return { error: new Error('Not authenticated') }
    
    try {
      const { data, error } = await db.updateProfile(user.id, updates)
      if (error) throw error
      setProfile(data)
      return { data }
    } catch (e) {
      return { error: e }
    }
  }, [user])

  // Update settings
  const updateSettings = useCallback(async (updates) => {
    if (!user) return { error: new Error('Not authenticated') }
    
    try {
      const { data, error } = await db.upsertSettings(user.id, updates)
      if (error) throw error
      setSettings(data)
      return { data }
    } catch (e) {
      return { error: e }
    }
  }, [user])

  // Complete onboarding
  const completeOnboarding = useCallback(async (prefs) => {
    if (!user) return { error: new Error('Not authenticated') }
    
    try {
      // Update profile
      await db.updateProfile(user.id, { onboarding_complete: true })
      
      // Save preferences as settings
      if (prefs) {
        await db.upsertSettings(user.id, {
          investor_type: prefs.investorType,
          deal_volume: prefs.dealVolume,
          investment_stage: prefs.investmentStage,
          check_size: prefs.checkSize
        })
      }
      
      setProfile(prev => ({ ...prev, onboarding_complete: true }))
      return { success: true }
    } catch (e) {
      return { error: e }
    }
  }, [user])

  const value = {
    user,
    profile,
    settings,
    isLoading,
    error,
    isAuthenticated: !!user,
    hasCompletedOnboarding: profile?.onboarding_complete ?? false,
    signInWithProvider,
    signInWithEmail,
    signUpWithEmail,
    signOut,
    updateProfile,
    updateSettings,
    completeOnboarding
  }

  return (
    <AuthContext.Provider value={value}>
      {children}
    </AuthContext.Provider>
  )
}

// Hook to use auth context
export function useAuth() {
  const context = useContext(AuthContext)
  if (!context) {
    throw new Error('useAuth must be used within AuthProvider')
  }
  return context
}

export default useAuth
