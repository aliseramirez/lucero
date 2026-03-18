import { useState, useEffect, useCallback, createContext, useContext } from 'react'
import { auth, db } from '../lib/supabase'

const AuthContext = createContext(null)

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null)
  const [profile, setProfile] = useState(null)
  const [settings, setSettings] = useState(null)
  const [isLoading, setIsLoading] = useState(true)
  const [error, setError] = useState(null)

  const loadUserData = useCallback(async (userId) => {
    try {
      try {
        const { data: profileData, error: profileError } = await db.getProfile(userId)
        if (!profileError && profileData) {
          setProfile(profileData)
        } else {
          setProfile({ id: userId, onboarding_complete: false })
        }
      } catch (e) {
        console.warn('Failed to load profile:', e)
        setProfile({ id: userId, onboarding_complete: false })
      }
      try {
        const { data: settingsData, error: settingsError } = await db.getSettings(userId)
        if (!settingsError && settingsData) {
          setSettings(settingsData)
        }
      } catch (e) {
        console.warn('Failed to load settings:', e)
      }
    } catch (e) {
      console.error('Error loading user data:', e)
    }
  }, [])

  useEffect(() => {
    let mounted = true

    const init = async () => {
      try {
        // Read session from localStorage eagerly before listener fires
        const { session } = await auth.getSession()
        if (mounted && session?.user) {
          setUser(session.user)
          await loadUserData(session.user.id)
        }
      } catch (e) {
        console.warn('getSession error:', e)
      } finally {
        if (mounted) setIsLoading(false)
      }
    }

    init()

    // Listen for subsequent changes only — INITIAL_SESSION handled above
    const { data: { subscription } } = auth.onAuthStateChange(async (event, session) => {
      if (!mounted) return
      console.log('Auth event:', event)

      if (event === 'SIGNED_IN') {
        if (session?.user) {
          setUser(session.user)
          await loadUserData(session.user.id)
        }
        setIsLoading(false)
      } else if (event === 'SIGNED_OUT') {
        setUser(null)
        setProfile(null)
        setSettings(null)
        setIsLoading(false)
      } else if (event === 'TOKEN_REFRESHED') {
        if (session?.user) setUser(session.user)
      }
      // INITIAL_SESSION intentionally ignored — handled by getSession() above
    })

    const fallback = setTimeout(() => {
      if (mounted) {
        console.warn('Auth fallback timeout')
        setIsLoading(false)
      }
    }, 4000)

    return () => {
      mounted = false
      subscription?.unsubscribe()
      clearTimeout(fallback)
    }
  }, [loadUserData])

  const signInWithProvider = useCallback(async (provider) => {
    setError(null)
    try {
      const { error } = await auth.signInWithProvider(provider)
      if (error) throw error
    } catch (e) {
      setError(e.message)
      setIsLoading(false)
    }
  }, [])

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

  const completeOnboarding = useCallback(async (prefs) => {
    setProfile(prev => ({ ...prev, onboarding_complete: true }))
    if (!user) return { success: true }
    try {
      await db.updateProfile(user.id, { onboarding_complete: true })
    } catch (e) {
      console.warn('Failed to save onboarding to profile:', e)
    }
    if (prefs) {
      try {
        await db.upsertSettings(user.id, {
          investor_type: prefs.investorType,
          deal_volume: prefs.dealVolume,
          investment_stage: prefs.investmentStage,
          check_size: prefs.checkSize
        })
      } catch (e) {
        console.warn('Failed to save onboarding preferences:', e)
      }
    }
    return { success: true }
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

export function useAuth() {
  const context = useContext(AuthContext)
  if (!context) {
    throw new Error('useAuth must be used within AuthProvider')
  }
  return context
}

export default useAuth
