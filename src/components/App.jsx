import React, { useState } from 'react'
import { useAuth } from '../hooks/useAuth'
import { useDeals } from '../hooks/useDeals'

// ============================================================================
// ICONS (Lucide-style line icons for consistency)
// ============================================================================

const Icons = {
  layers: (
    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5"/>
    </svg>
  ),
  briefcase: (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="2" y="7" width="20" height="14" rx="2" ry="2"/><path d="M16 21V5a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v16"/>
    </svg>
  ),
  eye: (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/>
    </svg>
  ),
  inbox: (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="22 12 16 12 14 15 10 15 8 12 2 12"/><path d="M5.45 5.11L2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"/>
    </svg>
  ),
  plus: (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>
    </svg>
  ),
  chevronRight: (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="9 18 15 12 9 6"/>
    </svg>
  ),
  chevronLeft: (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="15 18 9 12 15 6"/>
    </svg>
  ),
  check: (
    <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="20 6 9 17 4 12"/>
    </svg>
  ),
  shield: (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>
    </svg>
  ),
  zap: (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/>
    </svg>
  ),
  lock: (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/>
    </svg>
  ),
  x: (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
    </svg>
  ),
  user: (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/>
    </svg>
  ),
  users: (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>
    </svg>
  ),
  building: (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="4" y="2" width="16" height="20" rx="2" ry="2"/><path d="M9 22v-4h6v4"/><path d="M8 6h.01"/><path d="M16 6h.01"/><path d="M12 6h.01"/><path d="M12 10h.01"/><path d="M12 14h.01"/><path d="M16 10h.01"/><path d="M16 14h.01"/><path d="M8 10h.01"/><path d="M8 14h.01"/>
    </svg>
  ),
  trendingUp: (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="23 6 13.5 15.5 8.5 10.5 1 18"/><polyline points="17 6 23 6 23 12"/>
    </svg>
  ),
  dollarSign: (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <line x1="12" y1="1" x2="12" y2="23"/><path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"/>
    </svg>
  ),
  target: (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="10"/><circle cx="12" cy="12" r="6"/><circle cx="12" cy="12" r="2"/>
    </svg>
  ),
  lightbulb: (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M9 18h6"/><path d="M10 22h4"/><path d="M15.09 14c.18-.98.65-1.74 1.41-2.5A4.65 4.65 0 0 0 18 8 6 6 0 0 0 6 8c0 1 .23 2.23 1.5 3.5A4.61 4.61 0 0 1 8.91 14"/>
    </svg>
  )
}

// ============================================================================
// LOGIN PAGE - Enhanced with value props and credibility
// ============================================================================

