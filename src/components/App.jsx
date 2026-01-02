import React, { useState, useEffect, useRef } from 'react';
import { useAuth, AuthProvider } from '../hooks/useAuth';
import { useDeals } from '../hooks/useDeals';

// ============================================================================
// UTILITIES
// ============================================================================

const formatCurrency = (n) => {
  if (n === undefined || n === null) return '$0';
  const num = typeof n === 'string' ? parseFloat(n) : n;
  return num >= 1000000 ? `$${(num/1000000).toFixed(1)}M` : num >= 1000 ? `$${(num/1000).toFixed(0)}K` : `$${num}`;
};
const formatDate = (d) => d ? new Date(d).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : 'Unknown';
const daysAgo = (d) => d ? Math.floor((Date.now() - new Date(d).getTime()) / 86400000) : 0;

// ============================================================================
// STATUS CONFIG
// ============================================================================

const STATUS_CONFIG = {
  'screening': { label: 'Screening', color: 'bg-[#5B6DC4]', light: 'bg-[#5B6DC4]/10 text-[#5B6DC4] border border-[#5B6DC4]/30' },
  'invested': { label: 'Invested', color: 'bg-emerald-500', light: 'bg-emerald-50 text-emerald-600 border border-emerald-200' },
  'deferred': { label: 'Watching', color: 'bg-[#5B6DC4]', light: 'bg-[#5B6DC4]/10 text-[#5B6DC4] border border-[#5B6DC4]/30' },
  'passed': { label: 'Passed', color: 'bg-stone-400', light: 'bg-stone-100 text-stone-600 border border-stone-200' },
};

// ============================================================================
// ICONS (Lucide-style SVG)
// ============================================================================

const Icons = {
  layers: <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5"/></svg>,
  plus: <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>,
  chevronRight: <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="9 18 15 12 9 6"/></svg>,
  chevronLeft: <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="15 18 9 12 15 6"/></svg>,
  chevronDown: <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="6 9 12 15 18 9"/></svg>,
  check: <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12"/></svg>,
  x: <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>,
  search: <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>,
  settings: <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>,
  grid: <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/></svg>,
  clock: <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>,
  eye: <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>,
  activity: <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/></svg>,
  externalLink: <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>,
  logOut: <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M9 21H5a2 2 0 01-2-2V5a2 2 0 012-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/></svg>,
  user: <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>,
  users: <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>,
  building: <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="4" y="2" width="16" height="20" rx="2" ry="2"/><path d="M9 22v-4h6v4"/><path d="M8 6h.01"/><path d="M16 6h.01"/><path d="M12 6h.01"/><path d="M12 10h.01"/><path d="M12 14h.01"/><path d="M16 10h.01"/><path d="M16 14h.01"/><path d="M8 10h.01"/><path d="M8 14h.01"/></svg>,
  zap: <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg>,
  target: <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10"/><circle cx="12" cy="12" r="6"/><circle cx="12" cy="12" r="2"/></svg>,
  trendingUp: <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="23 6 13.5 15.5 8.5 10.5 1 18"/><polyline points="17 6 23 6 23 12"/></svg>,
  lightbulb: <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M9 18h6"/><path d="M10 22h4"/><path d="M15.09 14c.18-.98.65-1.74 1.41-2.5A4.65 4.65 0 0 0 18 8 6 6 0 0 0 6 8c0 1 .23 2.23 1.5 3.5A4.61 4.61 0 0 1 8.91 14"/></svg>,
  dollarSign: <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="12" y1="1" x2="12" y2="23"/><path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"/></svg>,
  inbox: <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="22 12 16 12 14 15 10 15 8 12 2 12"/><path d="M5.45 5.11L2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"/></svg>,
  lock: <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>,
  shield: <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>,
};

// ============================================================================
// TOAST COMPONENT
// ============================================================================

const Toast = ({ message, type = 'success', onClose }) => {
  useEffect(() => { const t = setTimeout(onClose, 2500); return () => clearTimeout(t); }, [onClose]);
  
  return (
    <div 
      className="fixed bottom-20 left-1/2 transform -translate-x-1/2 z-[200] px-4 py-2.5 rounded-lg text-sm font-medium flex items-center gap-2 shadow-md"
      style={{ 
        backgroundColor: type === 'error' ? '#FEE2E2' : '#EEF2FF',
        color: type === 'error' ? '#DC2626' : '#5B6DC4',
        border: type === 'error' ? '1px solid #FECACA' : '1px solid #C7D2FE'
      }}
    >
      {type === 'success' && Icons.check}
      {type === 'error' && Icons.x}
      {message}
    </div>
  );
};

// ============================================================================
// USER MENU COMPONENT
// ============================================================================

