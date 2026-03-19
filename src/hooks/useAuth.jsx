import { useState, useEffect, useCallback, createContext, useContext } from 'react'
import { supabase } from '../lib/supabase'

const AuthContext = createContext(null)

// Synchronously read session from localStorage — prevents any flash on refresh
const getInitialSession = () => {
  try {
    const raw = localStorage.getItem('lucero-auth')
    if (!raw) return null
    const parsed = JSON.parse(raw)
    const session = parsed?.currentSession || parsed
    if (session?.expires_at && session.expires_at * 1000 < Date.now()) return null
    return session?.user ? session : null
  } catch { return null }
}

export function AuthProvider({ children }) {
  const initialSession = getInitialSession()
  const [user, setUser] = useState(initialSession?.user ?? null)
  const [isLoading, setIsLoading] = useState(!initialSession)
  const [error, setError] = useState(null)

  useEffect(() => {
    let mounted = true

    const { data: { subscription } } = supabase.auth.onAuthStateChange((event, session) => {
      if (!mounted) return
      if (event === 'SIGNED_IN' || event === 'INITIAL_SESSION') {
        if (session?.user) setUser(session.user)
        setIsLoading(false)
      } else if (event === 'SIGNED_OUT') {
        setUser(null)
        setIsLoading(false)
      } else if (event === 'TOKEN_REFRESHED') {
        if (session?.user) setUser(session.user)
      }
      // Always stop loading after first auth event
      setIsLoading(false)
    })

    // Safety fallback
    const timeout = setTimeout(() => { if (mounted) setIsLoading(false) }, 3000)

    return () => { mounted = false; subscription?.unsubscribe(); clearTimeout(timeout) }
  }, [])

  const signInWithProvider = useCallback(async (provider) => {
    setError(null)
    const { error } = await supabase.auth.signInWithOAuth({
      provider,
      options: { redirectTo: window.location.origin }
    })
    if (error) setError(error.message)
  }, [])

  const signOut = useCallback(async () => {
    await supabase.auth.signOut()
    setUser(null)
  }, [])

  return (
    <AuthContext.Provider value={{
      user,
      isLoading,
      error,
      isAuthenticated: !!user,
      signInWithProvider,
      signOut,
    }}>
      {children}
    </AuthContext.Provider>
  )
}

export function useAuth() {
  const context = useContext(AuthContext)
  if (!context) throw new Error('useAuth must be used within AuthProvider')
  return context
}

export default useAuth