const LoginPage = () => {
  const { signInWithProvider, signInWithEmail, signUpWithEmail, isLoading, error } = useAuth()
  const [mode, setMode] = useState('signin')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [name, setName] = useState('')
  const [localError, setLocalError] = useState(null)

  const handleEmailSubmit = async (e) => {
    e.preventDefault()
    setLocalError(null)
    
    if (mode === 'signup') {
      const { error } = await signUpWithEmail(email, password, name)
      if (error) setLocalError(error.message)
    } else {
      const { error } = await signInWithEmail(email, password)
      if (error) setLocalError(error.message)
    }
  }

  const displayError = localError || error

  return (
    <div className="min-h-screen bg-gradient-to-br from-stone-50 via-stone-100 to-stone-200 flex">
      {/* Left side - Branding & Value Props (hidden on mobile) */}
      <div className="hidden lg:flex lg:w-1/2 bg-gradient-to-br from-[#5B6DC4] to-[#4A5AB3] p-12 flex-col justify-between">
        <div>
          <div className="flex items-center gap-3 text-white">
            <div className="w-10 h-10 bg-white/20 backdrop-blur rounded-xl flex items-center justify-center">
              {Icons.layers}
            </div>
            <span className="text-xl font-semibold">AngelFlow</span>
          </div>
        </div>
        
        <div className="text-white">
          <h1 className="text-4xl font-bold mb-4 leading-tight">
            Your investment<br />thesis, organized.
          </h1>
          <p className="text-white/80 text-lg mb-8">
            Track deals, make decisions, and learn from outcomes — all in one modern workspace.
          </p>
          
          {/* Value props */}
          <div className="space-y-4">
            {[
              { icon: Icons.zap, text: 'Capture deals in seconds, not minutes' },
              { icon: Icons.target, text: 'Every deal gets a decision — no more limbo' },
              { icon: Icons.lightbulb, text: 'See patterns in your investing over time' }
            ].map((item, i) => (
              <div key={i} className="flex items-center gap-3 text-white/90">
                <div className="w-8 h-8 bg-white/10 rounded-lg flex items-center justify-center flex-shrink-0">
                  {item.icon}
                </div>
                <span>{item.text}</span>
              </div>
            ))}
          </div>
        </div>
        
        <div className="text-white/60 text-sm">
          Trusted by angels managing $50M+ in deal flow
        </div>
      </div>

      {/* Right side - Auth form */}
      <div className="flex-1 flex items-center justify-center p-6">
        <div className="w-full max-w-md">
          {/* Mobile logo */}
          <div className="lg:hidden text-center mb-8">
            <div className="w-14 h-14 bg-[#5B6DC4] rounded-2xl flex items-center justify-center mx-auto mb-4 shadow-lg text-white">
              {Icons.layers}
            </div>
            <h1 className="text-2xl font-bold text-stone-900">AngelFlow</h1>
            <p className="text-stone-500 text-sm mt-1">Track your angel investments with clarity</p>
          </div>

          {/* Auth Card */}
          <div className="bg-white rounded-2xl shadow-xl p-8 border border-stone-200">
            <h2 className="text-xl font-semibold text-stone-900 mb-2 text-center">
              {mode === 'signup' ? 'Create your account' : 'Welcome back'}
            </h2>
            <p className="text-stone-500 text-sm text-center mb-6">
              {mode === 'signup' ? 'Start tracking your deal flow today' : 'Sign in to continue to your deals'}
            </p>

            {displayError && (
              <div className="p-3 bg-red-50 border border-red-200 rounded-xl mb-4">
                <p className="text-sm text-red-600">{displayError}</p>
              </div>
            )}

            {mode === 'email' || mode === 'signup' ? (
              <form onSubmit={handleEmailSubmit} className="space-y-4">
                {mode === 'signup' && (
                  <div>
                    <label className="block text-sm font-medium text-stone-700 mb-1.5">Full Name</label>
                    <input
                      type="text"
                      value={name}
                      onChange={(e) => setName(e.target.value)}
                      placeholder="Jane Smith"
                      required
                      className="w-full px-4 py-3 rounded-xl border border-stone-200 focus:border-[#5B6DC4] focus:ring-2 focus:ring-[#5B6DC4]/20 outline-none transition-all"
                    />
                  </div>
                )}
                <div>
                  <label className="block text-sm font-medium text-stone-700 mb-1.5">Email</label>
                  <input
                    type="email"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    placeholder="you@example.com"
                    required
                    className="w-full px-4 py-3 rounded-xl border border-stone-200 focus:border-[#5B6DC4] focus:ring-2 focus:ring-[#5B6DC4]/20 outline-none transition-all"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-stone-700 mb-1.5">Password</label>
                  <input
                    type="password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    placeholder="••••••••"
                    required
                    minLength={6}
                    className="w-full px-4 py-3 rounded-xl border border-stone-200 focus:border-[#5B6DC4] focus:ring-2 focus:ring-[#5B6DC4]/20 outline-none transition-all"
                  />
                </div>
                <button
                  type="submit"
                  disabled={isLoading}
                  className="w-full bg-[#5B6DC4] hover:bg-[#4A5AB3] text-white font-medium py-3 rounded-xl transition-all disabled:opacity-50 shadow-sm hover:shadow-md"
                >
                  {isLoading ? 'Please wait...' : (mode === 'signup' ? 'Create Account' : 'Sign In')}
                </button>
                <button
                  type="button"
                  onClick={() => setMode('signin')}
                  className="w-full py-2 text-stone-500 text-sm hover:text-stone-700 transition-colors"
                >
                  ← Back to sign in options
                </button>
              </form>
            ) : (
              <div className="space-y-3">
                {/* Google */}
                <button
                  onClick={() => signInWithProvider('google')}
                  disabled={isLoading}
                  className="w-full flex items-center justify-center gap-3 px-4 py-3 rounded-xl border border-stone-200 bg-white hover:bg-stone-50 hover:border-stone-300 text-stone-700 font-medium transition-all disabled:opacity-50 shadow-sm"
                >
                  <svg width="20" height="20" viewBox="0 0 24 24">
                    <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"/>
                    <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"/>
                    <path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"/>
                    <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"/>
                  </svg>
                  Continue with Google
                </button>

                {/* Divider */}
                <div className="flex items-center gap-3 my-4">
                  <div className="flex-1 h-px bg-stone-200"/>
                  <span className="text-xs text-stone-400 uppercase tracking-wide">or</span>
                  <div className="flex-1 h-px bg-stone-200"/>
                </div>

                {/* Email */}
                <button
                  onClick={() => setMode('email')}
                  className="w-full flex items-center justify-center gap-3 px-4 py-3 rounded-xl border border-stone-200 bg-white hover:bg-stone-50 hover:border-stone-300 text-stone-700 font-medium transition-all shadow-sm"
                >
                  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <rect x="2" y="4" width="20" height="16" rx="2"/>
                    <path d="M22 6l-10 7L2 6"/>
                  </svg>
                  Continue with Email
                </button>

                <p className="text-center text-sm text-stone-500 mt-4">
                  Don't have an account?{' '}
                  <button onClick={() => setMode('signup')} className="text-[#5B6DC4] font-medium hover:underline">
                    Sign up free
                  </button>
                </p>
              </div>
            )}
          </div>

          {/* Security note */}
          <div className="flex items-center justify-center gap-2 mt-6 text-stone-400 text-sm">
            <span className="text-stone-300">{Icons.lock}</span>
            <span>Your data is encrypted and never shared</span>
          </div>
        </div>
      </div>
    </div>
  )
}