const UserMenu = () => {
  const { user, profile, signOut } = useAuth();
  const [isOpen, setIsOpen] = useState(false);
  const menuRef = useRef(null);
  
  useEffect(() => {
    const handleClickOutside = (e) => {
      if (menuRef.current && !menuRef.current.contains(e.target)) setIsOpen(false);
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);
  
  if (!user) return null;
  
  const displayName = profile?.full_name || user.email?.split('@')[0] || 'User';
  const avatarUrl = profile?.avatar_url || user.user_metadata?.avatar_url || 
    `https://ui-avatars.com/api/?name=${encodeURIComponent(displayName)}&background=5B6DC4&color=fff`;
  
  return (
    <div className="relative" ref={menuRef}>
      <button onClick={() => setIsOpen(!isOpen)} className="flex items-center gap-2 p-1.5 rounded-full hover:bg-stone-100 dark:hover:bg-stone-700 transition-colors">
        <img src={avatarUrl} alt={displayName} className="w-8 h-8 rounded-full" />
      </button>
      
      {isOpen && (
        <div className="absolute right-0 mt-2 w-64 bg-white dark:bg-stone-800 rounded-xl shadow-xl border border-stone-200 dark:border-stone-700 py-2 z-50">
          <div className="px-4 py-3 border-b border-stone-200 dark:border-stone-700">
            <p className="font-medium text-stone-900 dark:text-white truncate">{displayName}</p>
            <p className="text-sm text-stone-500 dark:text-stone-400 truncate">{user.email}</p>
          </div>
          <div className="py-1">
            <button onClick={() => { setIsOpen(false); signOut(); }} className="w-full px-4 py-2 text-left text-sm text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-900/20 flex items-center gap-2">
              {Icons.logOut}
              Sign out
            </button>
          </div>
        </div>
      )}
    </div>
  );
};

// ============================================================================
// LOGIN PAGE
// ============================================================================

const LoginPage = () => {
  const { signInWithProvider, isLoading, error } = useAuth();
  const [selectedProvider, setSelectedProvider] = useState(null);
  
  const handleLogin = async (provider) => {
    setSelectedProvider(provider);
    await signInWithProvider(provider);
  };
  
  return (
    <div className="min-h-screen flex">
      {/* Left side - Branding */}
      <div className="hidden lg:flex lg:w-1/2 bg-gradient-to-br from-[#5B6DC4] to-[#4F5FB3] p-12 flex-col justify-between">
        <div>
          <div className="flex items-center gap-3 mb-16">
            <div className="w-10 h-10 bg-white/20 backdrop-blur rounded-xl flex items-center justify-center text-white">{Icons.layers}</div>
            <span className="text-xl font-semibold text-white">AngelFlow</span>
          </div>
          
          <h1 className="text-4xl font-bold text-white mb-6 leading-tight">Your investment thesis, organized.</h1>
          
          <div className="space-y-6">
            <div className="flex items-start gap-4">
              <div className="w-10 h-10 rounded-xl bg-white/10 flex items-center justify-center flex-shrink-0 text-white">{Icons.zap}</div>
              <div>
                <h3 className="font-medium text-white mb-1">Capture deals in seconds</h3>
                <p className="text-white/70 text-sm">Voice notes, quick forms, or paste a deck link. Stay in flow.</p>
              </div>
            </div>
            <div className="flex items-start gap-4">
              <div className="w-10 h-10 rounded-xl bg-white/10 flex items-center justify-center flex-shrink-0 text-white">{Icons.target}</div>
              <div>
                <h3 className="font-medium text-white mb-1">Every deal gets a decision</h3>
                <p className="text-white/70 text-sm">No more purgatory. Invest, defer, or pass with clear reasoning.</p>
              </div>
            </div>
            <div className="flex items-start gap-4">
              <div className="w-10 h-10 rounded-xl bg-white/10 flex items-center justify-center flex-shrink-0 text-white">{Icons.trendingUp}</div>
              <div>
                <h3 className="font-medium text-white mb-1">See patterns over time</h3>
                <p className="text-white/70 text-sm">Track how your thesis evolves. Learn from outcomes.</p>
              </div>
            </div>
          </div>
        </div>
        <p className="text-white/50 text-sm">Trusted by angels managing $50M+ in deal flow</p>
      </div>
      
      {/* Right side - Auth */}
      <div className="flex-1 flex items-center justify-center p-8 bg-stone-50 dark:bg-stone-900">
        <div className="w-full max-w-md">
          <div className="lg:hidden text-center mb-8">
            <div className="w-16 h-16 bg-[#5B6DC4] rounded-2xl flex items-center justify-center mx-auto mb-4 shadow-lg text-white">{Icons.layers}</div>
            <h1 className="text-2xl font-bold text-stone-900 dark:text-white mb-2">AngelFlow</h1>
            <p className="text-stone-500 dark:text-stone-400">Track your angel investments with clarity</p>
          </div>
          
          <div className="bg-white dark:bg-stone-800 rounded-2xl shadow-xl p-8 border border-stone-200 dark:border-stone-700">
            <h2 className="text-lg font-semibold text-stone-900 dark:text-white mb-6 text-center">Sign in to continue</h2>
            
            {error && (
              <div className="mb-4 p-3 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-lg">
                <p className="text-sm text-red-600 dark:text-red-400">{error}</p>
              </div>
            )}
            
            <button
              onClick={() => handleLogin('google')}
              disabled={isLoading}
              className="w-full flex items-center justify-center gap-3 px-4 py-3 rounded-xl border border-stone-300 bg-white hover:bg-stone-50 text-stone-700 font-medium transition-all disabled:opacity-50"
            >
              {selectedProvider === 'google' && isLoading ? (
                <div className="w-5 h-5 border-2 border-stone-300 border-t-stone-600 rounded-full animate-spin" />
              ) : (
                <svg width="20" height="20" viewBox="0 0 24 24">
                  <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"/>
                  <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"/>
                  <path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"/>
                  <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"/>
                </svg>
              )}
              <span>Continue with Google</span>
            </button>
            
            <div className="mt-6 pt-6 border-t border-stone-200 dark:border-stone-700 flex items-center justify-center gap-2 text-xs text-stone-400">
              {Icons.lock}
              <span>Your data is encrypted and never shared</span>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};

// ============================================================================
// ONBOARDING FLOW
// ============================================================================

const OnboardingFlow = ({ onComplete, onSkip }) => {
  const [step, setStep] = useState(0);
  const [prefs, setPrefs] = useState({});
  
  const questions = [
    { key: 'investorType', title: 'How do you invest?', subtitle: 'This helps us tailor your workflow.',
      options: [
        { value: 'solo', label: 'Solo angel', desc: 'Individual investments from personal capital', icon: Icons.user },
        { value: 'syndicate', label: 'Syndicate lead', desc: 'Lead deals with co-investors', icon: Icons.users },
        { value: 'fund', label: 'Small fund', desc: 'GP of a micro-fund or family office', icon: Icons.building },
      ]},
    { key: 'dealVolume', title: 'How many deals do you see per month?', subtitle: "We'll optimize your pipeline view.",
      options: [
        { value: 'low', label: '1-5 deals', desc: 'Selective, high-conviction approach', icon: Icons.target },
        { value: 'medium', label: '5-20 deals', desc: 'Active but manageable pipeline', icon: Icons.inbox },
        { value: 'high', label: '20+ deals', desc: 'High-volume deal flow', icon: Icons.zap },
      ]},
    { key: 'investmentStage', title: 'What stage do you focus on?', subtitle: "We'll highlight relevant metrics.",
      options: [
        { value: 'pre-seed', label: 'Pre-seed', desc: 'Idea stage to early product', icon: Icons.lightbulb },
        { value: 'seed', label: 'Seed', desc: 'Product-market fit exploration', icon: Icons.target },
        { value: 'series-a', label: 'Series A+', desc: 'Scaling proven models', icon: Icons.trendingUp },
      ]},
    { key: 'checkSize', title: "What's your typical check size?", subtitle: "We'll flag deals outside your range.",
      options: [
        { value: 'small', label: '$5-25K', desc: 'Smaller, diversified bets', icon: Icons.dollarSign },
        { value: 'medium', label: '$25-100K', desc: 'Standard angel checks', icon: Icons.dollarSign },
        { value: 'large', label: '$100K+', desc: 'Larger, concentrated positions', icon: Icons.dollarSign },
      ]},
  ];
  
  const currentQuestion = questions[step];
  const progress = ((step + 1) / questions.length) * 100;
  
  const handleSelect = (value) => {
    const newPrefs = { ...prefs, [currentQuestion.key]: value };
    setPrefs(newPrefs);
    if (step < questions.length - 1) setStep(step + 1);
    else onComplete(newPrefs);
  };
  
  return (
    <div className="min-h-screen bg-stone-50 dark:bg-stone-900 flex flex-col">
      <header className="flex items-center justify-between px-6 py-4">
        <div className="flex items-center gap-2">
          <div className="w-8 h-8 bg-[#5B6DC4] rounded-lg flex items-center justify-center text-white">{Icons.layers}</div>
          <span className="font-semibold text-stone-900 dark:text-white">AngelFlow</span>
        </div>
        <button onClick={onSkip} className="text-sm text-stone-400 hover:text-stone-600">Skip for now</button>
      </header>
      
      <div className="px-6 py-2">
        <div className="h-1 bg-stone-200 dark:bg-stone-700 rounded-full overflow-hidden">
          <div className="h-full bg-[#5B6DC4] transition-all duration-300" style={{ width: `${progress}%` }} />
        </div>
        <p className="text-xs text-stone-400 mt-2">Question {step + 1} of {questions.length}</p>
      </div>
      
      <div className="flex-1 flex flex-col items-center justify-center px-6 py-8">
        <div className="w-full max-w-md">
          <h2 className="text-2xl font-bold text-stone-900 dark:text-white mb-2 text-center">{currentQuestion.title}</h2>
          <p className="text-stone-500 dark:text-stone-400 text-center mb-8">{currentQuestion.subtitle}</p>
          
          <div className="space-y-3">
            {currentQuestion.options.map((option) => (
              <button
                key={option.value}
                onClick={() => handleSelect(option.value)}
                className={`w-full flex items-center gap-4 p-4 rounded-xl border-2 transition-all text-left ${
                  prefs[currentQuestion.key] === option.value
                    ? 'border-[#5B6DC4] bg-[#5B6DC4]/5'
                    : 'border-stone-200 dark:border-stone-700 hover:border-stone-300 dark:hover:border-stone-600 bg-white dark:bg-stone-800'
                }`}
              >
                <div className={`w-12 h-12 rounded-xl flex items-center justify-center ${
                  prefs[currentQuestion.key] === option.value ? 'bg-[#5B6DC4] text-white' : 'bg-stone-100 dark:bg-stone-700 text-stone-500 dark:text-stone-400'
                }`}>{option.icon}</div>
                <div className="flex-1">
                  <p className="font-medium text-stone-900 dark:text-white">{option.label}</p>
                  <p className="text-sm text-stone-500 dark:text-stone-400">{option.desc}</p>
                </div>
                {prefs[currentQuestion.key] === option.value && (
                  <div className="w-6 h-6 rounded-full bg-[#5B6DC4] flex items-center justify-center text-white">{Icons.check}</div>
                )}
              </button>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
};

// ============================================================================
// ADD COMPANY MODAL
// ============================================================================

const AddCompanyModal = ({ onClose, onAdd }) => {
  const [form, setForm] = useState({
    companyName: '', industry: '', stage: 'seed', companyStatus: 'screening', engagement: 'active',
    investmentAmount: '', investmentDate: '', vehicle: 'SAFE', deferReason: '', passReason: '',
    founderName: '', founderRole: 'CEO', founderEmail: '', source: ''
  });
  const [isSubmitting, setIsSubmitting] = useState(false);

  const statusOptions = [
    { value: 'screening', label: 'Lead (Screening)', description: 'New opportunity to evaluate', color: '#5B6DC4' },
    { value: 'invested', label: 'Invested', description: 'Portfolio company', color: '#10b981' },
    { value: 'deferred', label: 'Deferred / Watching', description: 'Waiting for right timing', color: '#8b5cf6' },
    { value: 'passed', label: 'Passed', description: 'Decided not to invest', color: '#78716c' }
  ];

  const handleSubmit = async () => {
    if (!form.companyName || isSubmitting) return;
    if (form.companyStatus === 'invested' && !form.investmentAmount) return;
    
    setIsSubmitting(true);
    
    const now = new Date().toISOString();
    const newDeal = {
      companyName: form.companyName,
      logoUrl: null,
      status: form.companyStatus,
      engagement: form.engagement,
      industry: form.industry || 'Other',
      stage: form.stage,
      source: { type: 'manual', name: form.source || 'Manual Entry' },
      statusEnteredAt: now,
      lastActivity: now,
      founders: form.founderName ? [{ name: form.founderName, role: form.founderRole, email: form.founderEmail || undefined }] : [],
      attachments: [],
      notes: [],
      workingNotes: [],
    };

    if (form.companyStatus === 'invested') {
      newDeal.investment = { amount: Number(form.investmentAmount), vehicle: form.vehicle, date: form.investmentDate || now };
    } else if (form.companyStatus === 'deferred') {
      newDeal.deferData = { reason: form.deferReason || 'Timing', type: 'watching' };
    } else if (form.companyStatus === 'passed') {
      newDeal.passed = { reasons: [form.passReason || 'Not a fit'], whyPass: form.passReason };
    }
    
    try {
      await onAdd(newDeal);
      onClose();
    } catch (err) {
      console.error('Failed to add deal:', err);
      setIsSubmitting(false);
    }
  };

  const currentStatus = statusOptions.find(s => s.value === form.companyStatus);

  return (
    <div className="fixed inset-0 bg-black/50 backdrop-blur-sm z-50 flex items-center justify-center p-4">
      <div className="bg-white dark:bg-stone-800 rounded-2xl w-full max-w-lg max-h-[85vh] overflow-y-auto shadow-xl">
        <div className="sticky top-0 bg-white dark:bg-stone-800 px-4 py-3 border-b border-stone-200 dark:border-stone-700 flex items-center justify-between">
          <h2 className="font-semibold text-stone-900 dark:text-stone-100">Add Company</h2>
          <button onClick={onClose} className="p-1 text-stone-400 hover:text-stone-600">{Icons.x}</button>
        </div>
        
        <div className="p-4 space-y-4">
          {/* Status Selection */}
          <div>
            <label className="text-xs font-medium text-stone-600 dark:text-stone-400 uppercase tracking-wide">Status *</label>
            <div className="relative mt-2">
              <select value={form.companyStatus} onChange={e => setForm({...form, companyStatus: e.target.value})}
                className="w-full p-3 pr-10 border rounded-xl text-sm text-stone-900 dark:text-stone-100 bg-white dark:bg-stone-900 appearance-none cursor-pointer"
                style={{ borderColor: currentStatus?.color || '#e7e5e4' }}>
                {statusOptions.map(status => (<option key={status.value} value={status.value}>{status.label} — {status.description}</option>))}
              </select>
              <div className="absolute right-3 top-1/2 -translate-y-1/2 pointer-events-none text-stone-400">{Icons.chevronDown}</div>
            </div>
          </div>

          {/* Engagement Toggle */}
          <div className="flex items-center justify-between py-2">
            <div>
              <p className="text-sm font-medium text-stone-700 dark:text-stone-300">Engagement Status</p>
              <p className="text-xs text-stone-500">Is this actively being worked on?</p>
            </div>
            <button onClick={() => setForm({...form, engagement: form.engagement === 'active' ? 'inactive' : 'active'})}
              className={`px-3 py-1.5 rounded-lg text-sm font-medium transition-all ${form.engagement === 'active' ? 'bg-emerald-100 text-emerald-700' : 'bg-stone-200 text-stone-500'}`}>
              {form.engagement === 'active' ? 'Active' : 'Inactive'}
            </button>
          </div>

          {/* Company Details */}
          <div className="border-t border-stone-200 dark:border-stone-700 pt-4">
            <p className="text-xs font-medium text-stone-600 dark:text-stone-400 uppercase tracking-wide mb-3">Company Details</p>
            <div className="space-y-3">
              <div>
                <label className="text-xs text-stone-500">Company Name *</label>
                <input type="text" value={form.companyName} onChange={e => setForm({...form, companyName: e.target.value})} placeholder="Acme Inc"
                  className="w-full mt-1 p-3 border border-stone-200 dark:border-stone-700 rounded-xl text-sm text-stone-900 dark:text-stone-100 bg-white dark:bg-stone-900 placeholder-stone-400" />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="text-xs text-stone-500">Industry</label>
                  <input type="text" value={form.industry} onChange={e => setForm({...form, industry: e.target.value})} placeholder="SaaS, Fintech..."
                    className="w-full mt-1 p-3 border border-stone-200 dark:border-stone-700 rounded-xl text-sm text-stone-900 dark:text-stone-100 bg-white dark:bg-stone-900 placeholder-stone-400" />
                </div>
                <div className="relative">
                  <label className="text-xs text-stone-500">Stage</label>
                  <select value={form.stage} onChange={e => setForm({...form, stage: e.target.value})}
                    className="w-full mt-1 p-3 pr-10 border border-stone-200 dark:border-stone-700 rounded-xl text-sm text-stone-900 dark:text-stone-100 bg-white dark:bg-stone-900 appearance-none cursor-pointer">
                    <option value="pre-seed">Pre-seed</option>
                    <option value="seed">Seed</option>
                    <option value="series-a">Series A</option>
                    <option value="series-b">Series B</option>
                    <option value="growth">Growth</option>
                  </select>
                  <div className="absolute right-3 top-[34px] pointer-events-none text-stone-400">{Icons.chevronDown}</div>
                </div>
              </div>
              <div>
                <label className="text-xs text-stone-500">Source</label>
                <input type="text" value={form.source} onChange={e => setForm({...form, source: e.target.value})} placeholder="How did you find this company?"
                  className="w-full mt-1 p-3 border border-stone-200 dark:border-stone-700 rounded-xl text-sm text-stone-900 dark:text-stone-100 bg-white dark:bg-stone-900 placeholder-stone-400" />
              </div>
            </div>
          </div>

          {/* Investment Fields */}
          {form.companyStatus === 'invested' && (
            <div className="border-t border-stone-200 dark:border-stone-700 pt-4">
              <p className="text-xs font-medium text-stone-600 dark:text-stone-400 uppercase tracking-wide mb-3">Investment Details</p>
              <div className="space-y-3">
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="text-xs text-stone-500">Amount ($) *</label>
                    <input type="number" value={form.investmentAmount} onChange={e => setForm({...form, investmentAmount: e.target.value})} placeholder="25000"
                      className="w-full mt-1 p-3 border border-stone-200 dark:border-stone-700 rounded-xl text-sm text-stone-900 dark:text-stone-100 bg-white dark:bg-stone-900 placeholder-stone-400" />
                  </div>
                  <div className="relative">
                    <label className="text-xs text-stone-500">Vehicle</label>
                    <select value={form.vehicle} onChange={e => setForm({...form, vehicle: e.target.value})}
                      className="w-full mt-1 p-3 pr-10 border border-stone-200 dark:border-stone-700 rounded-xl text-sm text-stone-900 dark:text-stone-100 bg-white dark:bg-stone-900 appearance-none cursor-pointer">
                      <option value="SAFE">SAFE</option>
                      <option value="Convertible Note">Convertible Note</option>
                      <option value="Equity">Priced Equity</option>
                    </select>
                    <div className="absolute right-3 top-[34px] pointer-events-none text-stone-400">{Icons.chevronDown}</div>
                  </div>
                </div>
                <div>
                  <label className="text-xs text-stone-500">Investment Date</label>
                  <input type="date" value={form.investmentDate} onChange={e => setForm({...form, investmentDate: e.target.value})}
                    className="w-full mt-1 p-3 border border-stone-200 dark:border-stone-700 rounded-xl text-sm text-stone-900 dark:text-stone-100 bg-white dark:bg-stone-900" />
                </div>
              </div>
            </div>
          )}

          {/* Defer Fields */}
          {form.companyStatus === 'deferred' && (
            <div className="border-t border-stone-200 dark:border-stone-700 pt-4">
              <p className="text-xs font-medium text-stone-600 dark:text-stone-400 uppercase tracking-wide mb-3">Why Deferred?</p>
              <textarea value={form.deferReason} onChange={e => setForm({...form, deferReason: e.target.value})} placeholder="Timing not right, waiting for product-market fit, etc."
                className="w-full p-3 border border-stone-200 dark:border-stone-700 rounded-xl text-sm text-stone-900 dark:text-stone-100 bg-white dark:bg-stone-900 placeholder-stone-400 resize-none" rows={2} />
            </div>
          )}

          {/* Pass Fields */}
          {form.companyStatus === 'passed' && (
            <div className="border-t border-stone-200 dark:border-stone-700 pt-4">
              <p className="text-xs font-medium text-stone-600 dark:text-stone-400 uppercase tracking-wide mb-3">Why Passed?</p>
              <textarea value={form.passReason} onChange={e => setForm({...form, passReason: e.target.value})} placeholder="Market too small, team concerns, valuation, etc."
                className="w-full p-3 border border-stone-200 dark:border-stone-700 rounded-xl text-sm text-stone-900 dark:text-stone-100 bg-white dark:bg-stone-900 placeholder-stone-400 resize-none" rows={2} />
            </div>
          )}

          {/* Founder Section */}
          <div className="border-t border-stone-200 dark:border-stone-700 pt-4">
            <p className="text-xs font-medium text-stone-600 dark:text-stone-400 uppercase tracking-wide mb-3">Founder (optional)</p>
            <div className="space-y-2">
              <div className="grid grid-cols-2 gap-3">
                <input type="text" value={form.founderName} onChange={e => setForm({...form, founderName: e.target.value})} placeholder="Name"
                  className="p-3 border border-stone-200 dark:border-stone-700 rounded-xl text-sm text-stone-900 dark:text-stone-100 bg-white dark:bg-stone-900 placeholder-stone-400" />
                <input type="text" value={form.founderRole} onChange={e => setForm({...form, founderRole: e.target.value})} placeholder="Role"
                  className="p-3 border border-stone-200 dark:border-stone-700 rounded-xl text-sm text-stone-900 dark:text-stone-100 bg-white dark:bg-stone-900 placeholder-stone-400" />
              </div>
              <input type="email" value={form.founderEmail} onChange={e => setForm({...form, founderEmail: e.target.value})} placeholder="Email"
                className="w-full p-3 border border-stone-200 dark:border-stone-700 rounded-xl text-sm text-stone-900 dark:text-stone-100 bg-white dark:bg-stone-900 placeholder-stone-400" />
            </div>
          </div>
        </div>
        
        <div className="sticky bottom-0 bg-white dark:bg-stone-800 px-4 py-3 border-t border-stone-200 dark:border-stone-700">
          <button onClick={handleSubmit} disabled={!form.companyName || (form.companyStatus === 'invested' && !form.investmentAmount) || isSubmitting}
            style={{ backgroundColor: currentStatus?.color || '#5B6DC4' }}
            className="w-full py-3 text-white rounded-xl text-sm font-medium disabled:opacity-50 disabled:cursor-not-allowed transition-all hover:opacity-90 flex items-center justify-center gap-2">
            {isSubmitting ? <div className="w-5 h-5 border-2 border-white/30 border-t-white rounded-full animate-spin" /> : null}
            {isSubmitting ? 'Adding...' : `Add ${currentStatus?.label || 'Company'}`}
          </button>
        </div>
      </div>
    </div>
  );
};

// ============================================================================
// SETTINGS PAGE
// ============================================================================

const SettingsPage = ({ onClose }) => {
  const { profile, signOut } = useAuth();
  const [activeSection, setActiveSection] = useState('profile');

  const sections = [
    { id: 'profile', label: 'Profile', icon: Icons.user },
    { id: 'appearance', label: 'Appearance', icon: Icons.eye },
    { id: 'data', label: 'Data & Privacy', icon: Icons.shield },
  ];

  return (
    <div className="min-h-screen bg-stone-50 dark:bg-stone-900">
      <header className="sticky top-0 z-30 bg-stone-50/90 dark:bg-stone-900/90 backdrop-blur-lg border-b border-stone-200 dark:border-stone-700 px-4 pt-4 pb-3">
        <div className="flex items-center justify-between">
          <button onClick={onClose} className="flex items-center gap-1 text-stone-500 dark:text-stone-400">{Icons.chevronLeft}<span className="text-sm">Back</span></button>
        </div>
        <h1 className="text-xl font-bold mt-3 text-stone-900 dark:text-white">Settings</h1>
      </header>

      <div className="flex">
        <nav className="w-48 p-4 min-h-[calc(100vh-80px)] border-r border-stone-200 dark:border-stone-700">
          {sections.map(s => (
            <button key={s.id} onClick={() => setActiveSection(s.id)}
              className={`w-full flex items-center gap-2 px-3 py-2 rounded-lg text-sm mb-1 transition-colors ${activeSection === s.id ? 'bg-stone-200 dark:bg-stone-700 text-stone-900 dark:text-white' : 'text-stone-500 dark:text-stone-400 hover:bg-stone-100 dark:hover:bg-stone-800'}`}>
              {s.icon}{s.label}
            </button>
          ))}
        </nav>

        <main className="flex-1 p-6 max-w-xl">
          {activeSection === 'profile' && (
            <div className="space-y-4">
              <h2 className="text-lg font-semibold text-stone-900 dark:text-white mb-4">Profile</h2>
              <div className="bg-white dark:bg-stone-800 rounded-xl p-4 border border-stone-200 dark:border-stone-700">
                <p className="text-sm text-stone-500 dark:text-stone-400">Name</p>
                <p className="font-medium text-stone-900 dark:text-white">{profile?.full_name || 'Not set'}</p>
              </div>
              <button onClick={signOut} className="w-full mt-6 p-3 bg-red-50 dark:bg-red-900/20 text-red-600 dark:text-red-400 rounded-xl text-sm font-medium flex items-center justify-center gap-2">
                {Icons.logOut} Sign Out
              </button>
            </div>
          )}
          {activeSection === 'appearance' && (
            <div><h2 className="text-lg font-semibold text-stone-900 dark:text-white mb-4">Appearance</h2><p className="text-stone-500">Theme settings coming soon.</p></div>
          )}
          {activeSection === 'data' && (
            <div><h2 className="text-lg font-semibold text-stone-900 dark:text-white mb-4">Data & Privacy</h2><p className="text-stone-500">Export and privacy options coming soon.</p></div>
          )}
        </main>
      </div>
    </div>
  );
};

// ============================================================================
// DASHBOARD PAGE
// ============================================================================

const DashboardPage = ({ deals, onClose }) => {
  const [viewBy, setViewBy] = useState('industry');
  const portfolioDeals = deals.filter(d => d.status === 'invested');
  
  const totalCapital = portfolioDeals.reduce((sum, deal) => {
    const amount = deal.investment?.amount || 0;
    return sum + (typeof amount === 'string' ? parseFloat(amount) || 0 : amount);
  }, 0);
  
  const avgCheckSize = portfolioDeals.length > 0 ? totalCapital / portfolioDeals.length : 0;
  
  const industryColors = { 'AI/ML': '#8B5CF6', 'Fintech': '#10B981', 'HealthTech': '#F59E0B', 'DevTools': '#3B82F6', 'Security': '#EF4444', 'Analytics': '#EC4899', 'SaaS': '#06B6D4', 'Other': '#78716C' };
  
  const breakdown = portfolioDeals.reduce((acc, deal) => {
    const key = deal.industry || 'Other';
    if (!acc[key]) acc[key] = { count: 0, amount: 0 };
    acc[key].count += 1;
    acc[key].amount += deal.investment?.amount || 0;
    return acc;
  }, {});

  return (
    <div className="min-h-screen bg-stone-50 dark:bg-stone-900">
      <header className="sticky top-0 z-30 bg-stone-50/90 dark:bg-stone-900/90 backdrop-blur-lg border-b border-stone-200 dark:border-stone-700">
        <div className="flex items-center justify-between px-6 py-4">
          <button onClick={onClose} className="flex items-center gap-1 text-stone-500 dark:text-stone-400">{Icons.chevronLeft}<span className="text-sm">Back</span></button>
          <h1 className="text-lg font-semibold text-stone-900 dark:text-stone-100">Capital & Signals</h1>
          <div className="w-12"/>
        </div>
      </header>

      <div className="p-6 space-y-6 max-w-2xl mx-auto">
        <div className="bg-white dark:bg-stone-800 rounded-2xl p-6 border border-stone-200 dark:border-stone-700">
          <div className="text-center mb-6">
            <p className="text-xs text-stone-400 uppercase tracking-wide mb-1">Capital Deployed</p>
            <p className="text-4xl font-bold text-stone-900 dark:text-white">{formatCurrency(totalCapital)}</p>
            <p className="text-sm text-stone-500 mt-1">{portfolioDeals.length} investments · avg {formatCurrency(avgCheckSize)}</p>
          </div>
          
          <div className="flex items-center justify-center gap-1 mb-5 p-1 bg-stone-100 dark:bg-stone-700 rounded-lg">
            {['industry', 'stage', 'source'].map(v => (
              <button key={v} onClick={() => setViewBy(v)}
                className={`px-3 py-1.5 rounded-md text-xs font-medium transition-colors ${viewBy === v ? 'bg-white dark:bg-stone-600 text-stone-900 dark:text-white shadow-sm' : 'text-stone-500 dark:text-stone-400'}`}>
                {v.charAt(0).toUpperCase() + v.slice(1)}
              </button>
            ))}
          </div>
          
          {Object.keys(breakdown).length === 0 ? (
            <p className="text-sm text-stone-400 text-center py-8">No investments yet</p>
          ) : (
            <div className="space-y-3">
              {Object.entries(breakdown).sort((a, b) => b[1].amount - a[1].amount).map(([key, data]) => {
                const pct = totalCapital > 0 ? Math.round((data.amount / totalCapital) * 100) : 0;
                const color = industryColors[key] || '#78716C';
                return (
                  <div key={key}>
                    <div className="flex items-center justify-between mb-1">
                      <div className="flex items-center gap-2">
                        <span className="w-2.5 h-2.5 rounded-full" style={{ backgroundColor: color }}/>
                        <span className="text-sm text-stone-700 dark:text-stone-300">{key}</span>
                        <span className="text-xs text-stone-400">({data.count})</span>
                      </div>
                      <span className="text-sm font-medium text-stone-900 dark:text-white">{pct}%</span>
                    </div>
                    <div className="relative w-full h-2 bg-stone-100 dark:bg-stone-700 rounded-full overflow-hidden">
                      <div className="h-full rounded-full transition-all duration-500" style={{ width: `${pct}%`, backgroundColor: color }}/>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
        <p className="text-center text-xs text-stone-400 py-2">Context, not advice · Continuity, not judgment</p>
      </div>
    </div>
  );
};

// ============================================================================
// DEAL DETAIL VIEW
// ============================================================================

const DealDetailView = ({ deal, onUpdate, onBack, setToast }) => {
  const config = STATUS_CONFIG[deal.status];
  
  const transitionStatus = async (newStatus, extras = {}) => {
    const now = new Date().toISOString();
    await onUpdate({ ...deal, status: newStatus, statusEnteredAt: now, lastActivity: now, ...extras });
    setToast({ message: `Moved to ${STATUS_CONFIG[newStatus].label}`, type: 'success' });
  };
  
  const toggleEngagement = async () => {
    await onUpdate({ ...deal, engagement: deal.engagement === 'active' ? 'inactive' : 'active', lastActivity: new Date().toISOString() });
  };

  return (
    <div className="min-h-screen bg-stone-100 dark:bg-stone-900">
      <header className="sticky top-0 z-30 bg-white dark:bg-stone-800 border-b border-stone-200 dark:border-stone-700">
        <div className="flex items-center justify-between px-6 py-4">
          <button onClick={onBack} className="flex items-center gap-1 text-stone-500 dark:text-stone-400 hover:text-stone-700 dark:hover:text-stone-200 transition-colors">
            {Icons.chevronLeft}<span className="text-sm font-medium">Pipeline</span>
          </button>
          <div className="flex items-center gap-2">
            <button onClick={toggleEngagement}
              className={`px-3 py-1 rounded-lg text-sm font-medium transition-all ${deal.engagement === 'active' ? 'bg-emerald-100 dark:bg-emerald-900/30 text-emerald-700 dark:text-emerald-400' : 'bg-stone-200 dark:bg-stone-700 text-stone-500 dark:text-stone-400'}`}>
              {deal.engagement === 'active' ? 'Active' : 'Inactive'}
            </button>
            <span className={`px-3 py-1 rounded-lg text-sm font-medium ${config.light}`}>{config.label}</span>
          </div>
        </div>
      </header>
      
      <main className="px-6 py-6 space-y-6">
        {/* Company Header */}
        <div className="bg-white dark:bg-stone-800 rounded-2xl p-5">
          <div className="flex items-start gap-4">
            <div className="w-14 h-14 rounded-xl bg-[#5B6DC4] flex items-center justify-center flex-shrink-0">
              <span className="text-xl font-bold text-white">{deal.companyName?.charAt(0)?.toUpperCase()}</span>
            </div>
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2 mb-1">
                <h2 className="text-xl font-bold text-stone-900 dark:text-white">{deal.companyName}</h2>
                {deal.website && <a href={deal.website} target="_blank" rel="noopener noreferrer" className="text-stone-400 hover:text-stone-600">{Icons.externalLink}</a>}
              </div>
              <p className="text-sm text-stone-500 dark:text-stone-400">{deal.stage} · {deal.industry}</p>
              {deal.source?.name && <p className="text-sm text-stone-400 mt-1">via {deal.source.name}</p>}
            </div>
          </div>
          
          {deal.founders && deal.founders.length > 0 && (
            <div className="flex items-center gap-2 mt-4 pt-4 border-t border-stone-100 dark:border-stone-700">
              <span className="text-sm text-stone-500">Founders:</span>
              <div className="flex items-center gap-3">
                {deal.founders.map((founder, idx) => (
                  <div key={idx} className="flex items-center gap-1.5">
                    <div className="w-6 h-6 rounded-full bg-stone-200 dark:bg-stone-700 flex items-center justify-center text-xs font-medium text-stone-600 dark:text-stone-300">
                      {founder.name?.split(' ').map(n => n[0]).join('').slice(0, 2).toUpperCase()}
                    </div>
                    <span className="text-sm text-stone-700 dark:text-stone-300">{founder.name}</span>
                    <span className="text-xs text-stone-400">({founder.role})</span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>

        {/* Status-specific content */}
        {deal.status === 'screening' && (
          <div className="bg-white dark:bg-stone-800 rounded-2xl p-5">
            <h3 className="font-semibold text-stone-900 dark:text-white mb-4">Quick Actions</h3>
            <div className="flex flex-wrap gap-3">
              <button onClick={() => transitionStatus('invested', { investment: { amount: 0, date: new Date().toISOString() } })}
                className="px-4 py-2 bg-emerald-600 text-white rounded-xl text-sm font-medium hover:bg-emerald-700">Invest</button>
              <button onClick={() => transitionStatus('deferred', { deferData: { reason: 'Timing', type: 'watching' } })}
                className="px-4 py-2 bg-[#5B6DC4] text-white rounded-xl text-sm font-medium hover:bg-[#4F5FB3]">Defer</button>
              <button onClick={() => transitionStatus('passed', { passed: { reasons: ['Not a fit'] } })}
                className="px-4 py-2 bg-stone-500 text-white rounded-xl text-sm font-medium hover:bg-stone-600">Pass</button>
            </div>
          </div>
        )}

        {deal.status === 'invested' && deal.investment && (
          <div className="bg-emerald-50 dark:bg-emerald-900/20 rounded-2xl p-5 border border-emerald-200 dark:border-emerald-800">
            <h3 className="font-semibold text-emerald-800 dark:text-emerald-300 mb-2">Investment Details</h3>
            <p className="text-2xl font-bold text-emerald-700 dark:text-emerald-400">{formatCurrency(deal.investment.amount)}</p>
            <p className="text-sm text-emerald-600 dark:text-emerald-500">{deal.investment.vehicle} · {deal.investment.date ? formatDate(deal.investment.date) : 'Date not set'}</p>
          </div>
        )}

        {deal.status === 'deferred' && (
          <div className="bg-white dark:bg-stone-800 rounded-2xl p-5">
            <h3 className="font-semibold text-stone-900 dark:text-white mb-2">Deferred Reason</h3>
            <p className="text-stone-600 dark:text-stone-400">{deal.deferData?.reason || 'No reason specified'}</p>
            <button onClick={() => transitionStatus('screening')}
              className="mt-4 px-4 py-2 bg-[#5B6DC4] text-white rounded-xl text-sm font-medium hover:bg-[#4F5FB3]">Reopen in Screening</button>
          </div>
        )}

        {deal.status === 'passed' && (
          <div className="bg-white dark:bg-stone-800 rounded-2xl p-5">
            <h3 className="font-semibold text-stone-900 dark:text-white mb-2">Pass Reasons</h3>
            <div className="flex flex-wrap gap-2 mb-4">
              {(deal.passed?.reasons || []).map((r, i) => (
                <span key={i} className="px-3 py-1 bg-stone-100 dark:bg-stone-700 text-stone-600 dark:text-stone-300 rounded-full text-sm">{r}</span>
              ))}
            </div>
            <button onClick={() => transitionStatus('screening')}
              className="px-4 py-2 border border-stone-300 dark:border-stone-600 text-stone-600 dark:text-stone-300 rounded-xl text-sm font-medium hover:bg-stone-50 dark:hover:bg-stone-700">Reactivate</button>
          </div>
        )}

        {/* Timestamps */}
        <div className="bg-white dark:bg-stone-800 rounded-2xl p-5">
          <h3 className="font-semibold text-stone-900 dark:text-white mb-3">Timeline</h3>
          <div className="space-y-2 text-sm">
            <div className="flex justify-between"><span className="text-stone-500">Added</span><span className="text-stone-700 dark:text-stone-300">{deal.createdAt ? formatDate(deal.createdAt) : 'Unknown'}</span></div>
            <div className="flex justify-between"><span className="text-stone-500">Status changed</span><span className="text-stone-700 dark:text-stone-300">{deal.statusEnteredAt ? `${daysAgo(deal.statusEnteredAt)}d ago` : 'Unknown'}</span></div>
            <div className="flex justify-between"><span className="text-stone-500">Last activity</span><span className="text-stone-700 dark:text-stone-300">{deal.lastActivity ? `${daysAgo(deal.lastActivity)}d ago` : 'Unknown'}</span></div>
          </div>
        </div>
      </main>
    </div>
  );
};

// ============================================================================
// MAIN APP COMPONENT
// ============================================================================

const MainApp = () => {
  const { hasCompletedOnboarding, completeOnboarding } = useAuth();
  const { deals, createDeal, updateDeal, isLoading: dealsLoading, isSaving } = useDeals();
  
  const [page, setPage] = useState('list');
  const [activeTab, setActiveTab] = useState('active');
  const [selected, setSelected] = useState(null);
  const [toast, setToast] = useState(null);
  const [search, setSearch] = useState('');
  const [showAddModal, setShowAddModal] = useState(false);

  // Show onboarding if not completed
  if (!hasCompletedOnboarding) {
    return <OnboardingFlow onComplete={(prefs) => completeOnboarding(prefs)} onSkip={() => completeOnboarding(null)} />;
  }

  // Computed deal lists
  const activeDeals = deals.filter(d => d.status === 'screening');
  const deferredDeals = deals.filter(d => d.status === 'deferred');
  const portfolioDeals = deals.filter(d => d.status === 'invested');

  const tabCounts = { active: activeDeals.length, deferred: deferredDeals.length, portfolio: portfolioDeals.length };

  // Get filtered deals
  const getFilteredDeals = () => {
    let base = activeTab === 'active' ? activeDeals : activeTab === 'deferred' ? deferredDeals : portfolioDeals;
    if (search) base = base.filter(d => d.companyName?.toLowerCase().includes(search.toLowerCase()));
    return base.sort((a, b) => new Date(b.statusEnteredAt || b.createdAt) - new Date(a.statusEnteredAt || a.createdAt));
  };

  const filtered = getFilteredDeals();

  // Handle add deal
  const handleAddDeal = async (dealData) => {
    const result = await createDeal(dealData);
    if (result.data) {
      setToast({ message: `${dealData.companyName} added`, type: 'success' });
    } else if (result.error) {
      setToast({ message: 'Failed to add company', type: 'error' });
    }
  };

  // Handle update deal
  const handleUpdateDeal = async (updatedDeal) => {
    const result = await updateDeal(updatedDeal.id, updatedDeal);
    if (result.data) setSelected(result.data);
  };

  // Settings page
  if (page === 'settings') return <SettingsPage onClose={() => setPage('list')} />;

  // Dashboard page
  if (page === 'dashboard') return <DashboardPage deals={deals} onClose={() => setPage('list')} />;

  // Detail page
  if (page === 'detail' && selected) {
    return <DealDetailView deal={selected} onUpdate={handleUpdateDeal} onBack={() => { setSelected(null); setPage('list'); }} setToast={setToast} />;
  }

  // Empty state message
  const emptyState = activeTab === 'active' ? { title: 'No leads yet', subtitle: 'Add a new company to start evaluating opportunities.' }
    : activeTab === 'deferred' ? { title: 'No deferred deals', subtitle: 'Deals you defer will appear here.' }
    : { title: 'No investments yet', subtitle: 'Companies you invest in will appear here.' };

  // List view
  return (
    <div className="min-h-screen bg-stone-100 dark:bg-stone-900">
      {/* Header */}
      <header className="bg-white dark:bg-stone-800 border-b border-stone-200 dark:border-stone-700">
        <div className="flex items-center justify-between px-6 py-4">
          <div className="flex items-center gap-3">
            <div className="flex items-center gap-2">
              <div className="w-8 h-8 rounded-lg flex items-center justify-center text-white" style={{ backgroundColor: '#5B6DC4' }}>{Icons.layers}</div>
              <span className="font-semibold text-stone-900 dark:text-stone-100">AngelFlow</span>
            </div>
            {isSaving && <span className="text-xs text-stone-400 flex items-center gap-1"><div className="w-3 h-3 border-2 border-stone-300 border-t-stone-600 rounded-full animate-spin" />Saving...</span>}
          </div>
          <div className="flex items-center gap-3">
            <button onClick={() => setPage('dashboard')} className="p-2 text-stone-400 hover:text-stone-600 dark:hover:text-stone-300 transition-colors" title="Capital & Signals">{Icons.grid}</button>
            <button onClick={() => setPage('settings')} className="p-2 text-stone-400 hover:text-stone-600 dark:hover:text-stone-300 transition-colors" title="Settings">{Icons.settings}</button>
            <button onClick={() => setShowAddModal(true)} style={{ backgroundColor: '#5B6DC4' }}
              className="px-4 py-2 text-white text-sm font-medium rounded-xl hover:opacity-90 transition-colors flex items-center gap-1.5">{Icons.plus} Add Company</button>
            <UserMenu />
          </div>
        </div>

        {/* Tab Navigation */}
        <div className="px-6 pb-4">
          <div className="flex gap-1">
            {[
              { key: 'active', label: 'Leads', icon: Icons.clock },
              { key: 'deferred', label: 'Deferred', icon: Icons.eye },
              { key: 'portfolio', label: 'Portfolio', icon: Icons.activity }
            ].map(tab => (
              <button key={tab.key} onClick={() => setActiveTab(tab.key)}
                className={`flex items-center gap-2 px-4 py-2.5 rounded-xl text-sm font-medium transition-all ${activeTab === tab.key ? 'bg-stone-100 dark:bg-stone-700 border border-stone-200 dark:border-stone-600 text-stone-900 dark:text-white' : 'hover:bg-stone-50 dark:hover:bg-stone-700/50 text-stone-500'}`}>
                {tab.icon}{tab.label}
                <span className={`px-1.5 py-0.5 rounded text-xs font-medium ${activeTab === tab.key ? 'bg-[#5B6DC4] text-white' : 'bg-stone-200 dark:bg-stone-700 text-stone-500'}`}>{tabCounts[tab.key]}</span>
              </button>
            ))}
          </div>
        </div>
      </header>

      {/* Content */}
      <div className="px-6 py-6">
        {/* Search */}
        <div className="mb-5">
          <div className="flex items-center gap-3 bg-white dark:bg-stone-800 rounded-2xl p-2 border border-stone-200 dark:border-stone-700">
            <div className="flex-1 relative">
              <div className="absolute left-3 top-1/2 -translate-y-1/2 text-stone-400">{Icons.search}</div>
              <input type="search" placeholder="Search companies..." value={search} onChange={e => setSearch(e.target.value)}
                className="w-full bg-transparent py-2 pl-10 pr-4 text-sm text-stone-900 dark:text-stone-100 placeholder-stone-400 focus:outline-none" />
            </div>
          </div>
        </div>

        {/* Loading state */}
        {dealsLoading ? (
          <div className="text-center py-16">
            <div className="w-8 h-8 border-4 border-[#5B6DC4] border-t-transparent rounded-full animate-spin mx-auto mb-4"/>
            <p className="text-stone-500">Loading deals...</p>
          </div>
        ) : filtered.length === 0 ? (
          <div className="text-center py-16">
            <p className="text-stone-500 dark:text-stone-400 font-medium mb-1">{emptyState.title}</p>
            <p className="text-sm text-stone-400 dark:text-stone-500 mb-4">{emptyState.subtitle}</p>
            <button onClick={() => setShowAddModal(true)} className="px-4 py-2 bg-[#5B6DC4] text-white rounded-xl text-sm font-medium hover:opacity-90">Add Your First Company</button>
          </div>
        ) : (
          <div className="space-y-3">
            {filtered.map(deal => {
              const badge = deal.status === 'screening' ? { bg: 'rgba(91, 109, 196, 0.1)', color: '#5B6DC4', label: 'Screening' }
                : deal.status === 'invested' ? { bg: 'rgba(16, 185, 129, 0.1)', color: '#059669', label: 'Invested' }
                : deal.status === 'deferred' ? { bg: 'rgba(91, 109, 196, 0.1)', color: '#5B6DC4', label: 'Watching' }
                : { bg: '#f5f5f4', color: '#78716c', label: deal.status };

              return (
                <div key={deal.id} onClick={() => { setSelected(deal); setPage('detail'); }}
                  className="bg-white dark:bg-stone-800 rounded-2xl p-5 border border-stone-200 dark:border-stone-700 hover:border-stone-300 dark:hover:border-stone-600 cursor-pointer transition-all hover:shadow-sm flex items-center">
                  <div className="w-12 h-12 rounded-xl bg-stone-200 dark:bg-stone-700 flex items-center justify-center mr-4 flex-shrink-0">
                    <span className="text-lg font-semibold text-stone-500 dark:text-stone-400">{deal.companyName?.charAt(0)?.toUpperCase()}</span>
                  </div>
                  <div className="flex-1 min-w-0">
                    <h3 className="font-semibold text-stone-900 dark:text-stone-100 mb-0.5">{deal.companyName}</h3>
                    <p className="text-sm text-stone-500 dark:text-stone-400">{deal.industry || 'No industry'} · {deal.stage || 'No stage'}</p>
                    {deal.source?.name && <p className="text-sm text-stone-400 dark:text-stone-500">{deal.source.name}</p>}
                  </div>
                  <div className="flex flex-col items-end gap-1.5 ml-4">
                    <span className="px-2.5 py-1 rounded-lg text-xs font-medium" style={{ backgroundColor: badge.bg, color: badge.color }}>{badge.label}</span>
                    {deal.statusEnteredAt && <span className="text-xs text-stone-400">{daysAgo(deal.statusEnteredAt)}d ago</span>}
                  </div>
                  <div className="ml-3 flex-shrink-0 text-stone-300">{Icons.chevronRight}</div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Modals */}
      {showAddModal && <AddCompanyModal onClose={() => setShowAddModal(false)} onAdd={handleAddDeal} />}
      {toast && <Toast message={toast.message} type={toast.type} onClose={() => setToast(null)} />}
    </div>
  );
};

// ============================================================================
// ROOT APP WITH AUTH
// ============================================================================

const AppContent = () => {
  const { isAuthenticated, isLoading } = useAuth();
  
  if (isLoading) {
    return (
      <div className="min-h-screen bg-stone-50 dark:bg-stone-900 flex items-center justify-center">
        <div className="text-center">
          <div className="w-12 h-12 border-4 border-[#5B6DC4] border-t-transparent rounded-full animate-spin mx-auto mb-4"/>
          <p className="text-stone-500 dark:text-stone-400">Loading AngelFlow...</p>
        </div>
      </div>
    );
  }
  
  if (!isAuthenticated) return <LoginPage />;
  
  return <MainApp />;
};

const App = () => {
  return (
    <AuthProvider>
      <AppContent />
    </AuthProvider>
  );
};

export default App;
