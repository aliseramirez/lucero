import React, { useState } from 'react'
import { useAuth } from '../hooks/useAuth'
import { useDeals } from '../hooks/useDeals'

// ============================================================================
// UTILITIES
// ============================================================================

const formatCurrency = (n) => n >= 1000000 ? `$${(n/1000000).toFixed(1)}M` : n >= 1000 ? `$${(n/1000).toFixed(0)}K` : `$${n}`

// ============================================================================
// LOGIN PAGE
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
    <div className="min-h-screen bg-gradient-to-br from-stone-50 to-stone-200 flex items-center justify-center p-4">
      <div className="w-full max-w-md">
        {/* Logo */}
        <div className="text-center mb-8">
          <div className="w-16 h-16 bg-periwinkle rounded-2xl flex items-center justify-center mx-auto mb-4 shadow-lg">
            <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2">
              <path d="M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5"/>
            </svg>
          </div>
          <h1 className="text-2xl font-bold text-stone-900 mb-2">AngelFlow</h1>
          <p className="text-stone-500">Track your angel investments with clarity</p>
        </div>

        {/* Card */}
        <div className="bg-white rounded-2xl shadow-xl p-8 border border-stone-200">
          <h2 className="text-lg font-semibold text-stone-900 mb-6 text-center">
            {mode === 'signup' ? 'Create your account' : 'Sign in to continue'}
          </h2>

          {displayError && (
            <div className="p-3 bg-red-50 border border-red-200 rounded-lg mb-4">
              <p className="text-sm text-red-600">{displayError}</p>
            </div>
          )}

          {mode === 'email' || mode === 'signup' ? (
            <form onSubmit={handleEmailSubmit} className="space-y-4">
              {mode === 'signup' && (
                <div>
                  <label className="block text-sm font-medium text-stone-700 mb-1">Full Name</label>
                  <input
                    type="text"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    placeholder="John Doe"
                    required
                    className="input"
                  />
                </div>
              )}
              <div>
                <label className="block text-sm font-medium text-stone-700 mb-1">Email</label>
                <input
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="you@example.com"
                  required
                  className="input"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-stone-700 mb-1">Password</label>
                <input
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="••••••••"
                  required
                  minLength={6}
                  className="input"
                />
              </div>
              <button
                type="submit"
                disabled={isLoading}
                className="w-full btn-primary py-3 disabled:opacity-50"
              >
                {isLoading ? 'Please wait...' : (mode === 'signup' ? 'Create Account' : 'Sign In')}
              </button>
              <button
                type="button"
                onClick={() => setMode('signin')}
                className="w-full py-2 text-stone-500 text-sm"
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
                className="w-full flex items-center justify-center gap-3 px-4 py-3 rounded-xl border border-stone-300 bg-white hover:bg-stone-50 text-stone-700 font-medium transition-all disabled:opacity-50"
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
                <span className="text-xs text-stone-400">or</span>
                <div className="flex-1 h-px bg-stone-200"/>
              </div>

              {/* Email */}
              <button
                onClick={() => setMode('email')}
                className="w-full flex items-center justify-center gap-3 px-4 py-3 rounded-xl border border-stone-300 bg-white hover:bg-stone-50 text-stone-700 font-medium"
              >
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <rect x="2" y="4" width="20" height="16" rx="2"/>
                  <path d="M22 6l-10 7L2 6"/>
                </svg>
                Continue with Email
              </button>

              <p className="text-center text-sm text-stone-500 mt-4">
                Don't have an account?{' '}
                <button onClick={() => setMode('signup')} className="text-periwinkle font-medium">
                  Sign up
                </button>
              </p>
            </div>
          )}

          <p className="text-xs text-stone-400 text-center mt-6">
            By signing in, you agree to our Terms of Service and Privacy Policy
          </p>
        </div>
      </div>
    </div>
  )
}