// ============================================================================
// ONBOARDING FLOW - Enhanced with context for each question
// ============================================================================

const OnboardingFlow = () => {
  const { user, profile, completeOnboarding, signOut } = useAuth()
  const [step, setStep] = useState('welcome')
  const [prefs, setPrefs] = useState({
    investorType: null,
    dealVolume: null,
    investmentStage: null,
    checkSize: null
  })

  const handleComplete = async () => {
    await completeOnboarding(prefs)
  }

  const firstName = profile?.full_name?.split(' ')[0] || user?.email?.split('@')[0] || ''

  if (step === 'welcome') {
    return (
      <div className="min-h-screen bg-gradient-to-br from-stone-50 via-stone-100 to-stone-200 flex flex-col">
        <header className="flex justify-between items-center p-4 lg:p-6">
          <div className="flex items-center gap-2">
            <div className="w-9 h-9 bg-[#5B6DC4] rounded-xl flex items-center justify-center text-white">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                <rect x="3" y="3" width="18" height="18" rx="2"/>
              </svg>
            </div>
            <span className="font-semibold text-stone-900">AngelFlow</span>
          </div>
          <button onClick={signOut} className="text-sm text-stone-500 hover:text-stone-700 transition-colors">Sign out</button>
        </header>

        <div className="flex-1 flex flex-col items-center justify-center p-6 text-center">
          <div className="w-20 h-20 bg-[#5B6DC4] rounded-2xl flex items-center justify-center mb-6 shadow-lg shadow-[#5B6DC4]/30 text-white">
            {Icons.layers}
          </div>

          <h1 className="text-3xl font-bold text-stone-900 mb-3">
            Welcome{firstName ? `, ${firstName}` : ''}!
          </h1>
          <p className="text-stone-500 mb-2 max-w-md">
            Let's personalize AngelFlow for how you invest.
          </p>
          <p className="text-stone-400 text-sm mb-8">
            4 quick questions · Takes about 1 minute
          </p>

          <button 
            onClick={() => setStep('questions')} 
            className="bg-[#5B6DC4] hover:bg-[#4A5AB3] text-white px-8 py-3.5 rounded-xl font-medium text-lg shadow-lg shadow-[#5B6DC4]/25 hover:shadow-xl hover:shadow-[#5B6DC4]/30 transition-all"
          >
            Get Started
          </button>
          <button onClick={handleComplete} className="mt-4 text-stone-400 text-sm hover:text-stone-600 transition-colors">
            Skip for now
          </button>
        </div>
      </div>
    )
  }

  // Questions with context explanations
  const questions = [
    { 
      key: 'investorType', 
      question: 'How do you invest?',
      context: 'This helps us tailor your workflow and defaults.',
      options: [
        { value: 'solo', label: 'Solo angel', desc: 'Individual investments', icon: Icons.user },
        { value: 'syndicate', label: 'Syndicate lead', desc: 'Lead deals with co-investors', icon: Icons.users },
        { value: 'fund', label: 'Small fund', desc: 'GP of a micro-fund', icon: Icons.building }
      ]
    },
    { 
      key: 'dealVolume', 
      question: 'How many deals do you see per month?',
      context: 'We\'ll optimize your pipeline view based on your volume.',
      options: [
        { value: 'low', label: '1-5', desc: 'Selective pipeline', icon: Icons.target },
        { value: 'medium', label: '5-20', desc: 'Active pipeline', icon: Icons.inbox },
        { value: 'high', label: '20+', desc: 'High volume', icon: Icons.zap }
      ]
    },
    { 
      key: 'investmentStage', 
      question: 'What stage do you focus on?',
      context: 'We\'ll highlight relevant metrics for your stage focus.',
      options: [
        { value: 'pre-seed', label: 'Pre-seed', desc: 'Idea to early product', icon: Icons.lightbulb },
        { value: 'seed', label: 'Seed', desc: 'Product-market fit', icon: Icons.trendingUp },
        { value: 'mixed', label: 'Mixed', desc: 'Multiple stages', icon: Icons.layers }
      ]
    },
    { 
      key: 'checkSize', 
      question: 'Typical check size?',
      context: 'We\'ll flag deals outside your typical range.',
      options: [
        { value: 'small', label: '$5-25K', desc: 'Smaller bets', icon: Icons.dollarSign },
        { value: 'medium', label: '$25-100K', desc: 'Standard angel', icon: Icons.dollarSign },
        { value: 'large', label: '$100K+', desc: 'Larger positions', icon: Icons.dollarSign }
      ]
    }
  ]

  const currentQ = questions.find(q => !prefs[q.key]) || questions[questions.length - 1]
  const answeredCount = Object.values(prefs).filter(Boolean).length
  const allAnswered = answeredCount === questions.length

  return (
    <div className="min-h-screen bg-stone-50 flex flex-col">
      <header className="flex justify-between items-center p-4 lg:p-6">
        <button onClick={() => setStep('welcome')} className="flex items-center gap-1 text-stone-500 hover:text-stone-700 transition-colors">
          {Icons.chevronLeft}
          <span className="text-sm">Back</span>
        </button>
        <button onClick={handleComplete} className="text-sm text-[#5B6DC4] font-medium hover:underline">Skip</button>
      </header>

      {/* Progress */}
      <div className="px-6 lg:px-8 mb-6">
        <div className="max-w-lg mx-auto">
          <div className="flex gap-2">
            {questions.map((q) => (
              <div 
                key={q.key} 
                className={`flex-1 h-1.5 rounded-full transition-all duration-300 ${prefs[q.key] ? 'bg-[#5B6DC4]' : 'bg-stone-200'}`}
              />
            ))}
          </div>
          <p className="text-xs text-stone-400 mt-2">{answeredCount} of {questions.length}</p>
        </div>
      </div>

      <div className="flex-1 px-6 pb-8 max-w-lg mx-auto w-full">
        {!allAnswered ? (
          <>
            <h2 className="text-2xl font-bold text-stone-900 mb-2">{currentQ.question}</h2>
            <p className="text-stone-500 text-sm mb-6">{currentQ.context}</p>
            
            <div className="space-y-3">
              {currentQ.options.map((opt) => (
                <button
                  key={opt.value}
                  onClick={() => setPrefs(p => ({ ...p, [currentQ.key]: opt.value }))}
                  className={`w-full p-4 rounded-xl text-left transition-all flex items-center gap-4 ${
                    prefs[currentQ.key] === opt.value 
                      ? 'bg-[#5B6DC4] text-white shadow-lg shadow-[#5B6DC4]/25' 
                      : 'bg-white border border-stone-200 text-stone-900 hover:border-[#5B6DC4]/50 hover:shadow-md'
                  }`}
                >
                  <div className={`w-10 h-10 rounded-lg flex items-center justify-center flex-shrink-0 ${
                    prefs[currentQ.key] === opt.value ? 'bg-white/20' : 'bg-stone-100'
                  }`}>
                    <span className={prefs[currentQ.key] === opt.value ? 'text-white' : 'text-stone-500'}>
                      {opt.icon}
                    </span>
                  </div>
                  <div>
                    <div className="font-semibold">{opt.label}</div>
                    <div className={`text-sm ${prefs[currentQ.key] === opt.value ? 'text-white/70' : 'text-stone-500'}`}>
                      {opt.desc}
                    </div>
                  </div>
                </button>
              ))}
            </div>
          </>
        ) : (
          <div className="text-center pt-12">
            <div className="w-20 h-20 bg-emerald-500 rounded-full flex items-center justify-center mx-auto mb-6 shadow-lg shadow-emerald-500/30 text-white">
              {Icons.check}
            </div>
            <h2 className="text-2xl font-bold text-stone-900 mb-2">You're all set!</h2>
            <p className="text-stone-500 mb-8">AngelFlow is personalized for your investing style.</p>
            <button 
              onClick={handleComplete} 
              className="bg-[#5B6DC4] hover:bg-[#4A5AB3] text-white px-8 py-3.5 rounded-xl font-medium shadow-lg shadow-[#5B6DC4]/25 hover:shadow-xl transition-all"
            >
              Start Using AngelFlow
            </button>
          </div>
        )}
      </div>
    </div>
  )
}