// ============================================================================
// ONBOARDING FLOW
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
      <div className="min-h-screen bg-gradient-to-br from-stone-50 to-stone-200 flex flex-col">
        <header className="flex justify-between items-center p-4">
          <div className="flex items-center gap-2">
            <div className="w-8 h-8 bg-periwinkle rounded-lg flex items-center justify-center">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2.5">
                <rect x="3" y="3" width="18" height="18" rx="2"/>
              </svg>
            </div>
            <span className="font-semibold text-stone-900">AngelFlow</span>
          </div>
          <button onClick={signOut} className="text-sm text-stone-500">Sign out</button>
        </header>

        <div className="flex-1 flex flex-col items-center justify-center p-6 text-center">
          <div className="w-20 h-20 bg-periwinkle rounded-2xl flex items-center justify-center mb-6 shadow-lg">
            <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2">
              <path d="M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5"/>
            </svg>
          </div>

          <h1 className="text-3xl font-bold text-stone-900 mb-2">
            Welcome{firstName ? `, ${firstName}` : ''}!
          </h1>
          <p className="text-stone-500 mb-8 max-w-sm">
            Let's set up AngelFlow to match how you invest. This takes about 2 minutes.
          </p>

          <button onClick={() => setStep('questions')} className="btn-primary px-8 py-3 text-lg shadow-lg">
            Get Started
          </button>
          <button onClick={handleComplete} className="mt-4 text-stone-400 text-sm">
            Skip for now
          </button>
        </div>
      </div>
    )
  }

  // Questions
  const questions = [
    { key: 'investorType', question: 'How do you invest?', options: [
      { value: 'solo', label: 'Solo angel', desc: 'Individual investments' },
      { value: 'syndicate', label: 'Syndicate lead', desc: 'Lead deals with co-investors' },
      { value: 'fund', label: 'Small fund', desc: 'GP of a micro-fund' }
    ]},
    { key: 'dealVolume', question: 'How many deals do you see per month?', options: [
      { value: 'low', label: '1-5', desc: 'Selective pipeline' },
      { value: 'medium', label: '5-20', desc: 'Active pipeline' },
      { value: 'high', label: '20+', desc: 'High volume' }
    ]},
    { key: 'investmentStage', question: 'What stage do you focus on?', options: [
      { value: 'pre-seed', label: 'Pre-seed', desc: 'Idea to early product' },
      { value: 'seed', label: 'Seed', desc: 'Product-market fit' },
      { value: 'mixed', label: 'Mixed', desc: 'Multiple stages' }
    ]},
    { key: 'checkSize', question: 'Typical check size?', options: [
      { value: 'small', label: '$5-25K', desc: 'Smaller bets' },
      { value: 'medium', label: '$25-100K', desc: 'Standard angel' },
      { value: 'large', label: '$100K+', desc: 'Larger positions' }
    ]}
  ]

  const currentQ = questions.find(q => !prefs[q.key]) || questions[questions.length - 1]
  const answeredCount = Object.values(prefs).filter(Boolean).length
  const allAnswered = answeredCount === questions.length

  return (
    <div className="min-h-screen bg-stone-50 flex flex-col">
      <header className="flex justify-between items-center p-4">
        <button onClick={() => setStep('welcome')} className="flex items-center gap-1 text-stone-500">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="15 18 9 12 15 6"/></svg>
          Back
        </button>
        <button onClick={handleComplete} className="text-sm text-periwinkle font-medium">Skip</button>
      </header>

      {/* Progress */}
      <div className="px-6 mb-6">
        <div className="flex gap-2">
          {questions.map((q) => (
            <div key={q.key} className={`flex-1 h-1 rounded-full ${prefs[q.key] ? 'bg-periwinkle' : 'bg-stone-200'}`}/>
          ))}
        </div>
        <p className="text-xs text-stone-400 mt-2">{answeredCount} of {questions.length}</p>
      </div>

      <div className="flex-1 px-6 pb-6 max-w-lg mx-auto w-full">
        {!allAnswered ? (
          <>
            <h2 className="text-2xl font-bold text-stone-900 mb-6">{currentQ.question}</h2>
            <div className="space-y-3">
              {currentQ.options.map((opt) => (
                <button
                  key={opt.value}
                  onClick={() => setPrefs(p => ({ ...p, [currentQ.key]: opt.value }))}
                  className={`w-full p-4 rounded-xl text-left transition-all ${
                    prefs[currentQ.key] === opt.value 
                      ? 'bg-periwinkle text-white' 
                      : 'bg-white border border-stone-200 text-stone-900 hover:border-periwinkle'
                  }`}
                >
                  <div className="font-semibold">{opt.label}</div>
                  <div className={`text-sm ${prefs[currentQ.key] === opt.value ? 'text-white/70' : 'text-stone-500'}`}>{opt.desc}</div>
                </button>
              ))}
            </div>
          </>
        ) : (
          <div className="text-center pt-12">
            <div className="w-16 h-16 bg-emerald-500 rounded-full flex items-center justify-center mx-auto mb-6">
              <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="3">
                <polyline points="20 6 9 17 4 12"/>
              </svg>
            </div>
            <h2 className="text-2xl font-bold text-stone-900 mb-2">You're all set!</h2>
            <p className="text-stone-500 mb-8">AngelFlow is configured for your investing style.</p>
            <button onClick={handleComplete} className="btn-primary px-8 py-3">
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
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center p-4 z-50">
      <div className="bg-white rounded-2xl w-full max-w-md p-6 animate-fadeIn">
        <div className="flex justify-between items-center mb-6">
          <h2 className="text-lg font-semibold text-stone-900">Add Company</h2>
          <button onClick={onClose} className="p-1 text-stone-400 hover:text-stone-600">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
            </svg>
          </button>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-stone-700 mb-1">Company Name *</label>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Acme Corp"
              required
              className="input"
              autoFocus
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-stone-700 mb-1">Industry</label>
            <select
              value={industry}
              onChange={(e) => setIndustry(e.target.value)}
              className="input"
            >
              <option value="">Select industry</option>
              {industries.map(i => <option key={i} value={i}>{i}</option>)}
            </select>
          </div>

          <div>
            <label className="block text-sm font-medium text-stone-700 mb-1">Stage</label>
            <select
              value={stage}
              onChange={(e) => setStage(e.target.value)}
              className="input"
            >
              {stages.map(s => <option key={s} value={s}>{s.replace('-', ' ').replace(/\b\w/g, l => l.toUpperCase())}</option>)}
            </select>
          </div>

          <div className="flex gap-3 pt-4">
            <button type="button" onClick={onClose} className="flex-1 py-3 rounded-xl border border-stone-200 text-stone-600 font-medium">
              Cancel
            </button>
            <button type="submit" disabled={isSubmitting || !name.trim()} className="flex-1 btn-primary py-3 disabled:opacity-50">
              {isSubmitting ? 'Adding...' : 'Add Company'}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}

// ============================================================================
// MAIN APP
// ============================================================================

const MainApp = () => {
  const { user, profile, signOut } = useAuth()
  const { deals, screeningDeals, investedDeals, deferredDeals, isLoading, createDeal } = useDeals()
  const [activeTab, setActiveTab] = useState('active')
  const [showAddModal, setShowAddModal] = useState(false)

  const tabCounts = {
    active: screeningDeals.length,
    deferred: deferredDeals.length,
    portfolio: investedDeals.length
  }

  const currentDeals = activeTab === 'active' ? screeningDeals 
    : activeTab === 'deferred' ? deferredDeals 
    : investedDeals

  if (isLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-stone-50">
        <div className="text-center">
          <div className="spinner mx-auto mb-4"/>
          <p className="text-stone-500">Loading your deals...</p>
        </div>
      </div>
    )
  }

  return (
    <div className="min-h-screen bg-stone-100">
      {/* Header */}
      <header className="bg-white border-b border-stone-200 px-6 py-4">
        <div className="flex items-center justify-between max-w-5xl mx-auto">
          <div className="flex items-center gap-2">
            <div className="w-8 h-8 bg-periwinkle rounded-lg flex items-center justify-center">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2.5">
                <rect x="3" y="3" width="18" height="18" rx="2"/>
              </svg>
            </div>
            <span className="font-semibold text-stone-900">AngelFlow</span>
          </div>

          <div className="flex items-center gap-3">
            <button
              onClick={() => setShowAddModal(true)}
              className="btn-primary flex items-center gap-2"
            >
              <span className="text-lg leading-none">+</span> Add Company
            </button>
            
            <button
              onClick={signOut}
              className="flex items-center gap-2 px-3 py-2 rounded-lg bg-stone-100 hover:bg-stone-200 transition-colors"
            >
              <img
                src={profile?.avatar_url || `https://ui-avatars.com/api/?name=${encodeURIComponent(profile?.full_name || user?.email || 'U')}&background=5B6DC4&color=fff&size=32`}
                alt=""
                className="w-6 h-6 rounded-full"
              />
              <span className="text-sm text-stone-600">Sign out</span>
            </button>
          </div>
        </div>
      </header>

      {/* Tabs */}
      <div className="bg-white border-b border-stone-200 px-6 py-3">
        <div className="flex gap-2 max-w-5xl mx-auto">
          {[
            { key: 'active', label: 'Leads', icon: '📋' },
            { key: 'deferred', label: 'Deferred', icon: '👁' },
            { key: 'portfolio', label: 'Portfolio', icon: '💼' }
          ].map(tab => (
            <button
              key={tab.key}
              onClick={() => setActiveTab(tab.key)}
              className={`flex items-center gap-2 px-4 py-2 rounded-lg font-medium transition-colors ${
                activeTab === tab.key 
                  ? 'bg-stone-100 text-stone-900' 
                  : 'text-stone-500 hover:bg-stone-50'
              }`}
            >
              <span>{tab.icon}</span>
              {tab.label}
              <span className={`px-2 py-0.5 rounded text-xs ${
                activeTab === tab.key ? 'bg-periwinkle text-white' : 'bg-stone-200 text-stone-600'
              }`}>
                {tabCounts[tab.key]}
              </span>
            </button>
          ))}
        </div>
      </div>

      {/* Content */}
      <div className="px-6 py-8 max-w-5xl mx-auto">
        {currentDeals.length === 0 ? (
          <div className="text-center py-16">
            <div className="w-16 h-16 bg-stone-200 rounded-full flex items-center justify-center mx-auto mb-4">
              <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#a8a29e" strokeWidth="2">
                <path d="M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5"/>
              </svg>
            </div>
            <h3 className="text-lg font-semibold text-stone-900 mb-2">
              {activeTab === 'active' ? 'No leads yet' : activeTab === 'deferred' ? 'No deferred deals' : 'No investments yet'}
            </h3>
            <p className="text-stone-500 mb-6">
              {activeTab === 'active' ? 'Add a company to start tracking opportunities' : activeTab === 'deferred' ? 'Deals you defer will appear here for future review' : 'Companies you invest in will appear here'}
            </p>
            {activeTab === 'active' && (
              <button onClick={() => setShowAddModal(true)} className="btn-primary">
                Add Your First Company
              </button>
            )}
          </div>
        ) : (
          <div className="space-y-3">
            {currentDeals.map(deal => (
              <div
                key={deal.id}
                className="card p-4 flex items-center gap-4 hover:shadow-md transition-shadow cursor-pointer"
              >
                <div className="w-12 h-12 rounded-xl bg-stone-100 flex items-center justify-center flex-shrink-0">
                  <span className="text-lg font-semibold text-stone-500">
                    {deal.companyName?.charAt(0)?.toUpperCase()}
                  </span>
                </div>

                <div className="flex-1 min-w-0">
                  <h3 className="font-semibold text-stone-900">{deal.companyName}</h3>
                  <p className="text-sm text-stone-500">{deal.industry} · {deal.stage}</p>
                </div>

                <span className={`px-3 py-1 rounded-lg text-xs font-medium ${
                  deal.status === 'invested' ? 'bg-emerald-100 text-emerald-700' :
                  deal.status === 'deferred' ? 'bg-periwinkle-100 text-periwinkle' :
                  'bg-stone-100 text-stone-600'
                }`}>
                  {deal.status === 'invested' ? 'Invested' : deal.status === 'deferred' ? 'Watching' : 'Screening'}
                </span>

                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#d6d3d1" strokeWidth="2">
                  <polyline points="9 18 15 12 9 6"/>
                </svg>
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

  // Loading state
  if (isLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-stone-50">
        <div className="text-center">
          <div className="w-12 h-12 border-4 border-periwinkle border-t-transparent rounded-full animate-spin mx-auto mb-4"/>
          <p className="text-stone-500">Loading...</p>
        </div>
      </div>
    )
  }

  // Not authenticated - show login
  if (!isAuthenticated) {
    return <LoginPage />
  }

  // Authenticated but hasn't completed onboarding
  if (!hasCompletedOnboarding) {
    return <OnboardingFlow />
  }

  // Authenticated and onboarded - show main app
  return <MainApp />
}