// ============================================================================
// ADD COMPANY MODAL
// ============================================================================

const AddCompanyModal = ({ onClose, onAdd }) => {
  const [name, setName] = useState('')
  const [industry, setIndustry] = useState('')
  const [stage, setStage] = useState('seed')
  const [isSubmitting, setIsSubmitting] = useState(false)

  const stages = ['pre-seed', 'seed', 'series-a', 'series-b', 'growth']
  const industries = ['AI/ML', 'Fintech', 'Healthcare', 'SaaS', 'Consumer', 'Crypto', 'Climate', 'Other']

  const handleSubmit = async (e) => {
    e.preventDefault()
    if (!name.trim()) return

    setIsSubmitting(true)
    await onAdd({
      companyName: name,
      industry: industry || 'Other',
      stage,
      status: 'screening'
    })
  }

  return (
    <div className="fixed inset-0 bg-black/50 backdrop-blur-sm flex items-center justify-center p-4 z-50">
      <div className="bg-white rounded-2xl w-full max-w-md p-6 shadow-2xl animate-fadeIn">
        <div className="flex justify-between items-center mb-6">
          <h2 className="text-xl font-semibold text-stone-900">Add Company</h2>
          <button onClick={onClose} className="p-2 text-stone-400 hover:text-stone-600 hover:bg-stone-100 rounded-lg transition-all">
            {Icons.x}
          </button>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-stone-700 mb-1.5">Company Name *</label>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Acme Corp"
              required
              className="w-full px-4 py-3 rounded-xl border border-stone-200 focus:border-[#5B6DC4] focus:ring-2 focus:ring-[#5B6DC4]/20 outline-none transition-all"
              autoFocus
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-stone-700 mb-1.5">Industry</label>
            <select
              value={industry}
              onChange={(e) => setIndustry(e.target.value)}
              className="w-full px-4 py-3 rounded-xl border border-stone-200 focus:border-[#5B6DC4] focus:ring-2 focus:ring-[#5B6DC4]/20 outline-none transition-all bg-white"
            >
              <option value="">Select industry</option>
              {industries.map(i => <option key={i} value={i}>{i}</option>)}
            </select>
          </div>

          <div>
            <label className="block text-sm font-medium text-stone-700 mb-1.5">Stage</label>
            <select
              value={stage}
              onChange={(e) => setStage(e.target.value)}
              className="w-full px-4 py-3 rounded-xl border border-stone-200 focus:border-[#5B6DC4] focus:ring-2 focus:ring-[#5B6DC4]/20 outline-none transition-all bg-white"
            >
              {stages.map(s => <option key={s} value={s}>{s.replace('-', ' ').replace(/\b\w/g, l => l.toUpperCase())}</option>)}
            </select>
          </div>

          <div className="flex gap-3 pt-4">
            <button 
              type="button" 
              onClick={onClose} 
              className="flex-1 py-3 rounded-xl border border-stone-200 text-stone-600 font-medium hover:bg-stone-50 transition-all"
            >
              Cancel
            </button>
            <button 
              type="submit" 
              disabled={isSubmitting || !name.trim()} 
              className="flex-1 bg-[#5B6DC4] hover:bg-[#4A5AB3] text-white py-3 rounded-xl font-medium disabled:opacity-50 transition-all shadow-sm hover:shadow-md"
            >
              {isSubmitting ? 'Adding...' : 'Add Company'}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}

// ============================================================================
// MAIN APP - Enhanced empty states
// ============================================================================

const MainApp = () => {
  const { user, profile, signOut } = useAuth()
  const { deals, screeningDeals, investedDeals, deferredDeals, isLoading, createDeal } = useDeals()
  const [activeTab, setActiveTab] = useState('active')
  const [showAddModal, setShowAddModal] = useState(false)

  const tabs = [
    { key: 'active', label: 'Leads', icon: Icons.inbox, count: screeningDeals.length },
    { key: 'deferred', label: 'Deferred', icon: Icons.eye, count: deferredDeals.length },
    { key: 'portfolio', label: 'Portfolio', icon: Icons.briefcase, count: investedDeals.length }
  ]

  const currentDeals = activeTab === 'active' ? screeningDeals 
    : activeTab === 'deferred' ? deferredDeals 
    : investedDeals

  // Empty state content per tab
  const emptyStates = {
    active: {
      title: 'Your pipeline starts here',
      description: 'Add a company you\'re currently evaluating to get started.',
      tip: 'Tip: Most investors start with a deal they\'re actively looking at.',
      showExample: true
    },
    deferred: {
      title: 'No deferred deals yet',
      description: 'When you defer a deal to revisit later, it will appear here.',
      tip: 'Deferred deals stay on your radar without cluttering your active pipeline.',
      showExample: false
    },
    portfolio: {
      title: 'No investments yet',
      description: 'Companies you invest in will appear here for tracking.',
      tip: 'Track milestones, updates, and performance over time.',
      showExample: false
    }
  }

  if (isLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-stone-50">
        <div className="text-center">
          <div className="w-10 h-10 border-4 border-[#5B6DC4] border-t-transparent rounded-full animate-spin mx-auto mb-4"/>
          <p className="text-stone-500">Loading your deals...</p>
        </div>
      </div>
    )
  }

  return (
    <div className="min-h-screen bg-stone-100">
      {/* Header */}
      <header className="bg-white border-b border-stone-200 px-4 lg:px-6 py-4">
        <div className="flex items-center justify-between max-w-6xl mx-auto">
          <div className="flex items-center gap-2">
            <div className="w-9 h-9 bg-[#5B6DC4] rounded-xl flex items-center justify-center text-white">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                <rect x="3" y="3" width="18" height="18" rx="2"/>
              </svg>
            </div>
            <span className="font-semibold text-stone-900">AngelFlow</span>
          </div>

          <div className="flex items-center gap-3">
            <button
              onClick={() => setShowAddModal(true)}
              className="bg-[#5B6DC4] hover:bg-[#4A5AB3] text-white pl-3 pr-4 py-2 rounded-xl font-medium flex items-center gap-2 transition-all shadow-sm hover:shadow-md"
            >
              {Icons.plus}
              <span className="hidden sm:inline">Add Company</span>
            </button>
            
            <button
              onClick={signOut}
              className="flex items-center gap-2 px-3 py-2 rounded-xl bg-stone-100 hover:bg-stone-200 transition-colors"
            >
              <img
                src={profile?.avatar_url || `https://ui-avatars.com/api/?name=${encodeURIComponent(profile?.full_name || user?.email || 'U')}&background=5B6DC4&color=fff&size=32`}
                alt=""
                className="w-7 h-7 rounded-full"
              />
              <span className="text-sm text-stone-600 hidden sm:inline">Sign out</span>
            </button>
          </div>
        </div>
      </header>

      {/* Tabs */}
      <div className="bg-white border-b border-stone-200 px-4 lg:px-6 py-3">
        <div className="flex gap-1 max-w-6xl mx-auto">
          {tabs.map(tab => (
            <button
              key={tab.key}
              onClick={() => setActiveTab(tab.key)}
              className={`flex items-center gap-2 px-4 py-2 rounded-lg font-medium transition-all ${
                activeTab === tab.key 
                  ? 'bg-stone-100 text-stone-900' 
                  : 'text-stone-500 hover:bg-stone-50 hover:text-stone-700'
              }`}
            >
              <span className={activeTab === tab.key ? 'text-[#5B6DC4]' : 'text-stone-400'}>
                {tab.icon}
              </span>
              <span className="hidden sm:inline">{tab.label}</span>
              <span className={`px-2 py-0.5 rounded-md text-xs font-medium ${
                activeTab === tab.key ? 'bg-[#5B6DC4] text-white' : 'bg-stone-200 text-stone-600'
              }`}>
                {tab.count}
              </span>
            </button>
          ))}
        </div>
      </div>

      {/* Content */}
      <div className="px-4 lg:px-6 py-8 max-w-6xl mx-auto">
        {currentDeals.length === 0 ? (
          <div className="text-center py-16 max-w-md mx-auto">
            {/* Example card for empty leads state */}
            {emptyStates[activeTab].showExample && (
              <div className="mb-8 opacity-60">
                <div className="bg-white rounded-xl p-4 border border-dashed border-stone-300 flex items-center gap-4">
                  <div className="w-12 h-12 rounded-xl bg-stone-100 flex items-center justify-center flex-shrink-0">
                    <span className="text-lg font-semibold text-stone-400">A</span>
                  </div>
                  <div className="text-left flex-1">
                    <div className="font-medium text-stone-400">Acme Corp</div>
                    <div className="text-sm text-stone-300">AI/ML · Seed</div>
                  </div>
                  <span className="px-3 py-1 rounded-lg text-xs font-medium bg-stone-100 text-stone-400">
                    Screening
                  </span>
                </div>
                <p className="text-xs text-stone-400 mt-2">Example</p>
              </div>
            )}

            <div className="w-16 h-16 bg-stone-200 rounded-2xl flex items-center justify-center mx-auto mb-4 text-stone-400">
              {activeTab === 'active' ? Icons.inbox : activeTab === 'deferred' ? Icons.eye : Icons.briefcase}
            </div>
            
            <h3 className="text-xl font-semibold text-stone-900 mb-2">
              {emptyStates[activeTab].title}
            </h3>
            <p className="text-stone-500 mb-4">
              {emptyStates[activeTab].description}
            </p>
            <p className="text-sm text-stone-400 mb-6">
              {emptyStates[activeTab].tip}
            </p>
            
            {activeTab === 'active' && (
              <button 
                onClick={() => setShowAddModal(true)} 
                className="bg-[#5B6DC4] hover:bg-[#4A5AB3] text-white px-6 py-3 rounded-xl font-medium transition-all shadow-sm hover:shadow-md"
              >
                Add Your First Company
              </button>
            )}
          </div>
        ) : (
          <div className="space-y-3">
            {currentDeals.map(deal => (
              <div
                key={deal.id}
                className="bg-white rounded-xl p-4 border border-stone-200 flex items-center gap-4 hover:shadow-md hover:border-stone-300 transition-all cursor-pointer group"
              >
                <div className="w-12 h-12 rounded-xl bg-stone-100 group-hover:bg-[#5B6DC4]/10 flex items-center justify-center flex-shrink-0 transition-colors">
                  <span className="text-lg font-semibold text-stone-500 group-hover:text-[#5B6DC4] transition-colors">
                    {deal.companyName?.charAt(0)?.toUpperCase()}
                  </span>
                </div>

                <div className="flex-1 min-w-0">
                  <h3 className="font-semibold text-stone-900">{deal.companyName}</h3>
                  <p className="text-sm text-stone-500">{deal.industry} · {deal.stage}</p>
                </div>

                <span className={`px-3 py-1.5 rounded-lg text-xs font-medium ${
                  deal.status === 'invested' ? 'bg-emerald-100 text-emerald-700' :
                  deal.status === 'deferred' ? 'bg-[#5B6DC4]/10 text-[#5B6DC4]' :
                  'bg-stone-100 text-stone-600'
                }`}>
                  {deal.status === 'invested' ? 'Invested' : deal.status === 'deferred' ? 'Watching' : 'Screening'}
                </span>

                <span className="text-stone-300 group-hover:text-stone-400 transition-colors">
                  {Icons.chevronRight}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Add Modal */}
      {showAddModal && (
        <AddCompanyModal
          onClose={() => setShowAddModal(false)}
          onAdd={async (data) => {
            await createDeal(data)
            setShowAddModal(false)
          }}
        />
      )}
    </div>
  )
}

// ============================================================================
// MAIN APP ROUTER
// ============================================================================

export default function App() {
  const { isAuthenticated, isLoading, hasCompletedOnboarding } = useAuth()

  if (isLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-stone-50">
        <div className="text-center">
          <div className="w-12 h-12 border-4 border-[#5B6DC4] border-t-transparent rounded-full animate-spin mx-auto mb-4"/>
          <p className="text-stone-500">Loading...</p>
        </div>
      </div>
    )
  }

  if (!isAuthenticated) {
    return <LoginPage />
  }

  if (!hasCompletedOnboarding) {
    return <OnboardingFlow />
  }

  return <MainApp />
}
