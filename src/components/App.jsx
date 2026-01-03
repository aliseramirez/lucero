import React, { useState, useEffect, createContext, useContext, useCallback, useRef } from 'react';

// ============================================================================
// CONFIGURATION
// ============================================================================

const CONFIG = {
  // OAuth providers - replace with your actual client IDs in production
  oauth: {
    google: {
      clientId: 'demo-google-client-id',
      redirectUri: `${window.location.origin}/auth/callback/google`,
      scope: 'openid email profile'
    },
    angellist: {
      clientId: 'demo-angellist-client-id',
      redirectUri: `${window.location.origin}/auth/callback/angellist`,
      scope: 'email'
    },
    carta: {
      clientId: 'demo-carta-client-id',
      redirectUri: `${window.location.origin}/auth/callback/carta`,
      scope: 'read:user read:portfolio'
    }
  },
  api: {
    baseUrl: '/api',
    timeout: 30000
  },
  telemetry: {
    enabled: false, // Disabled for demo
    sampleRate: 1.0,
    endpoint: '/api/telemetry'
  }
};

// ============================================================================
// TELEMETRY & OBSERVABILITY
// ============================================================================

const TelemetryContext = createContext(null);

class TelemetryService {
  constructor() {
    this.buffer = [];
    this.flushInterval = 10000; // 10 seconds
    this.maxBufferSize = 50;
    this.sessionId = this.generateSessionId();
    this.userId = null;
    
    // Start flush interval
    if (CONFIG.telemetry.enabled) {
      setInterval(() => this.flush(), this.flushInterval);
      window.addEventListener('beforeunload', () => this.flush());
      window.addEventListener('error', (e) => this.trackError(e.error, { source: 'window' }));
      window.addEventListener('unhandledrejection', (e) => this.trackError(e.reason, { source: 'promise' }));
    }
  }
  
  generateSessionId() {
    return `sess_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  }
  
  setUserId(userId) {
    this.userId = userId;
  }
  
  track(eventName, properties = {}) {
    if (!CONFIG.telemetry.enabled && Math.random() > CONFIG.telemetry.sampleRate) return;
    
    const event = {
      event: eventName,
      timestamp: new Date().toISOString(),
      sessionId: this.sessionId,
      userId: this.userId,
      properties: {
        ...properties,
        url: window.location.pathname,
        userAgent: navigator.userAgent,
        screenSize: `${window.innerWidth}x${window.innerHeight}`
      }
    };
    
    this.buffer.push(event);
    
    if (this.buffer.length >= this.maxBufferSize) {
      this.flush();
    }
    
    // Also log to console in development
    console.log(`[Telemetry] ${eventName}`, properties);
  }
  
  trackError(error, context = {}) {
    const errorData = {
      message: error?.message || String(error),
      stack: error?.stack,
      name: error?.name,
      ...context
    };
    
    this.track('error', errorData);
    
    // Always log errors to console
    console.error('[Telemetry Error]', errorData);
  }
  
  trackPageView(pageName) {
    this.track('page_view', { page: pageName });
  }
  
  trackUserAction(action, details = {}) {
    this.track('user_action', { action, ...details });
  }
  
  trackApiCall(method, endpoint, duration, status, error = null) {
    this.track('api_call', {
      method,
      endpoint,
      duration,
      status,
      error: error?.message
    });
  }
  
  async flush() {
    if (this.buffer.length === 0) return;
    
    const events = [...this.buffer];
    this.buffer = [];
    
    try {
      // In production, send to telemetry endpoint
      if (CONFIG.telemetry.enabled) {
        await fetch(CONFIG.telemetry.endpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ events }),
          keepalive: true
        });
      }
    } catch (e) {
      // Re-add failed events to buffer (with limit)
      this.buffer = [...events.slice(-25), ...this.buffer].slice(0, this.maxBufferSize);
      console.warn('[Telemetry] Failed to flush events', e);
    }
  }
}

const telemetry = new TelemetryService();

// ============================================================================
// BACKEND API SERVICE
// ============================================================================

class ApiService {
  constructor(telemetry) {
    this.telemetry = telemetry;
    this.authToken = null;
  }
  
  setAuthToken(token) {
    this.authToken = token;
  }
  
  async request(method, endpoint, data = null, options = {}) {
    const startTime = Date.now();
    const url = `${CONFIG.api.baseUrl}${endpoint}`;
    
    const headers = {
      'Content-Type': 'application/json',
      ...(this.authToken && { 'Authorization': `Bearer ${this.authToken}` }),
      ...options.headers
    };
    
    try {
      const response = await fetch(url, {
        method,
        headers,
        body: data ? JSON.stringify(data) : null,
        signal: AbortSignal.timeout(CONFIG.api.timeout)
      });
      
      const duration = Date.now() - startTime;
      this.telemetry.trackApiCall(method, endpoint, duration, response.status);
      
      if (!response.ok) {
        const error = await response.json().catch(() => ({ message: 'Request failed' }));
        throw new ApiError(error.message || 'Request failed', response.status, error);
      }
      
      return await response.json();
    } catch (error) {
      const duration = Date.now() - startTime;
      this.telemetry.trackApiCall(method, endpoint, duration, error.status || 0, error);
      throw error;
    }
  }
  
  // Auth endpoints
  async login(provider, code) {
    return this.request('POST', '/auth/login', { provider, code });
  }
  
  async logout() {
    return this.request('POST', '/auth/logout');
  }
  
  async getUser() {
    return this.request('GET', '/auth/user');
  }
  
  async refreshToken() {
    return this.request('POST', '/auth/refresh');
  }
  
  // User data endpoints (isolated per user)
  async getDeals() {
    return this.request('GET', '/deals');
  }
  
  async saveDeal(deal) {
    return this.request('POST', '/deals', deal);
  }
  
  async updateDeal(dealId, updates) {
    return this.request('PATCH', `/deals/${dealId}`, updates);
  }
  
  async deleteDeal(dealId) {
    return this.request('DELETE', `/deals/${dealId}`);
  }
  
  async syncDeals(deals) {
    return this.request('POST', '/deals/sync', { deals });
  }
  
  async getSettings() {
    return this.request('GET', '/settings');
  }
  
  async saveSettings(settings) {
    return this.request('PUT', '/settings', settings);
  }
}

class ApiError extends Error {
  constructor(message, status, data) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.data = data;
  }
}

const api = new ApiService(telemetry);

// ============================================================================
// AUTHENTICATION CONTEXT
// ============================================================================

const AuthContext = createContext(null);

const useAuth = () => {
  const context = useContext(AuthContext);
  // Return safe defaults if not in provider
  if (!context) {
    return {
      user: null,
      isLoading: false,
      error: null,
      isAuthenticated: false,
      loginWithProvider: () => {},
      handleOAuthCallback: () => {},
      logout: () => {}
    };
  }
  return context;
};

const AuthProvider = ({ children }) => {
  const [user, setUser] = useState(null);
  const [isLoading, setIsLoading] = useState(false); // Start as false for immediate render
  const [error, setError] = useState(null);
  const [authChecked, setAuthChecked] = useState(false);
  
  // Check for existing session on mount
  useEffect(() => {
    if (authChecked) return;
    
    const checkAuth = async () => {
      try {
        const token = localStorage.getItem('authToken');
        if (token) {
          api.setAuthToken(token);
          const storedUser = localStorage.getItem('user');
          if (storedUser) {
            const userData = JSON.parse(storedUser);
            setUser(userData);
            telemetry.setUserId(userData.id);
            telemetry.track('session_restored', { provider: userData.provider });
          }
        }
      } catch (e) {
        console.error('Failed to restore session', e);
        localStorage.removeItem('authToken');
        localStorage.removeItem('user');
      }
      setAuthChecked(true);
    };
    
    checkAuth();
  }, [authChecked]);
  
  const loginWithProvider = useCallback(async (provider) => {
    setError(null);
    telemetry.track('login_started', { provider });
    
    // Build OAuth URL based on provider
    let authUrl;
    const state = Math.random().toString(36).substr(2, 16);
    sessionStorage.setItem('oauth_state', state);
    
    switch (provider) {
      case 'google':
        authUrl = `https://accounts.google.com/o/oauth2/v2/auth?` +
          `client_id=${CONFIG.oauth.google.clientId}&` +
          `redirect_uri=${encodeURIComponent(CONFIG.oauth.google.redirectUri)}&` +
          `response_type=code&` +
          `scope=${encodeURIComponent(CONFIG.oauth.google.scope)}&` +
          `state=${state}&` +
          `prompt=consent`;
        break;
      case 'angellist':
        authUrl = `https://angel.co/api/oauth/authorize?` +
          `client_id=${CONFIG.oauth.angellist.clientId}&` +
          `redirect_uri=${encodeURIComponent(CONFIG.oauth.angellist.redirectUri)}&` +
          `response_type=code&` +
          `scope=${encodeURIComponent(CONFIG.oauth.angellist.scope)}&` +
          `state=${state}`;
        break;
      case 'carta':
        authUrl = `https://login.carta.com/oauth/authorize?` +
          `client_id=${CONFIG.oauth.carta.clientId}&` +
          `redirect_uri=${encodeURIComponent(CONFIG.oauth.carta.redirectUri)}&` +
          `response_type=code&` +
          `scope=${encodeURIComponent(CONFIG.oauth.carta.scope)}&` +
          `state=${state}`;
        break;
      default:
        throw new Error(`Unknown provider: ${provider}`);
    }
    
    // For demo purposes, simulate OAuth flow
    // In production, redirect to authUrl
    // Simulate successful OAuth
    await simulateOAuthLogin(provider);
  }, []);
  
  const simulateOAuthLogin = async (provider) => {
    setIsLoading(true); // Show loading state
    // Simulate network delay
    await new Promise(r => setTimeout(r, 1500));
    
    // Create mock user based on provider
    const mockUser = {
      id: `user_${Math.random().toString(36).substr(2, 9)}`,
      email: `demo@${provider}.example.com`,
      name: 'Demo User',
      avatar: `https://ui-avatars.com/api/?name=Demo+User&background=5B6DC4&color=fff`,
      provider,
      createdAt: new Date().toISOString()
    };
    
    // Mock token
    const mockToken = `mock_token_${Date.now()}`;
    
    // Save to localStorage
    localStorage.setItem('authToken', mockToken);
    localStorage.setItem('user', JSON.stringify(mockUser));
    
    api.setAuthToken(mockToken);
    setUser(mockUser);
    setIsLoading(false);
    telemetry.setUserId(mockUser.id);
    telemetry.track('login_success', { provider });
  };
  
  const handleOAuthCallback = useCallback(async (provider, code, state) => {
    setIsLoading(true);
    setError(null);
    
    try {
      // Verify state
      const savedState = sessionStorage.getItem('oauth_state');
      if (state !== savedState) {
        throw new Error('Invalid OAuth state');
      }
      sessionStorage.removeItem('oauth_state');
      
      // Exchange code for token
      const { user: userData, token } = await api.login(provider, code);
      
      localStorage.setItem('authToken', token);
      localStorage.setItem('user', JSON.stringify(userData));
      
      api.setAuthToken(token);
      setUser(userData);
      telemetry.setUserId(userData.id);
      telemetry.track('login_success', { provider });
    } catch (e) {
      setError(e.message);
      telemetry.trackError(e, { context: 'oauth_callback', provider });
    } finally {
      setIsLoading(false);
    }
  }, []);
  
  const logout = useCallback(async () => {
    telemetry.track('logout');
    
    try {
      await api.logout();
    } catch (e) {
      // Ignore logout errors
    }
    
    localStorage.removeItem('authToken');
    localStorage.removeItem('user');
    api.setAuthToken(null);
    setUser(null);
    telemetry.setUserId(null);
  }, []);
  
  const value = {
    user,
    isLoading,
    error,
    isAuthenticated: !!user,
    loginWithProvider,
    handleOAuthCallback,
    logout,
    telemetry
  };
  
  return (
    <AuthContext.Provider value={value}>
      {children}
    </AuthContext.Provider>
  );
};

// ============================================================================
// DATA PERSISTENCE SERVICE (User-Isolated)
// ============================================================================

const useUserData = () => {
  const { user, isAuthenticated } = useAuth();
  const [isLoading, setIsLoading] = useState(false);
  const [isSyncing, setIsSyncing] = useState(false);
  const [lastSync, setLastSync] = useState(null);
  
  // Get storage key for current user
  const getStorageKey = useCallback((key) => {
    if (!user?.id) return null;
    return `angelflow_${user.id}_${key}`;
  }, [user?.id]);
  
  // Load data from localStorage (user-isolated)
  const loadData = useCallback((key, defaultValue = null) => {
    const storageKey = getStorageKey(key);
    if (!storageKey) return defaultValue;
    
    try {
      const stored = localStorage.getItem(storageKey);
      return stored ? JSON.parse(stored) : defaultValue;
    } catch (e) {
      telemetry.trackError(e, { context: 'load_data', key });
      return defaultValue;
    }
  }, [getStorageKey]);
  
  // Save data to localStorage (user-isolated)
  const saveData = useCallback((key, data) => {
    const storageKey = getStorageKey(key);
    if (!storageKey) return false;
    
    try {
      localStorage.setItem(storageKey, JSON.stringify(data));
      telemetry.track('data_saved', { key, size: JSON.stringify(data).length });
      return true;
    } catch (e) {
      telemetry.trackError(e, { context: 'save_data', key });
      return false;
    }
  }, [getStorageKey]);
  
  // Sync with backend (when available)
  const syncWithBackend = useCallback(async (deals) => {
    if (!isAuthenticated) return;
    
    setIsSyncing(true);
    try {
      // In production, this would sync with the backend
      // await api.syncDeals(deals);
      setLastSync(new Date().toISOString());
      telemetry.track('sync_success', { dealCount: deals.length });
    } catch (e) {
      telemetry.trackError(e, { context: 'sync' });
    } finally {
      setIsSyncing(false);
    }
  }, [isAuthenticated]);
  
  return {
    loadData,
    saveData,
    syncWithBackend,
    isLoading,
    isSyncing,
    lastSync,
    isAuthenticated
  };
};

// ============================================================================
// LOGIN PAGE COMPONENT
// ============================================================================

const LoginPage = () => {
  const { loginWithProvider, isLoading, error } = useAuth();
  const [selectedProvider, setSelectedProvider] = useState(null);
  
  const providers = [
    {
      id: 'google',
      name: 'Google',
      icon: (
        <svg width="20" height="20" viewBox="0 0 24 24">
          <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"/>
          <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"/>
          <path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"/>
          <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"/>
        </svg>
      ),
      bgColor: 'bg-white hover:bg-gray-50',
      textColor: 'text-gray-700',
      borderColor: 'border-gray-300'
    },
    {
      id: 'angellist',
      name: 'AngelList',
      icon: (
        <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
          <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-1.41 16.09V16c-1.38 0-2.5-1.12-2.5-2.5s1.12-2.5 2.5-2.5V9c0-.55.45-1 1-1h.82c.55 0 1 .45 1 1v2h1.18c.55 0 1 .45 1 1v.82c0 .55-.45 1-1 1h-1.18v2.27c1.64-.42 2.86-1.9 2.86-3.68 0-2.07-1.68-3.75-3.75-3.75s-3.75 1.68-3.75 3.75c0 1.78 1.22 3.26 2.86 3.68z"/>
        </svg>
      ),
      bgColor: 'bg-black hover:bg-gray-900',
      textColor: 'text-white',
      borderColor: 'border-black'
    },
    {
      id: 'carta',
      name: 'Carta',
      icon: (
        <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
          <path d="M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5"/>
        </svg>
      ),
      bgColor: 'bg-[#0066FF] hover:bg-[#0052CC]',
      textColor: 'text-white',
      borderColor: 'border-[#0066FF]'
    }
  ];
  
  const handleLogin = async (providerId) => {
    setSelectedProvider(providerId);
    try {
      await loginWithProvider(providerId);
    } catch (e) {
      setSelectedProvider(null);
    }
  };
  
  return (
    <div className="min-h-screen bg-gradient-to-br from-stone-50 to-stone-100 dark:from-stone-900 dark:to-stone-800 flex items-center justify-center p-4">
      <div className="w-full max-w-md">
        {/* Logo and Title */}
        <div className="text-center mb-8">
          <div className="w-16 h-16 bg-[#5B6DC4] rounded-2xl flex items-center justify-center mx-auto mb-4 shadow-lg">
            <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2">
              <path d="M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5"/>
            </svg>
          </div>
          <h1 className="text-2xl font-bold text-stone-900 dark:text-white mb-2">Convex</h1>
          <p className="text-stone-500 dark:text-stone-400">Track your angel investments with clarity</p>
        </div>
        
        {/* Login Card */}
        <div className="bg-white dark:bg-stone-800 rounded-2xl shadow-xl p-8 border border-stone-200 dark:border-stone-700">
          <h2 className="text-lg font-semibold text-stone-900 dark:text-white mb-6 text-center">
            Sign in to continue
          </h2>
          
          {error && (
            <div className="mb-4 p-3 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-lg">
              <p className="text-sm text-red-600 dark:text-red-400">{error}</p>
            </div>
          )}
          
          <div className="space-y-3">
            {providers.map((provider) => (
              <button
                key={provider.id}
                onClick={() => handleLogin(provider.id)}
                disabled={isLoading}
                className={`w-full flex items-center justify-center gap-3 px-4 py-3 rounded-xl border ${provider.borderColor} ${provider.bgColor} ${provider.textColor} font-medium transition-all disabled:opacity-50 disabled:cursor-not-allowed`}
              >
                {selectedProvider === provider.id && isLoading ? (
                  <svg className="animate-spin h-5 w-5" viewBox="0 0 24 24">
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" fill="none"/>
                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"/>
                  </svg>
                ) : (
                  provider.icon
                )}
                <span>Continue with {provider.name}</span>
              </button>
            ))}
          </div>
          
          <div className="mt-6 pt-6 border-t border-stone-200 dark:border-stone-700">
            <p className="text-xs text-stone-400 dark:text-stone-500 text-center">
              By signing in, you agree to our{' '}
              <a href="#" className="text-[#5B6DC4] hover:underline">Terms of Service</a>
              {' '}and{' '}
              <a href="#" className="text-[#5B6DC4] hover:underline">Privacy Policy</a>
            </p>
          </div>
        </div>
        
        {/* Features */}
        <div className="mt-8 grid grid-cols-3 gap-4 text-center">
          <div>
            <div className="w-10 h-10 bg-emerald-100 dark:bg-emerald-900/30 rounded-xl flex items-center justify-center mx-auto mb-2">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#10B981" strokeWidth="2">
                <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>
              </svg>
            </div>
            <p className="text-xs text-stone-500 dark:text-stone-400">Secure & Private</p>
          </div>
          <div>
            <div className="w-10 h-10 bg-blue-100 dark:bg-blue-900/30 rounded-xl flex items-center justify-center mx-auto mb-2">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#3B82F6" strokeWidth="2">
                <rect x="2" y="3" width="20" height="14" rx="2"/>
                <path d="M8 21h8M12 17v4"/>
              </svg>
            </div>
            <p className="text-xs text-stone-500 dark:text-stone-400">Sync Anywhere</p>
          </div>
          <div>
            <div className="w-10 h-10 bg-violet-100 dark:bg-violet-900/30 rounded-xl flex items-center justify-center mx-auto mb-2">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#8B5CF6" strokeWidth="2">
                <path d="M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5"/>
              </svg>
            </div>
            <p className="text-xs text-stone-500 dark:text-stone-400">Portfolio Insights</p>
          </div>
        </div>
      </div>
    </div>
  );
};

// ============================================================================
// USER MENU COMPONENT
// ============================================================================

const UserMenu = () => {
  const { user, logout } = useAuth();
  const [isOpen, setIsOpen] = useState(false);
  const menuRef = useRef(null);
  
  useEffect(() => {
    const handleClickOutside = (e) => {
      if (menuRef.current && !menuRef.current.contains(e.target)) {
        setIsOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);
  
  if (!user) return null;
  
  return (
    <div className="relative" ref={menuRef}>
      <button
        onClick={() => setIsOpen(!isOpen)}
        className="flex items-center gap-2 p-1.5 rounded-full hover:bg-stone-100 dark:hover:bg-stone-700 transition-colors"
      >
        <img
          src={user.avatar || `https://ui-avatars.com/api/?name=${encodeURIComponent(user.name || user.email)}&background=5B6DC4&color=fff`}
          alt={user.name || user.email}
          className="w-8 h-8 rounded-full"
        />
      </button>
      
      {isOpen && (
        <div className="absolute right-0 mt-2 w-64 bg-white dark:bg-stone-800 rounded-xl shadow-xl border border-stone-200 dark:border-stone-700 py-2 z-50">
          <div className="px-4 py-3 border-b border-stone-200 dark:border-stone-700">
            <p className="font-medium text-stone-900 dark:text-white truncate">{user.name || 'User'}</p>
            <p className="text-sm text-stone-500 dark:text-stone-400 truncate">{user.email}</p>
            <div className="flex items-center gap-1 mt-1">
              <span className="text-xs text-stone-400 capitalize">via {user.provider}</span>
            </div>
          </div>
          
          <div className="py-1">
            <button
              onClick={() => {
                setIsOpen(false);
                // Navigate to settings
              }}
              className="w-full px-4 py-2 text-left text-sm text-stone-700 dark:text-stone-300 hover:bg-stone-100 dark:hover:bg-stone-700 flex items-center gap-2"
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <circle cx="12" cy="12" r="3"/>
                <path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 010 2.83 2 2 0 01-2.83 0l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 01-2 2 2 2 0 01-2-2v-.09A1.65 1.65 0 009 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 01-2.83 0 2 2 0 010-2.83l.06-.06a1.65 1.65 0 00.33-1.82 1.65 1.65 0 00-1.51-1H3a2 2 0 01-2-2 2 2 0 012-2h.09A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 010-2.83 2 2 0 012.83 0l.06.06a1.65 1.65 0 001.82.33H9a1.65 1.65 0 001-1.51V3a2 2 0 012-2 2 2 0 012 2v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 012.83 0 2 2 0 010 2.83l-.06.06a1.65 1.65 0 00-.33 1.82V9a1.65 1.65 0 001.51 1H21a2 2 0 012 2 2 2 0 01-2 2h-.09a1.65 1.65 0 00-1.51 1z"/>
              </svg>
              Settings
            </button>
            
            <button
              onClick={() => {
                setIsOpen(false);
                logout();
              }}
              className="w-full px-4 py-2 text-left text-sm text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-900/20 flex items-center gap-2"
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M9 21H5a2 2 0 01-2-2V5a2 2 0 012-2h4"/>
                <polyline points="16 17 21 12 16 7"/>
                <line x1="21" y1="12" x2="9" y2="12"/>
              </svg>
              Sign out
            </button>
          </div>
        </div>
      )}
    </div>
  );
};

// ============================================================================
// SYNC STATUS INDICATOR
// ============================================================================

const SyncStatus = ({ isSyncing, lastSync }) => {
  if (!lastSync && !isSyncing) return null;
  
  return (
    <div className="flex items-center gap-1.5 text-xs text-stone-400">
      {isSyncing ? (
        <>
          <svg className="animate-spin h-3 w-3" viewBox="0 0 24 24">
            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" fill="none"/>
            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"/>
          </svg>
          <span>Syncing...</span>
        </>
      ) : (
        <>
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <polyline points="20 6 9 17 4 12"/>
          </svg>
          <span>Saved</span>
        </>
      )}
    </div>
  );
};

// ============================================================================
// ORIGINAL APP CODE CONTINUES BELOW
// ============================================================================

// Theme Context
const ThemeContext = createContext({ theme: 'light', setTheme: () => {} });
const useTheme = () => useContext(ThemeContext);

// Utilities
const formatCurrency = (n) => n >= 1000000 ? `$${(n/1000000).toFixed(1)}M` : n >= 1000 ? `$${(n/1000).toFixed(0)}K` : `$${n}`;
const formatDate = (d) => new Date(d).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
const daysAgo = (d) => Math.floor((Date.now() - new Date(d).getTime()) / 86400000);
const generateId = () => Math.random().toString(36).substr(2, 9);
const daysUntil = (d) => Math.ceil((new Date(d).getTime() - Date.now()) / 86400000);
const formatRelativeTime = (d) => {
  const days = daysAgo(d);
  if (days === 0) return 'Today';
  if (days === 1) return 'Yesterday';
  if (days < 7) return `${days}d ago`;
  if (days < 30) return `${Math.floor(days / 7)}w ago`;
  if (days < 365) return `${Math.floor(days / 30)}mo ago`;
  return `${Math.floor(days / 365)}y ago`;
};

// Default settings
const DEFAULT_SETTINGS = {
  profile: { name: '', email: '', timezone: 'America/New_York' },
  accountType: 'Solo angel',
  notifications: { push: false, reminderFrequency: 'daily', quietHoursStart: '22:00', quietHoursEnd: '08:00' },
  appearance: 'light'
};

// Lifecycle: Screening → Decision (Invested / Deferred / Passed)
// Tracking is an overlay, not a stage. Invested = always tracked. Deferred = tracked by default. Passed = untracked by default.
const STATUS_CONFIG = {
  'screening': { label: 'Screening', color: 'bg-[#5B6DC4]', light: 'bg-[#5B6DC4]/10 text-[#5B6DC4] border border-[#5B6DC4]/30', question: 'Is this worth investing in?' },
  'invested': { label: 'Invested', color: 'bg-emerald-500', light: 'bg-emerald-50 text-emerald-600 border border-emerald-200', question: 'Capital deployed' },
  'deferred': { label: 'Watching', color: 'bg-[#5B6DC4]', light: 'bg-[#5B6DC4]/10 text-[#5B6DC4] border border-[#5B6DC4]/30', question: 'What needs to change before I reconsider?' },
  'passed': { label: 'Passed', color: 'bg-stone-400', light: 'bg-stone-100 text-stone-600 border border-stone-200', question: 'Why was this a no?' },
  'learning': { label: 'Learning', color: 'bg-[#5B6DC4]', light: 'bg-[#5B6DC4]/10 text-[#5B6DC4] border border-[#5B6DC4]/30', question: 'What can I learn from this?' },
  'needsAttention': { label: 'Needs Attention', color: 'bg-red-500', light: 'bg-red-50 text-red-600 border border-red-200', question: 'Requires action' },
};

const DILIGENCE_SIGNALS = ['Founder call completed', 'Deck reviewed', 'Product demo watched', 'Customer signal observed'];

// Defer reasons and revisit conditions for decision closure workflow
const DEFER_REASONS = ['Timing', 'Missing signal', 'Needs traction', 'Pricing unclear', 'Other'];
const REVISIT_CONDITIONS = ['Date', 'Milestone', 'External signal'];
const PASS_REASONS = ['Market too small', 'Valuation too high', 'Weak team', 'Poor timing', 'Competitive risk', 'Not my thesis', 'Other'];
const INACTIVE_REASONS = ['Paused', 'No longer relevant', 'Company shut down', 'Monitoring stopped'];

// Gate validation
const canPromote = (deal, targetStatus) => {
  const errors = [];
  
  if (targetStatus === 'invested') {
    // Screening → Invested: requires investment decision
    if (!deal.investment?.amount) errors.push('Investment amount required');
    if (!deal.investment?.vehicle) errors.push('Vehicle required');
    if (!deal.investment?.whyYes) errors.push('"Why I said yes" note required');
  }
  
  return { valid: errors.length === 0, errors };
};

// Demo Data
const createDemoDeals = () => [
  {
    id: '1', companyName: 'NeuralKit', logoUrl: 'https://ui-avatars.com/api/?name=NK&background=6366f1&color=fff&size=64&bold=true',
    status: 'screening', engagement: 'active', industry: 'AI/ML', stage: 'seed',
    website: 'https://neuralkit.ai',
    source: { type: 'intro', name: 'Maya Chen' }, deferType: 'watching', portfolioMetrics: null, needsAttention: false,
    loiDue: new Date(Date.now() + 5*86400000).toISOString(),
    lastAssessedAt: new Date(Date.now() - 1*86400000).toISOString(),
    statusEnteredAt: new Date(Date.now() - 5*86400000).toISOString(),
    lastActivity: new Date(Date.now() - 1*86400000).toISOString(),
    createdAt: new Date(Date.now() - 10*86400000).toISOString(),
    founders: [
      { name: 'Alex Rivera', role: 'CEO', linkedIn: 'https://linkedin.com/in/alexrivera', email: 'alex@neuralkit.ai', background: 'Ex-Google Brain, Stanford CS PhD', yearsExperience: 12 },
      { name: 'Priya Sharma', role: 'CTO', linkedIn: 'https://linkedin.com/in/priyasharma', email: 'priya@neuralkit.ai', background: 'Ex-Meta AI Research, MIT', yearsExperience: 10 }
    ],
    terms: {
      instrument: 'SAFE',
      cap: 12000000,
      discount: 20,
      proRata: true,
      mfn: true,
      boardSeat: false,
      notes: 'Standard YC SAFE template'
    },
    attachments: [
      { id: 'a1', name: 'Pitch Deck Q4 2024.pdf', type: 'deck', size: '2.4 MB', uploadedAt: new Date(Date.now() - 8*86400000).toISOString() },
      { id: 'a2', name: 'Financial Model.xlsx', type: 'financials', size: '156 KB', uploadedAt: new Date(Date.now() - 7*86400000).toISOString() },
      { id: 'a3', name: 'Technical Architecture.pdf', type: 'other', size: '890 KB', uploadedAt: new Date(Date.now() - 5*86400000).toISOString() }
    ],
    screening: {
      thesis: 'Best-in-class ML infrastructure for mid-market. Strong technical founders from Google Brain.',
      signals: ['Founder call completed', 'Deck reviewed', 'Product demo watched'],
      stageFit: true, checkFit: true
    },
    investment: { amount: 25000, vehicle: 'SAFE', date: null },
    dueDiligence: {
      checklist: [
        { id: '1', category: 'team', text: 'Reference calls (3+)', completed: true },
        { id: '2', category: 'team', text: 'Background verification', completed: true },
        { id: '3', category: 'market', text: 'TAM/SAM analysis', completed: true },
        { id: '4', category: 'market', text: 'Competitive landscape', completed: false },
        { id: '5', category: 'product', text: 'Technical architecture review', completed: false },
        { id: '6', category: 'traction', text: 'Customer interviews (5+)', completed: false },
        { id: '7', category: 'risks', text: 'Legal review', completed: true },
      ],
      openQuestions: [
        { id: '1', question: 'Path to $10M ARR?', status: 'open', blocking: true },
        { id: '2', question: 'Why did previous CTO leave?', status: 'answered', answer: 'Personal reasons, amicable', blocking: false },
        { id: '3', question: 'Enterprise vs PLG?', status: 'open', blocking: false },
      ],
      tasks: [
        { id: '1', task: 'Customer call with Acme Corp', owner: 'Me', completed: false },
        { id: '2', task: 'Review financial model', owner: 'Me', completed: true },
      ],
      enteredAt: new Date(Date.now() - 5*86400000).toISOString(),
    }
  },
  {
    id: '2', companyName: 'CloudBase', logoUrl: 'https://ui-avatars.com/api/?name=CB&background=10b981&color=fff&size=64&bold=true',
    status: 'invested', engagement: 'active', industry: 'DevTools', stage: 'series-a',
    website: 'https://cloudbase.dev',
    source: { type: 'syndicate', name: 'Calm Fund' },
    
    lastAssessedAt: new Date(Date.now() - 5*86400000).toISOString(),
    statusEnteredAt: new Date(Date.now() - 60*86400000).toISOString(),
    lastActivity: new Date(Date.now() - 5*86400000).toISOString(),
    lastUpdateReceived: new Date(Date.now() - 12*86400000).toISOString(),
    createdAt: new Date(Date.now() - 120*86400000).toISOString(),
    founders: [
      { name: 'Marcus Johnson', role: 'CEO', linkedIn: 'https://linkedin.com/in/marcusj', email: 'marcus@cloudbase.dev', background: 'Ex-AWS, 2x founder (1 exit)', yearsExperience: 15 },
      { name: 'Sarah Kim', role: 'CTO', linkedIn: 'https://linkedin.com/in/sarahkim', email: 'sarah@cloudbase.dev', background: 'Ex-Stripe Engineering Lead', yearsExperience: 11 }
    ],
    terms: {
      instrument: 'SAFE',
      cap: 20000000,
      discount: null,
      proRata: true,
      mfn: false,
      boardSeat: false,
      notes: 'Post-money SAFE'
    },
    attachments: [
      { id: 'a1', name: 'SAFE Agreement.pdf', type: 'legal', size: '245 KB', uploadedAt: new Date(Date.now() - 90*86400000).toISOString() },
      { id: 'a2', name: 'Side Letter.pdf', type: 'legal', size: '89 KB', uploadedAt: new Date(Date.now() - 90*86400000).toISOString() },
      { id: 'a3', name: 'Cap Table.xlsx', type: 'financials', size: '67 KB', uploadedAt: new Date(Date.now() - 85*86400000).toISOString() },
      { id: 'a4', name: 'Monthly Update - Nov.pdf', type: 'update', size: '1.2 MB', uploadedAt: new Date(Date.now() - 15*86400000).toISOString() }
    ],
    screening: { thesis: 'Developer tools for serverless. Strong PMF signals.', signals: ['Founder call completed', 'Deck reviewed'], stageFit: true, checkFit: true },
    investment: {
      amount: 50000, vehicle: 'SAFE', date: new Date(Date.now() - 90*86400000).toISOString(),
      ownershipPercent: 0.5, documents: ['SAFE Agreement', 'Side Letter'],
      updateFrequency: 'monthly', metricsToWatch: ['MRR', 'Churn', 'NPS'],
      nextUpdateExpected: new Date(Date.now() + 18*86400000).toISOString()
    },
    monitoring: {
      healthStatus: 'thriving', fundraisingStatus: 'closed', runwayMonths: 18,
      wouldInvestAgain: true, wouldIntro: true,
      followOns: [{ date: new Date(Date.now() - 30*86400000).toISOString(), amount: 25000 }]
    },
    milestones: [
      { id: 'm1', type: 'fundraising', title: 'Closed Series A', description: '$8M led by Sequoia', date: new Date(Date.now() - 45*86400000).toISOString() },
      { id: 'm2', type: 'hiring', title: 'Head of Sales hired', description: 'Jane Smith, ex-Datadog', date: new Date(Date.now() - 30*86400000).toISOString() },
      { id: 'm3', type: 'growth', title: 'Hit $500K ARR', description: '3x growth in 6 months', date: new Date(Date.now() - 20*86400000).toISOString() },
      { id: 'm4', type: 'product', title: 'V2.0 Launch', description: 'Major platform update with enterprise features', date: new Date(Date.now() - 10*86400000).toISOString() }
    ]
  },
  {
    id: '3', companyName: 'HealthSync', logoUrl: 'https://ui-avatars.com/api/?name=HS&background=3b82f6&color=fff&size=64&bold=true',
    status: 'deferred', engagement: 'active', industry: 'HealthTech', stage: 'pre-seed',
    website: 'https://healthsync.io',
    source: { type: 'event', name: 'Demo Day' },
    
    lastAssessedAt: new Date(Date.now() - 2*86400000).toISOString(),
    statusEnteredAt: new Date(Date.now() - 14*86400000).toISOString(),
    lastActivity: new Date(Date.now() - 2*86400000).toISOString(),
    createdAt: new Date(Date.now() - 30*86400000).toISOString(),
    founders: [
      { name: 'Dr. Emily Watson', role: 'CEO', linkedIn: 'https://linkedin.com/in/emilywatson', email: 'emily@healthsync.io', background: 'MD Stanford, Ex-Oscar Health', yearsExperience: 8 }
    ],
    terms: {
      instrument: 'SAFE',
      cap: 8000000,
      discount: 20,
      proRata: true,
      mfn: true,
      notes: 'Seeking $1.5M pre-seed'
    },
    attachments: [
      { id: 'a1', name: 'Deck - HealthSync.pdf', type: 'deck', size: '3.1 MB', uploadedAt: new Date(Date.now() - 28*86400000).toISOString() }
    ],
    screening: { thesis: 'Strong founder-market fit, but timing risk around enterprise adoption cycles. Worth watching through Q2.', signals: ['Deck reviewed'], stageFit: true, checkFit: true },
    watching: {
      reason: 'Traction',
      trigger: 'When they close 5 enterprise pilots',
      reminderDate: new Date(Date.now() + 30*86400000).toISOString()
    }
  },
  {
    id: '4', companyName: 'FinanceFlow', logoUrl: 'https://ui-avatars.com/api/?name=FF&background=8b5cf6&color=fff&size=64&bold=true',
    status: 'screening', engagement: 'active', industry: 'Fintech', stage: 'seed',
    website: 'https://financeflow.co',
    source: { type: 'intro', name: 'Jason Park' },
    loiDue: new Date(Date.now() + 2*86400000).toISOString(),
    lastAssessedAt: new Date(Date.now() - 3600000).toISOString(),
    statusEnteredAt: new Date(Date.now() - 2*86400000).toISOString(),
    lastActivity: new Date(Date.now() - 3600000).toISOString(),
    createdAt: new Date(Date.now() - 2*86400000).toISOString(),
    founders: [
      { name: 'Rachel Green', role: 'CEO', linkedIn: 'https://linkedin.com/in/rachelg', email: 'rachel@financeflow.co', background: 'Ex-Square, Wharton MBA', yearsExperience: 9 },
      { name: 'Tom Martinez', role: 'CTO', linkedIn: 'https://linkedin.com/in/tomm', email: 'tom@financeflow.co', background: 'Ex-Plaid Senior Engineer', yearsExperience: 7 }
    ],
    terms: {
      instrument: 'SAFE',
      cap: 15000000,
      discount: 20,
      proRata: true
    },
    attachments: [],
    screening: { thesis: 'Interesting B2B payments angle. Need to understand differentiation from existing players.', signals: [], stageFit: true, checkFit: true },
    investment: { amount: 35000 }
  },
  {
    id: '5', companyName: 'DataVault', logoUrl: 'https://ui-avatars.com/api/?name=DV&background=059669&color=fff&size=64&bold=true',
    status: 'invested', engagement: 'active', industry: 'Security', stage: 'seed',
    website: 'https://datavault.io',
    source: { type: 'syndicate', name: 'AngelList' },
    
    lastAssessedAt: new Date(Date.now() - 3*86400000).toISOString(),
    statusEnteredAt: new Date(Date.now() - 3*86400000).toISOString(),
    lastActivity: new Date(Date.now() - 3*86400000).toISOString(),
    createdAt: new Date(Date.now() - 45*86400000).toISOString(),
    founders: [
      { name: 'Chris Anderson', role: 'CEO', linkedIn: 'https://linkedin.com/in/chrisa', email: 'chris@datavault.io', background: 'Ex-Cloudflare, Security researcher', yearsExperience: 14 }
    ],
    terms: {
      instrument: 'SAFE',
      cap: 10000000,
      discount: 20,
      proRata: true,
      mfn: true
    },
    attachments: [
      { id: 'a1', name: 'SAFE Agreement.pdf', type: 'legal', size: '234 KB', uploadedAt: new Date(Date.now() - 3*86400000).toISOString() }
    ],
    screening: { thesis: 'Data security for SMBs. Underserved market with strong tailwinds.', signals: ['Founder call completed', 'Deck reviewed'], stageFit: true, checkFit: true },
    investment: {
      amount: 30000, vehicle: 'SAFE', date: new Date(Date.now() - 3*86400000).toISOString(),
      ownershipPercent: 0.3, documents: ['SAFE Agreement'],
      updateFrequency: '', metricsToWatch: []
    }
  },
  {
    id: '6', companyName: 'RetailAI', logoUrl: 'https://ui-avatars.com/api/?name=RA&background=78716c&color=fff&size=64&bold=true',
    status: 'passed', engagement: 'inactive', industry: 'Retail', stage: 'seed',
    source: { type: 'inbound', name: 'Cold outreach' },
    
    lastAssessedAt: new Date(Date.now() - 20*86400000).toISOString(),
    statusEnteredAt: new Date(Date.now() - 20*86400000).toISOString(),
    lastActivity: new Date(Date.now() - 20*86400000).toISOString(),
    createdAt: new Date(Date.now() - 30*86400000).toISOString(),
    founders: [
      { name: 'Mike Thompson', role: 'CEO', background: 'First-time founder', yearsExperience: 5 }
    ],
    terms: {
      instrument: 'SAFE',
      cap: 25000000,
      notes: 'Valuation too high for traction'
    },
    attachments: [
      { id: 'a1', name: 'Pitch Deck.pdf', type: 'deck', size: '4.2 MB', uploadedAt: new Date(Date.now() - 25*86400000).toISOString() }
    ],
    passed: {
      reasons: ['Market too small', 'Valuation too high'],
      passedAt: new Date(Date.now() - 20*86400000).toISOString(),
      notes: 'Interesting tech but market is saturated.',
    },
    inactiveReason: 'No longer relevant'
  },
  {
    id: '7', companyName: 'Acme Analytics', logoUrl: 'https://ui-avatars.com/api/?name=AA&background=f59e0b&color=fff&size=64&bold=true',
    status: 'invested', engagement: 'active', industry: 'Analytics', stage: 'series-b',
    website: 'https://acmeanalytics.com',
    source: { type: 'syndicate', name: 'Existing Portfolio' },
    
    lastAssessedAt: new Date(Date.now() - 3*86400000).toISOString(),
    isLegacyPortfolio: true,
    statusEnteredAt: new Date(Date.now() - 400*86400000).toISOString(),
    lastActivity: new Date(Date.now() - 3*86400000).toISOString(),
    lastUpdateReceived: new Date(Date.now() - 8*86400000).toISOString(),
    createdAt: new Date(Date.now() - 730*86400000).toISOString(),
    founders: [
      { name: 'David Lee', role: 'CEO', linkedIn: 'https://linkedin.com/in/davidlee', email: 'david@acmeanalytics.com', background: 'Ex-Tableau VP Product, Stanford MBA', yearsExperience: 18 },
      { name: 'Lisa Chen', role: 'CTO', linkedIn: 'https://linkedin.com/in/lisachen', email: 'lisa@acmeanalytics.com', background: 'Ex-Google Staff Engineer', yearsExperience: 16 },
      { name: 'James Wilson', role: 'COO', linkedIn: 'https://linkedin.com/in/jameswilson', email: 'james@acmeanalytics.com', background: 'Ex-McKinsey Partner', yearsExperience: 20 }
    ],
    terms: {
      instrument: 'Equity',
      valuation: 45000000,
      proRata: true,
      boardSeat: false,
      notes: 'Series A equity investment'
    },
    attachments: [
      { id: 'a1', name: 'Stock Purchase Agreement.pdf', type: 'legal', size: '1.8 MB', uploadedAt: new Date(Date.now() - 700*86400000).toISOString() },
      { id: 'a2', name: 'Q3 Board Deck.pdf', type: 'update', size: '5.4 MB', uploadedAt: new Date(Date.now() - 45*86400000).toISOString() },
      { id: 'a3', name: 'Q4 Board Deck.pdf', type: 'update', size: '6.1 MB', uploadedAt: new Date(Date.now() - 8*86400000).toISOString() }
    ],
    investment: {
      amount: 75000, vehicle: 'Equity', date: new Date(Date.now() - 700*86400000).toISOString(),
      ownershipPercent: 0.25, documents: ['Stock Purchase Agreement', 'Investor Rights Agreement'],
      updateFrequency: 'quarterly', metricsToWatch: ['ARR', 'Net Revenue Retention', 'Burn Multiple'],
      nextUpdateExpected: new Date(Date.now() + 60*86400000).toISOString()
    },
    monitoring: {
      healthStatus: 'thriving', fundraisingStatus: 'not-raising', runwayMonths: 24,
      wouldInvestAgain: true, wouldIntro: true,
      followOns: [
        { date: new Date(Date.now() - 400*86400000).toISOString(), amount: 50000, notes: 'Series B pro-rata' }
      ]
    },
    milestones: [
      { id: 'm1', type: 'fundraising', title: 'Seed Round', description: '$2M from First Round', date: new Date(Date.now() - 730*86400000).toISOString() },
      { id: 'm2', type: 'hiring', title: 'Team reached 10', description: 'Key engineering hires', date: new Date(Date.now() - 600*86400000).toISOString() },
      { id: 'm3', type: 'growth', title: 'First $1M ARR', description: 'Crossed milestone ahead of plan', date: new Date(Date.now() - 500*86400000).toISOString() },
      { id: 'm4', type: 'fundraising', title: 'Series A', description: '$12M led by a]16z', date: new Date(Date.now() - 450*86400000).toISOString() },
      { id: 'm5', type: 'hiring', title: 'Team reached 35', description: 'Expanded sales team', date: new Date(Date.now() - 350*86400000).toISOString() },
      { id: 'm6', type: 'fundraising', title: 'Series B', description: '$30M led by Insight Partners', date: new Date(Date.now() - 400*86400000).toISOString() },
      { id: 'm7', type: 'growth', title: '$5M ARR', description: '5x growth YoY', date: new Date(Date.now() - 200*86400000).toISOString() },
      { id: 'm8', type: 'partnership', title: 'Salesforce Partnership', description: 'Official AppExchange partner', date: new Date(Date.now() - 100*86400000).toISOString() },
      { id: 'm9', type: 'hiring', title: 'Team reached 80', description: 'Opened EU office', date: new Date(Date.now() - 60*86400000).toISOString() },
      { id: 'm10', type: 'growth', title: '$10M ARR', description: 'Enterprise segment growing 200%', date: new Date(Date.now() - 15*86400000).toISOString() }
    ]
  }
];

// Components
const CompanyLogo = ({ url, name, size = 'md' }) => {
  const sizes = { sm: 'w-10 h-10 text-sm', md: 'w-12 h-12 text-base', lg: 'w-14 h-14 text-lg' };
  const initial = name?.charAt(0)?.toUpperCase() || '?';
  if (url) return <img src={url} alt={name} className={`${sizes[size].split(' ').slice(0,2).join(' ')} rounded-xl object-cover`} />;
  return (
    <div className={`${sizes[size]} rounded-xl bg-stone-200 dark:bg-stone-700 flex items-center justify-center font-semibold text-stone-500 dark:text-stone-400`}>
      {initial}
    </div>
  );
  return <div className={`${sizes[size]} rounded-xl bg-gradient-to-br from-stone-200 to-stone-300 flex items-center justify-center text-stone-600 font-bold`}>{name.split(' ').map(w => w[0]).join('').slice(0,2)}</div>;
};

const StatusBadge = ({ status, size = 'md' }) => {
  const config = STATUS_CONFIG[status];
  const sizes = { sm: 'px-2 py-0.5 text-xs', md: 'px-2.5 py-1 text-xs' };
  return <span className={`${sizes[size]} rounded-full font-medium ${config.light}`}>{config.label}</span>;
};

const EngagementBadge = ({ active }) => (
  <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${active ? 'bg-emerald-100 text-emerald-700' : 'bg-stone-200 text-stone-500'}`}>
    {active ? 'Active' : 'Inactive'}
  </span>
);

const Card = ({ children, className = '', onClick }) => (
  <div onClick={onClick} className={`bg-white dark:bg-stone-800 rounded-2xl p-4 shadow-sm dark:shadow-stone-900/20 ${onClick ? 'cursor-pointer hover:shadow-md active:scale-[0.99] transition-all' : ''} ${className}`}>{children}</div>
);

// Reminder Button Component
const ReminderButton = ({ reminder, onSet, compact = false }) => {
  const [showPicker, setShowPicker] = useState(false);
  const presets = [
    { label: '1 week', days: 7 },
    { label: '2 weeks', days: 14 },
    { label: '30 days', days: 30 },
    { label: '60 days', days: 60 },
  ];

  const hasReminder = reminder && new Date(reminder) > new Date();
  const daysLeft = hasReminder ? daysUntil(reminder) : null;

  if (compact) {
    return (
      <div className="relative">
        <button 
          onClick={() => setShowPicker(!showPicker)}
          className={`p-1.5 rounded-lg transition-colors ${hasReminder ? 'bg-blue-50 text-blue-600 dark:bg-blue-900/30 dark:text-blue-400' : 'text-stone-400 hover:text-stone-600 hover:bg-stone-100 dark:hover:bg-stone-700'}`}
          title={hasReminder ? `Reminder in ${daysLeft}d` : 'Set reminder'}
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/>
            <path d="M13.73 21a2 2 0 0 1-3.46 0"/>
            {hasReminder && <circle cx="18" cy="5" r="3" fill="currentColor" stroke="none"/>}
          </svg>
        </button>
        {showPicker && (
          <div className="absolute right-0 top-full mt-1 bg-white dark:bg-stone-800 rounded-xl shadow-lg border border-stone-200 dark:border-stone-700 p-2 z-50 min-w-[140px]">
            {presets.map(p => (
              <button
                key={p.days}
                onClick={() => { onSet(new Date(Date.now() + p.days * 86400000).toISOString()); setShowPicker(false); }}
                className="w-full text-left px-3 py-1.5 text-sm text-stone-700 dark:text-stone-300 hover:bg-stone-100 dark:hover:bg-stone-700 rounded-lg"
              >
                {p.label}
              </button>
            ))}
            {hasReminder && (
              <button
                onClick={() => { onSet(null); setShowPicker(false); }}
                className="w-full text-left px-3 py-1.5 text-sm text-red-600 hover:bg-red-50 dark:hover:bg-red-900/20 rounded-lg mt-1 border-t border-stone-100 dark:border-stone-700 pt-2"
              >
                Clear
              </button>
            )}
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="flex items-center gap-2">
      <button 
        onClick={() => setShowPicker(!showPicker)}
        className={`flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs transition-colors ${
          hasReminder 
            ? 'bg-blue-50 text-blue-600 dark:bg-blue-900/30 dark:text-blue-400' 
            : 'text-stone-400 hover:text-stone-600 hover:bg-stone-100 dark:hover:bg-stone-700'
        }`}
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/>
          <path d="M13.73 21a2 2 0 0 1-3.46 0"/>
        </svg>
        {hasReminder ? `${daysLeft}d` : 'Remind me'}
      </button>
      {showPicker && (
        <div className="flex gap-1">
          {presets.slice(0, 3).map(p => (
            <button
              key={p.days}
              onClick={() => { onSet(new Date(Date.now() + p.days * 86400000).toISOString()); setShowPicker(false); }}
              className="px-2 py-1 text-xs bg-stone-100 dark:bg-stone-700 text-stone-600 dark:text-stone-300 rounded hover:bg-stone-200 dark:hover:bg-stone-600"
            >
              {p.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
};

// Signal Icons for Monitoring
const SignalIcon = ({ type, active }) => {
  const icons = {
    website: <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="10"/><line x1="2" y1="12" x2="22" y2="12"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/></svg>,
    hiring: <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><line x1="19" y1="8" x2="19" y2="14"/><line x1="22" y1="11" x2="16" y2="11"/></svg>,
    fundraising: <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><line x1="12" y1="1" x2="12" y2="23"/><path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"/></svg>,
    press: <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M4 22h16a2 2 0 0 0 2-2V4a2 2 0 0 0-2-2H8a2 2 0 0 0-2 2v16a2 2 0 0 1-2 2Zm0 0a2 2 0 0 1-2-2v-9c0-1.1.9-2 2-2h2"/></svg>,
    communication: <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>,
  };
  return (
    <span className={`p-1.5 rounded-lg transition-colors ${active ? 'bg-emerald-50 text-emerald-600 dark:bg-emerald-900/30 dark:text-emerald-400' : 'bg-stone-100 text-stone-400 dark:bg-stone-700 dark:text-stone-500'}`}>
      {icons[type]}
    </span>
  );
};

// Defer Modal - for moving deals to Deferred/Watching
const DeferModal = ({ deal, onConfirm, onClose }) => {
  const [reason, setReason] = useState('');
  const [condition, setCondition] = useState('');
  const [conditionDetail, setConditionDetail] = useState('');
  
  const canConfirm = reason && condition && conditionDetail.trim();
  
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50">
      <div className="bg-white dark:bg-stone-800 rounded-2xl w-full max-w-md p-6 shadow-xl">
        <h2 className="text-lg font-bold text-stone-900 dark:text-stone-100 mb-1">Defer Decision</h2>
        <p className="text-sm text-stone-500 dark:text-stone-400 mb-6">{deal.companyName} will move to Deferred</p>
        
        <div className="space-y-4">
          <div>
            <label className="text-xs font-semibold text-stone-700 dark:text-stone-300 uppercase tracking-wide">Defer reason</label>
            <div className="flex flex-wrap gap-2 mt-2">
              {DEFER_REASONS.map(r => (
                <button
                  key={r}
                  onClick={() => setReason(r)}
                  className={`px-3 py-1.5 rounded-lg text-sm font-medium transition-all border ${reason === r ? 'bg-[#5B6DC4] text-white border-stone-900 dark:border-stone-100' : 'bg-white dark:bg-stone-700 text-stone-600 dark:text-stone-300 border-stone-300 dark:border-stone-600 hover:border-stone-400'}`}
                >
                  {r}
                </button>
              ))}
            </div>
          </div>
          
          <div>
            <label className="text-xs font-semibold text-stone-700 dark:text-stone-300 uppercase tracking-wide">Revisit when</label>
            <div className="flex flex-wrap gap-2 mt-2">
              {REVISIT_CONDITIONS.map(c => (
                <button
                  key={c}
                  onClick={() => setCondition(c)}
                  className={`px-3 py-1.5 rounded-lg text-sm font-medium transition-all border ${condition === c ? 'bg-[#5B6DC4] text-white border-stone-900 dark:border-stone-100' : 'bg-white dark:bg-stone-700 text-stone-600 dark:text-stone-300 border-stone-300 dark:border-stone-600 hover:border-stone-400'}`}
                >
                  {c}
                </button>
              ))}
            </div>
          </div>
          
          <div>
            <label className="text-xs font-semibold text-stone-700 dark:text-stone-300 uppercase tracking-wide">
              {condition === 'Date' ? 'Revisit date' : condition === 'Milestone' ? 'What milestone?' : 'What signal?'}
            </label>
            {condition === 'Date' ? (
              <input 
                type="date" 
                value={conditionDetail}
                onChange={e => setConditionDetail(e.target.value)}
                className="w-full mt-2 p-3 bg-white dark:bg-stone-700 border border-stone-300 dark:border-stone-600 rounded-xl text-sm text-stone-900 dark:text-stone-100"
              />
            ) : (
              <input 
                type="text"
                value={conditionDetail}
                onChange={e => setConditionDetail(e.target.value)}
                placeholder={condition === 'Milestone' ? 'e.g., Closes Series A' : 'e.g., Market shift'}
                className="w-full mt-2 p-3 bg-white dark:bg-stone-700 border border-stone-300 dark:border-stone-600 rounded-xl text-sm text-stone-900 dark:text-stone-100 placeholder-stone-400"
              />
            )}
          </div>
        </div>
        
        <div className="flex gap-3 mt-6">
          <button onClick={onClose} className="flex-1 py-3 text-sm font-medium text-stone-600 dark:text-stone-400 hover:bg-stone-100 dark:hover:bg-stone-700 rounded-xl transition-colors">
            Cancel
          </button>
          <button 
            onClick={() => canConfirm && onConfirm({ reason, condition, conditionDetail })}
            disabled={!canConfirm}
            className={`flex-1 py-3 text-sm font-bold rounded-xl transition-colors ${canConfirm ? 'bg-[#5B6DC4] text-white hover:bg-stone-800' : 'bg-stone-200 dark:bg-stone-700 text-stone-400 cursor-not-allowed'}`}
          >
            Defer
          </button>
        </div>
      </div>
    </div>
  );
};

// Invest Modal - for confirming investment with "Why did I say yes?"
const InvestModal = ({ deal, onConfirm, onClose }) => {
  const [whyYes, setWhyYes] = useState('');
  const [amount, setAmount] = useState(deal.investment?.amount || '');
  const [vehicle, setVehicle] = useState(deal.investment?.vehicle || 'SAFE');
  
  const canConfirm = whyYes.trim().length >= 10 && amount;
  
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50">
      <div className="bg-white dark:bg-stone-800 rounded-2xl w-full max-w-md p-6 shadow-xl">
        <h2 className="text-lg font-bold text-stone-900 dark:text-stone-100 mb-1">Confirm Investment</h2>
        <p className="text-sm text-stone-500 dark:text-stone-400 mb-6">{deal.companyName} will move to Portfolio</p>
        
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-xs font-semibold text-stone-700 dark:text-stone-300 uppercase tracking-wide">Amount</label>
              <input 
                type="number"
                value={amount}
                onChange={e => setAmount(e.target.value)}
                placeholder="25000"
                className="w-full mt-2 p-3 bg-white dark:bg-stone-700 border border-stone-300 dark:border-stone-600 rounded-xl text-sm text-stone-900 dark:text-stone-100 placeholder-stone-400"
              />
            </div>
            <div className="relative">
              <label className="text-xs font-semibold text-stone-700 dark:text-stone-300 uppercase tracking-wide">Vehicle</label>
              <select 
                value={vehicle}
                onChange={e => setVehicle(e.target.value)}
                className="w-full mt-2 p-3 pr-10 bg-white dark:bg-stone-700 border border-stone-300 dark:border-stone-600 rounded-xl text-sm text-stone-900 dark:text-stone-100 appearance-none cursor-pointer"
              >
                <option value="SAFE">SAFE</option>
                <option value="Convertible Note">Convertible Note</option>
                <option value="Equity">Equity</option>
                <option value="Other">Other</option>
              </select>
              <svg className="absolute right-3 top-[38px] pointer-events-none text-stone-400" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="6 9 12 15 18 9"/></svg>
            </div>
          </div>
          
          <div>
            <label className="text-xs font-semibold text-stone-700 dark:text-stone-300 uppercase tracking-wide">Why did I say yes?</label>
            <p className="text-xs text-stone-400 dark:text-stone-500 mt-1 mb-2">This note is immutable and helps you learn from outcomes.</p>
            <textarea 
              value={whyYes}
              onChange={e => setWhyYes(e.target.value)}
              placeholder="One sentence capturing why you decided to invest..."
              rows={2}
              className="w-full p-3 bg-white dark:bg-stone-700 border border-stone-300 dark:border-stone-600 rounded-xl text-sm text-stone-900 dark:text-stone-100 placeholder-stone-400 resize-none"
            />
          </div>
        </div>
        
        <div className="flex gap-3 mt-6">
          <button onClick={onClose} className="flex-1 py-3 text-sm font-medium text-stone-600 dark:text-stone-400 hover:bg-stone-100 dark:hover:bg-stone-700 rounded-xl transition-colors">
            Cancel
          </button>
          <button 
            onClick={() => canConfirm && onConfirm({ whyYes, amount: Number(amount), vehicle })}
            disabled={!canConfirm}
            className={`flex-1 py-3 text-sm font-bold rounded-xl transition-colors ${canConfirm ? 'bg-emerald-600 text-white hover:bg-emerald-700' : 'bg-stone-200 dark:bg-stone-700 text-stone-400 cursor-not-allowed'}`}
          >
            Invest
          </button>
        </div>
      </div>
    </div>
  );
};

// Pass Modal - for passing on a deal with "Why pass?"
const PassModal = ({ deal, onConfirm, onClose }) => {
  const [reason, setReason] = useState('');
  const [whyPass, setWhyPass] = useState('');
  
  const canConfirm = reason && whyPass.trim().length >= 10;
  
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50">
      <div className="bg-white dark:bg-stone-800 rounded-2xl w-full max-w-md p-6 shadow-xl">
        <h2 className="text-lg font-bold text-stone-900 dark:text-stone-100 mb-1">Pass on Deal</h2>
        <p className="text-sm text-stone-500 dark:text-stone-400 mb-6">{deal.companyName} will be archived</p>
        
        <div className="space-y-4">
          <div>
            <label className="text-xs font-semibold text-stone-700 dark:text-stone-300 uppercase tracking-wide">Primary reason</label>
            <div className="flex flex-wrap gap-2 mt-2">
              {PASS_REASONS.map(r => (
                <button
                  key={r}
                  onClick={() => setReason(r)}
                  className={`px-3 py-1.5 rounded-lg text-sm font-medium transition-all border ${reason === r ? 'bg-[#5B6DC4] text-white border-stone-900 dark:border-stone-100' : 'bg-white dark:bg-stone-700 text-stone-600 dark:text-stone-300 border-stone-300 dark:border-stone-600 hover:border-stone-400'}`}
                >
                  {r}
                </button>
              ))}
            </div>
          </div>
          
          <div>
            <label className="text-xs font-semibold text-stone-700 dark:text-stone-300 uppercase tracking-wide">Why pass?</label>
            <p className="text-xs text-stone-400 dark:text-stone-500 mt-1 mb-2">This note is immutable and helps you learn from outcomes.</p>
            <textarea 
              value={whyPass}
              onChange={e => setWhyPass(e.target.value)}
              placeholder="One sentence capturing why you passed..."
              rows={2}
              className="w-full p-3 bg-white dark:bg-stone-700 border border-stone-300 dark:border-stone-600 rounded-xl text-sm text-stone-900 dark:text-stone-100 placeholder-stone-400 resize-none"
            />
          </div>
        </div>
        
        <div className="flex gap-3 mt-6">
          <button onClick={onClose} className="flex-1 py-3 text-sm font-medium text-stone-600 dark:text-stone-400 hover:bg-stone-100 dark:hover:bg-stone-700 rounded-xl transition-colors">
            Cancel
          </button>
          <button 
            onClick={() => canConfirm && onConfirm({ reason, whyPass })}
            disabled={!canConfirm}
            className={`flex-1 py-3 text-sm font-bold rounded-xl transition-colors ${canConfirm ? 'bg-stone-500 text-white hover:bg-stone-600' : 'bg-stone-200 dark:bg-stone-700 text-stone-400 cursor-not-allowed'}`}
          >
            Pass
          </button>
        </div>
      </div>
    </div>
  );
};

// Settings Page Component
const SettingsPage = ({ settings, onUpdate, onClose }) => {
  const [localSettings, setLocalSettings] = useState(settings);
  const [activeSection, setActiveSection] = useState('profile');

  const updateLocal = (section, field, value) => {
    setLocalSettings(prev => ({
      ...prev,
      [section]: typeof prev[section] === 'object' ? { ...prev[section], [field]: value } : value
    }));
  };

  const handleSave = () => {
    onUpdate(localSettings);
    onClose();
  };

  const sections = [
    { id: 'profile', label: 'Profile', icon: <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg> },
    { id: 'account', label: 'Account Type', icon: <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg> },
    { id: 'notifications', label: 'Notifications', icon: <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 0 1-3.46 0"/></svg> },
    { id: 'appearance', label: 'Appearance', icon: <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="5"/><line x1="12" y1="1" x2="12" y2="3"/><line x1="12" y1="21" x2="12" y2="23"/><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/><line x1="1" y1="12" x2="3" y2="12"/><line x1="21" y1="12" x2="23" y2="12"/><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"/></svg> },
    { id: 'archive', label: 'Archive', icon: <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="21 8 21 21 3 21 3 8"/><rect x="1" y="3" width="22" height="5"/><line x1="10" y1="12" x2="14" y2="12"/></svg> },
    { id: 'data', label: 'Data & Privacy', icon: <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg> },
  ];

  const accountTypes = ['Solo angel', 'Syndicate lead', 'Scout / advisor', 'Micro-fund GP'];
  const timezones = ['America/New_York', 'America/Chicago', 'America/Denver', 'America/Los_Angeles', 'Europe/London', 'Europe/Paris', 'Asia/Tokyo'];

  // Determine if dark mode should be active
  const isDark = localSettings.appearance === 'dark' || 
    (localSettings.appearance === 'auto' && typeof window !== 'undefined' && window.matchMedia('(prefers-color-scheme: dark)').matches);

  return (
    <div 
      className="min-h-screen"
      style={{ 
        backgroundColor: isDark ? '#1c1917' : '#fafaf9',
        color: isDark ? '#fafaf9' : '#1c1917'
      }}
    >
      <header 
        className="sticky top-0 z-30 backdrop-blur-lg px-4 pt-4 pb-3"
        style={{ 
          backgroundColor: isDark ? 'rgba(28, 25, 23, 0.9)' : 'rgba(250, 250, 249, 0.9)',
          borderBottom: isDark ? '1px solid #44403c' : '1px solid #e7e5e4'
        }}
      >
        <div className="flex items-center justify-between">
          <button onClick={onClose} className="flex items-center gap-1" style={{ color: isDark ? '#a8a29e' : '#78716c' }}>
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="15 18 9 12 15 6"/></svg>
            <span className="text-sm">Back</span>
          </button>
          <button onClick={handleSave} className="px-3 py-1.5 text-white text-sm font-medium rounded-lg" style={{ backgroundColor: '#5B6DC4' }}>
            Save
          </button>
        </div>
        <h1 className="text-xl font-bold mt-3" style={{ color: isDark ? '#fafaf9' : '#1c1917' }}>Settings</h1>
      </header>

      <div className="flex">
        {/* Sidebar */}
        <nav 
          className="w-48 p-4 min-h-[calc(100vh-80px)]"
          style={{ borderRight: isDark ? '1px solid #44403c' : '1px solid #e7e5e4' }}
        >
          {sections.map(s => (
            <button
              key={s.id}
              onClick={() => setActiveSection(s.id)}
              className="w-full flex items-center gap-2 px-3 py-2 rounded-lg text-sm mb-1 transition-colors"
              style={{
                backgroundColor: activeSection === s.id ? (isDark ? '#44403c' : '#e7e5e4') : 'transparent',
                color: activeSection === s.id ? (isDark ? '#fafaf9' : '#1c1917') : (isDark ? '#a8a29e' : '#57534e')
              }}
            >
              {s.icon}
              {s.label}
            </button>
          ))}
        </nav>

        {/* Content */}
        <main className="flex-1 p-6 max-w-xl">
          {activeSection === 'profile' && (
            <div className="space-y-4">
              <h2 className="text-lg font-semibold mb-4" style={{ color: isDark ? '#fafaf9' : '#1c1917' }}>Profile</h2>
              <div>
                <label className="text-sm" style={{ color: isDark ? '#a8a29e' : '#57534e' }}>Name</label>
                <input 
                  type="text" 
                  value={localSettings.profile?.name || ''} 
                  onChange={e => updateLocal('profile', 'name', e.target.value)}
                  className="w-full mt-1 p-3 rounded-lg text-sm"
                  style={{ 
                    border: isDark ? '1px solid #57534e' : '1px solid #e7e5e4',
                    backgroundColor: isDark ? '#292524' : 'white',
                    color: isDark ? '#fafaf9' : '#1c1917'
                  }}
                  placeholder="Your name"
                />
              </div>
              <div>
                <label className="text-sm" style={{ color: isDark ? '#a8a29e' : '#57534e' }}>Email</label>
                <input 
                  type="email" 
                  value={localSettings.profile?.email || ''} 
                  onChange={e => updateLocal('profile', 'email', e.target.value)}
                  className="w-full mt-1 p-3 rounded-lg text-sm"
                  style={{ 
                    border: isDark ? '1px solid #57534e' : '1px solid #e7e5e4',
                    backgroundColor: isDark ? '#292524' : 'white',
                    color: isDark ? '#fafaf9' : '#1c1917'
                  }}
                  placeholder="you@email.com"
                />
              </div>
              <div className="relative">
                <label className="text-sm" style={{ color: isDark ? '#a8a29e' : '#57534e' }}>Timezone</label>
                <select 
                  value={localSettings.profile?.timezone || 'America/New_York'} 
                  onChange={e => updateLocal('profile', 'timezone', e.target.value)}
                  className="w-full mt-1 p-3 pr-10 rounded-lg text-sm appearance-none cursor-pointer"
                  style={{ 
                    border: isDark ? '1px solid #57534e' : '1px solid #e7e5e4',
                    backgroundColor: isDark ? '#292524' : 'white',
                    color: isDark ? '#fafaf9' : '#1c1917'
                  }}
                >
                  {timezones.map(tz => <option key={tz} value={tz}>{tz.replace('_', ' ')}</option>)}
                </select>
                <svg className="absolute right-3 top-[42px] pointer-events-none" style={{ color: isDark ? '#78716c' : '#a8a29e' }} width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="6 9 12 15 18 9"/></svg>
              </div>
            </div>
          )}

          {activeSection === 'account' && (
            <div className="space-y-4">
              <h2 className="text-lg font-semibold mb-4" style={{ color: isDark ? '#fafaf9' : '#1c1917' }}>Account Type</h2>
              <p className="text-sm mb-4" style={{ color: isDark ? '#a8a29e' : '#78716c' }}>This adjusts default copy and workflow suggestions.</p>
              <div className="space-y-2">
                {accountTypes.map(type => (
                  <label 
                    key={type} 
                    className="flex items-center gap-3 p-3 rounded-lg cursor-pointer"
                    style={{ 
                      border: isDark ? '1px solid #57534e' : '1px solid #e7e5e4',
                      color: isDark ? '#fafaf9' : '#1c1917'
                    }}
                  >
                    <input 
                      type="radio" 
                      name="accountType" 
                      checked={localSettings.accountType === type}
                      onChange={() => setLocalSettings(prev => ({ ...prev, accountType: type }))}
                      className="w-4 h-4"
                    />
                    <span className="text-sm" style={{ color: isDark ? '#fafaf9' : '#1c1917' }}>{type}</span>
                  </label>
                ))}
              </div>
            </div>
          )}

          {activeSection === 'notifications' && (
            <div className="space-y-4">
              <h2 className="text-lg font-semibold mb-4" style={{ color: isDark ? '#fafaf9' : '#1c1917' }}>Notifications</h2>
              <label 
                className="flex items-center justify-between p-3 rounded-lg"
                style={{ border: isDark ? '1px solid #57534e' : '1px solid #e7e5e4' }}
              >
                <div>
                  <span className="text-sm" style={{ color: isDark ? '#fafaf9' : '#1c1917' }}>Push notifications</span>
                  <p className="text-xs" style={{ color: isDark ? '#a8a29e' : '#78716c' }}>Receive reminders on your device</p>
                </div>
                <button 
                  onClick={() => updateLocal('notifications', 'push', !localSettings.notifications?.push)}
                  className="w-12 h-6 rounded-full transition-colors"
                  style={{ backgroundColor: localSettings.notifications?.push ? '#10b981' : (isDark ? '#57534e' : '#d6d3d1') }}
                >
                  <span 
                    className="block w-5 h-5 bg-white rounded-full shadow transition-transform"
                    style={{ transform: localSettings.notifications?.push ? 'translateX(24px)' : 'translateX(2px)' }}
                  />
                </button>
              </label>
              <div className="relative">
                <label className="text-sm" style={{ color: isDark ? '#a8a29e' : '#57534e' }}>Reminder frequency</label>
                <select 
                  value={localSettings.notifications?.reminderFrequency || 'daily'} 
                  onChange={e => updateLocal('notifications', 'reminderFrequency', e.target.value)}
                  className="w-full mt-1 p-3 pr-10 rounded-lg text-sm appearance-none cursor-pointer"
                  style={{ 
                    border: isDark ? '1px solid #57534e' : '1px solid #e7e5e4',
                    backgroundColor: isDark ? '#292524' : 'white',
                    color: isDark ? '#fafaf9' : '#1c1917'
                  }}
                >
                  <option value="realtime">Real-time</option>
                  <option value="daily">Daily digest</option>
                  <option value="weekly">Weekly digest</option>
                </select>
                <svg className="absolute right-3 top-[42px] pointer-events-none" style={{ color: isDark ? '#78716c' : '#a8a29e' }} width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="6 9 12 15 18 9"/></svg>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="text-sm" style={{ color: isDark ? '#a8a29e' : '#57534e' }}>Quiet hours start</label>
                  <input 
                    type="time" 
                    value={localSettings.notifications?.quietHoursStart || '22:00'} 
                    onChange={e => updateLocal('notifications', 'quietHoursStart', e.target.value)}
                    className="w-full mt-1 p-3 rounded-lg text-sm"
                    style={{ 
                      border: isDark ? '1px solid #57534e' : '1px solid #e7e5e4',
                      backgroundColor: isDark ? '#292524' : 'white',
                      color: isDark ? '#fafaf9' : '#1c1917'
                    }}
                  />
                </div>
                <div>
                  <label className="text-sm" style={{ color: isDark ? '#a8a29e' : '#57534e' }}>Quiet hours end</label>
                  <input 
                    type="time" 
                    value={localSettings.notifications?.quietHoursEnd || '08:00'} 
                    onChange={e => updateLocal('notifications', 'quietHoursEnd', e.target.value)}
                    className="w-full mt-1 p-3 rounded-lg text-sm"
                    style={{ 
                      border: isDark ? '1px solid #57534e' : '1px solid #e7e5e4',
                      backgroundColor: isDark ? '#292524' : 'white',
                      color: isDark ? '#fafaf9' : '#1c1917'
                    }}
                  />
                </div>
              </div>
            </div>
          )}

          {activeSection === 'appearance' && (
            <div className="space-y-6">
              <h2 className="text-lg font-semibold mb-4" style={{ color: isDark ? '#fafaf9' : '#1c1917' }}>Appearance</h2>
              <div className="grid grid-cols-3 gap-3">
                {['light', 'dark', 'auto'].map(mode => (
                  <button
                    key={mode}
                    onClick={() => setLocalSettings(prev => ({ ...prev, appearance: mode }))}
                    className="p-4 rounded-xl text-center transition-all"
                    style={{
                      border: localSettings.appearance === mode ? '2px solid #5B6DC4' : (isDark ? '1px solid #57534e' : '1px solid #e7e5e4'),
                      backgroundColor: localSettings.appearance === mode ? 'rgba(91, 109, 196, 0.1)' : 'transparent'
                    }}
                  >
                    <div 
                      className="w-10 h-10 mx-auto mb-2 rounded-lg flex items-center justify-center"
                      style={{
                        backgroundColor: mode === 'light' ? '#fef3c7' : mode === 'dark' ? '#e7e5e4' : 'linear-gradient(135deg, #fef3c7, #e0e7ff)',
                        background: mode === 'auto' ? 'linear-gradient(135deg, #fef3c7, #e0e7ff)' : undefined,
                        border: mode === 'light' ? '1px solid #fcd34d' : mode === 'dark' ? '1px solid #a8a29e' : '1px solid #c7d2fe'
                      }}
                    >
                      {mode === 'light' && <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#f59e0b" strokeWidth="2"><circle cx="12" cy="12" r="5"/><line x1="12" y1="1" x2="12" y2="3"/><line x1="12" y1="21" x2="12" y2="23"/><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/><line x1="1" y1="12" x2="3" y2="12"/><line x1="21" y1="12" x2="23" y2="12"/><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"/></svg>}
                      {mode === 'dark' && <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#1c1917" strokeWidth="2"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>}
                      {mode === 'auto' && <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#5B6DC4" strokeWidth="2"><circle cx="12" cy="12" r="4"/><path d="M12 2v2"/><path d="M12 20v2"/><path d="M4.93 4.93l1.41 1.41"/><path d="M17.66 17.66l1.41 1.41"/><path d="M2 12h2"/><path d="M20 12h2"/><path d="M6.34 17.66l-1.41 1.41"/><path d="M19.07 4.93l-1.41 1.41"/></svg>}
                    </div>
                    <span 
                      className="text-sm font-medium capitalize"
                      style={{ color: localSettings.appearance === mode ? (isDark ? '#fafaf9' : '#1c1917') : (isDark ? '#a8a29e' : '#57534e') }}
                    >
                      {mode === 'auto' ? 'System' : mode}
                    </span>
                  </button>
                ))}
              </div>
              
              <p className="text-sm" style={{ color: isDark ? '#a8a29e' : '#78716c' }}>
                {localSettings.appearance === 'auto' ? 'Theme will match your system preferences.' : `${localSettings.appearance === 'light' ? 'Light' : 'Dark'} mode will be used regardless of system settings.`}
              </p>
              
              <div className="flex gap-3 pt-2">
                <button
                  onClick={() => {
                    // Apply theme immediately without closing settings
                    onUpdate({ ...localSettings });
                  }}
                  className="flex-1 px-4 py-2.5 text-sm font-semibold rounded-lg transition-colors hover:opacity-80"
                  style={{ 
                    border: '2px solid #5B6DC4',
                    color: '#5B6DC4',
                    backgroundColor: 'transparent'
                  }}
                >
                  Apply
                </button>
                <button
                  onClick={() => {
                    onUpdate({ ...localSettings });
                    onClose();
                  }}
                  className="flex-1 px-4 py-2.5 text-sm font-semibold rounded-lg transition-colors hover:opacity-90"
                  style={{ 
                    backgroundColor: '#5B6DC4',
                    color: 'white'
                  }}
                >
                  Save & Close
                </button>
              </div>
            </div>
          )}

          {activeSection === 'archive' && (
            <div className="space-y-4">
              <h2 className="text-lg font-semibold mb-4" style={{ color: isDark ? '#fafaf9' : '#1c1917' }}>Passed Deals</h2>
              <p className="text-sm mb-4" style={{ color: isDark ? '#a8a29e' : '#78716c' }}>Deals you've passed on are archived here for reference.</p>
              <div className="text-center py-8" style={{ color: isDark ? '#78716c' : '#a8a29e' }}>
                <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className="mx-auto mb-2 opacity-50"><polyline points="21 8 21 21 3 21 3 8"/><rect x="1" y="3" width="22" height="5"/><line x1="10" y1="12" x2="14" y2="12"/></svg>
                <p className="text-sm">Passed deals will appear here</p>
              </div>
            </div>
          )}

          {activeSection === 'data' && (
            <div className="space-y-4">
              <h2 className="text-lg font-semibold mb-4" style={{ color: isDark ? '#fafaf9' : '#1c1917' }}>Data & Privacy</h2>
              <button 
                className="w-full p-3 rounded-lg text-left transition-colors"
                style={{ 
                  border: isDark ? '1px solid #57534e' : '1px solid #e7e5e4',
                  backgroundColor: 'transparent'
                }}
              >
                <span className="text-sm" style={{ color: isDark ? '#fafaf9' : '#1c1917' }}>Export all data</span>
                <p className="text-xs" style={{ color: isDark ? '#a8a29e' : '#78716c' }}>Download a copy of your deals and settings</p>
              </button>
              <button 
                className="w-full p-3 rounded-lg text-left transition-colors"
                style={{ 
                  border: isDark ? '1px solid #7f1d1d' : '1px solid #fecaca',
                  backgroundColor: 'transparent'
                }}
              >
                <span className="text-sm" style={{ color: isDark ? '#f87171' : '#dc2626' }}>Delete account</span>
                <p className="text-xs" style={{ color: isDark ? '#a8a29e' : '#78716c' }}>Permanently remove all data</p>
              </button>
            </div>
          )}
        </main>
      </div>
    </div>
  );
};

// Dashboard Page Component
const DashboardPage = ({ deals, onClose }) => {
  const [viewBy, setViewBy] = useState('industry'); // 'industry' | 'stage' | 'source' | 'check'
  const [showDiscipline, setShowDiscipline] = useState(false);
  const [showBeliefs, setShowBeliefs] = useState(false);
  const [showTimeView, setShowTimeView] = useState(false);
  
  // Calculate all deal categories
  const portfolioDeals = deals.filter(d => d.status === 'invested');
  const deferredDeals = deals.filter(d => d.status === 'deferred');
  const passedDeals = deals.filter(d => d.status === 'passed');
  
  // Total capital deployed
  const totalCapital = portfolioDeals.reduce((sum, deal) => {
    const amount = deal.investment?.amount || 0;
    return sum + (typeof amount === 'string' ? parseFloat(amount) || 0 : amount);
  }, 0);
  
  // Average check size
  const avgCheckSize = portfolioDeals.length > 0 ? totalCapital / portfolioDeals.length : 0;
  
  // Format currency
  const fmtCurrency = (amount) => {
    if (amount >= 1000000) return `$${(amount / 1000000).toFixed(1)}M`;
    if (amount >= 1000) return `$${(amount / 1000).toFixed(0)}K`;
    return `$${amount.toLocaleString()}`;
  };
  
  // Colors
  const industryColors = {
    'AI/ML': '#8B5CF6', 'Fintech': '#10B981', 'HealthTech': '#F59E0B',
    'DevTools': '#3B82F6', 'Security': '#EF4444', 'Analytics': '#EC4899',
    'SaaS': '#06B6D4', 'Other': '#78716C'
  };
  
  const stageColors = {
    'pre-seed': '#F59E0B', 'seed': '#10B981', 'series-a': '#3B82F6',
    'series-b': '#8B5CF6', 'growth': '#EC4899', 'Unknown': '#78716C'
  };
  
  const sourceColors = {
    'Warm intro': '#10B981', 'Cold inbound': '#3B82F6', 'Syndicate': '#8B5CF6',
    'Event': '#F59E0B', 'Other': '#78716C'
  };
  
  const checkColors = {
    '<$25K': '#78716C', '$25-50K': '#5B6DC4', '$50-100K': '#10B981', '$100K+': '#8B5CF6'
  };
  
  const stageLabels = {
    'pre-seed': 'Pre-seed', 'seed': 'Seed', 'series-a': 'Series A',
    'series-b': 'Series B', 'growth': 'Growth'
  };
  
  // === BREAKDOWNS ===
  
  const industryBreakdown = portfolioDeals.reduce((acc, deal) => {
    const key = deal.industry || 'Other';
    if (!acc[key]) acc[key] = { count: 0, amount: 0, target: null };
    acc[key].count += 1;
    acc[key].amount += deal.investment?.amount || 0;
    // Simulated targets
    if (key === 'DevTools') acc[key].target = 40;
    if (key === 'Analytics') acc[key].target = 30;
    return acc;
  }, {});
  
  const stageBreakdown = portfolioDeals.reduce((acc, deal) => {
    const key = deal.stage || 'Unknown';
    if (!acc[key]) acc[key] = { count: 0, amount: 0, target: null };
    acc[key].count += 1;
    acc[key].amount += deal.investment?.amount || 0;
    // Simulated targets
    if (key === 'seed') acc[key].target = 50;
    return acc;
  }, {});
  
  const sourceBreakdown = portfolioDeals.reduce((acc, deal) => {
    const key = deal.source || deal.investment?.source || 'Other';
    if (!acc[key]) acc[key] = { count: 0, amount: 0 };
    acc[key].count += 1;
    acc[key].amount += deal.investment?.amount || 0;
    return acc;
  }, {});
  
  const checkBreakdown = portfolioDeals.reduce((acc, deal) => {
    const amount = deal.investment?.amount || 0;
    let band = '<$25K';
    if (amount >= 100000) band = '$100K+';
    else if (amount >= 50000) band = '$50-100K';
    else if (amount >= 25000) band = '$25-50K';
    if (!acc[band]) acc[band] = { count: 0, amount: 0 };
    acc[band].count += 1;
    acc[band].amount += amount;
    return acc;
  }, {});
  
  // Get current breakdown
  const getBreakdown = () => {
    if (viewBy === 'stage') return { data: stageBreakdown, colors: stageColors, labels: stageLabels };
    if (viewBy === 'source') return { data: sourceBreakdown, colors: sourceColors, labels: {} };
    if (viewBy === 'check') return { data: checkBreakdown, colors: checkColors, labels: {} };
    return { data: industryBreakdown, colors: industryColors, labels: {} };
  };
  
  const breakdown = getBreakdown();
  
  // === TIME-BASED BREAKDOWN (for stacked bar over time) ===
  const getTimeBreakdown = () => {
    // Group investments by half-year periods
    const periods = {};
    const colors = breakdown.colors;
    const labels = breakdown.labels;
    
    portfolioDeals.forEach(deal => {
      const date = new Date(deal.investment?.date || deal.statusEnteredAt || deal.createdAt);
      const year = date.getFullYear();
      const half = date.getMonth() < 6 ? 'H1' : 'H2';
      const periodKey = `${half} ${year}`;
      
      if (!periods[periodKey]) {
        periods[periodKey] = { total: 0, breakdown: {}, timestamp: date.getTime() };
      }
      
      // Get the category based on current view
      let category;
      if (viewBy === 'stage') category = deal.stage || 'unknown';
      else if (viewBy === 'source') category = deal.source || deal.investment?.source || 'Other';
      else if (viewBy === 'check') {
        const amount = deal.investment?.amount || 0;
        if (amount >= 100000) category = '$100K+';
        else if (amount >= 50000) category = '$50-100K';
        else if (amount >= 25000) category = '$25-50K';
        else category = '<$25K';
      }
      else category = deal.industry || 'Other';
      
      const amount = deal.investment?.amount || 0;
      periods[periodKey].total += amount;
      periods[periodKey].breakdown[category] = (periods[periodKey].breakdown[category] || 0) + amount;
    });
    
    // Sort by time and convert to percentages
    return Object.entries(periods)
      .sort((a, b) => a[1].timestamp - b[1].timestamp)
      .slice(-4) // Last 4 periods max
      .map(([period, data]) => ({
        period,
        total: data.total,
        segments: Object.entries(data.breakdown).map(([cat, amount]) => ({
          category: labels[cat] || cat,
          percentage: data.total > 0 ? Math.round((amount / data.total) * 100) : 0,
          color: colors[cat] || '#78716C'
        })).sort((a, b) => b.percentage - a.percentage)
      }));
  };
  
  const timeBreakdown = getTimeBreakdown();
  
  // === ALIGNMENT & TENSION (only show exceptions, soft framing) ===
  
  const getTensions = () => {
    const tensions = [];
    
    // Check for overweight allocations
    Object.entries(industryBreakdown).forEach(([industry, data]) => {
      if (data.target && totalCapital > 0) {
        const pct = Math.round((data.amount / totalCapital) * 100);
        const diff = pct - data.target;
        if (diff > 15) {
          tensions.push({
            text: `${industry} exposure is trending above target (+${diff}%)`,
            type: 'overweight'
          });
        }
      }
    });
    
    // Check for underweight stages
    Object.entries(stageBreakdown).forEach(([stage, data]) => {
      if (data.target && totalCapital > 0) {
        const pct = Math.round((data.amount / totalCapital) * 100);
        if (pct < data.target - 20) {
          tensions.push({
            text: `${stageLabels[stage] || stage} investments haven't materialized yet`,
            type: 'underweight'
          });
        }
      }
    });
    
    // Check for concentration
    const topIndustry = Object.entries(industryBreakdown).sort((a, b) => b[1].amount - a[1].amount)[0];
    if (topIndustry && totalCapital > 0) {
      const pct = Math.round((topIndustry[1].amount / totalCapital) * 100);
      if (pct > 60) {
        tensions.push({
          text: `${topIndustry[0]} now represents ${pct}% of deployed capital`,
          type: 'concentration'
        });
      }
    }
    
    return tensions.slice(0, 3); // Max 3
  };
  
  const tensions = getTensions();
  
  // === MISSED SIGNALS (gentle framing) ===
  
  const getMissedSignals = () => {
    const signals = [];
    
    // Deferred that showed activity
    deferredDeals.forEach(deal => {
      const deferralTime = new Date(deal.statusEnteredAt || Date.now()).getTime();
      const hasNewSignals = deal.milestones?.some(m => 
        new Date(m.date).getTime() > deferralTime && 
        (m.type === 'fundraising' || m.type === 'growth')
      );
      if (hasNewSignals) {
        signals.push({
          company: deal.companyName,
          context: 'Showed fundraising activity since you deferred',
          type: 'deferred'
        });
      }
    });
    
    // Passed that raised (would come from tracking)
    passedDeals.forEach(deal => {
      if (deal.laterRaised) {
        signals.push({
          company: deal.companyName,
          context: 'Raised funding after you passed',
          type: 'passed'
        });
      }
    });
    
    return signals.slice(0, 2); // Max 2
  };
  
  const missedSignals = getMissedSignals();
  
  // === BELIEFS UNDER STRESS ===
  
  const getBeliefs = () => {
    const beliefs = [];
    const passReasons = {};
    
    passedDeals.forEach(d => {
      const reasons = d.passed?.reasons || [];
      reasons.forEach(r => {
        if (!passReasons[r]) passReasons[r] = { count: 0, deals: [] };
        passReasons[r].count += 1;
        passReasons[r].deals.push(d.companyName);
      });
    });
    
    Object.entries(passReasons)
      .filter(([_, data]) => data.count >= 2)
      .slice(0, 3)
      .forEach(([reason, data]) => {
        beliefs.push({
          belief: reason,
          frequency: `Used ${data.count}x`,
          outcome: 'Tracking outcomes...'
        });
      });
    
    return beliefs;
  };
  
  const beliefs = getBeliefs();
  
  // === CONTINUITY SIGNALS (what's changed, not what to do) ===
  
  const getContinuitySignals = () => {
    const signals = [];
    
    // For deferred deals: check for new activity since deferral
    deferredDeals.forEach(deal => {
      const deferralTime = new Date(deal.statusEnteredAt || Date.now()).getTime();
      const newMilestones = deal.milestones?.filter(m => 
        new Date(m.date).getTime() > deferralTime
      ) || [];
      
      if (newMilestones.length > 0) {
        const deferReason = deal.deferData?.reason || deal.watching?.trigger || 'timing';
        signals.push({
          type: 'deferred',
          company: deal.companyName,
          headline: `${deal.companyName} has shown activity since you deferred`,
          context: `You deferred citing "${deferReason}." New: ${newMilestones.map(m => m.description || m.type).slice(0, 2).join(', ')}.`,
          signalCount: newMilestones.length,
          deal
        });
      }
    });
    
    // For invested companies: check for follow-on signals
    portfolioDeals.forEach(deal => {
      const investTime = new Date(deal.investment?.date || deal.statusEnteredAt || Date.now()).getTime();
      const followOnSignals = deal.milestones?.filter(m => 
        new Date(m.date).getTime() > investTime && 
        (m.type === 'fundraising' || m.type === 'growth' || m.type === 'partnership')
      ) || [];
      
      // Also check monitoring data
      const followOns = deal.monitoring?.followOns || [];
      const totalSignals = followOnSignals.length + followOns.length;
      
      if (totalSignals > 0) {
        const signalDescriptions = [
          ...followOnSignals.map(m => m.description || m.type),
          ...followOns.map(f => f.round || f.description || 'follow-on activity')
        ].slice(0, 2);
        
        signals.push({
          type: 'invested',
          company: deal.companyName,
          headline: `${deal.companyName} showing follow-on activity`,
          context: `Since your investment: ${signalDescriptions.join(', ')}.`,
          signalCount: totalSignals,
          deal
        });
      }
    });
    
    // For passed deals: check if they later raised (would come from tracking)
    passedDeals.forEach(deal => {
      if (deal.laterRaised || deal.milestones?.some(m => m.type === 'fundraising')) {
        const passReason = deal.passed?.reasons?.[0] || deal.passed?.whyPass?.slice(0, 50) || 'not a fit';
        const passDate = deal.statusEnteredAt || deal.passed?.passedAt;
        const monthsAgo = passDate ? Math.round((Date.now() - new Date(passDate).getTime()) / (30 * 86400000)) : null;
        const fundingSignals = deal.milestones?.filter(m => m.type === 'fundraising').length || 1;
        
        signals.push({
          type: 'passed',
          company: deal.companyName,
          headline: `${deal.companyName} raised funding${monthsAgo ? ` ${monthsAgo}mo` : ''} after you passed`,
          context: `Your pass reason: "${passReason}."`,
          signalCount: fundingSignals,
          deal
        });
      }
    });
    
    // For screening deals: check for time-based signals
    const screeningDeals = deals.filter(d => d.status === 'screening');
    screeningDeals.forEach(deal => {
      const createdTime = new Date(deal.createdAt || Date.now()).getTime();
      const daysInScreening = Math.round((Date.now() - createdTime) / 86400000);
      
      if (daysInScreening > 30) {
        signals.push({
          type: 'screening',
          company: deal.companyName,
          headline: `${deal.companyName} in screening for ${daysInScreening} days`,
          context: 'Longer evaluation periods can signal uncertainty worth resolving.',
          signalCount: 1,
          deal
        });
      }
    });
    
    return signals.slice(0, 5); // Max 5 signals
  };
  
  const continuitySignals = getContinuitySignals();
  
  // === REASONING PATTERNS (adapts to current view) ===
  
  const getReasoningPatterns = () => {
    const patterns = [];
    
    // === INDUSTRY-SPECIFIC PATTERNS (when viewing by industry) ===
    if (viewBy === 'industry') {
      // Find best/worst performing industries by follow-on signals
      const industryPerformance = {};
      portfolioDeals.forEach(d => {
        const ind = d.industry || 'Other';
        if (!industryPerformance[ind]) industryPerformance[ind] = { total: 0, withSignals: 0 };
        industryPerformance[ind].total++;
        if (d.milestones?.some(m => m.type === 'fundraising' || m.type === 'growth') || d.monitoring?.followOns?.length > 0) {
          industryPerformance[ind].withSignals++;
        }
      });
      
      const industries = Object.entries(industryPerformance).filter(([_, v]) => v.total >= 1);
      const withSignals = industries.filter(([_, v]) => v.withSignals > 0);
      if (withSignals.length > 0) {
        const best = withSignals.sort((a, b) => (b[1].withSignals / b[1].total) - (a[1].withSignals / a[1].total))[0];
        patterns.push({
          text: `${best[0]} investments showing strongest early signals (${best[1].withSignals} of ${best[1].total} with follow-on activity)`,
          type: 'positive'
        });
      }
      
      // Industry concentration observation
      const topIndustry = Object.entries(industryBreakdown).sort((a, b) => b[1].amount - a[1].amount)[0];
      if (topIndustry && totalCapital > 0) {
        const pct = Math.round((topIndustry[1].amount / totalCapital) * 100);
        if (pct > 50) {
          patterns.push({
            text: `${pct}% concentration in ${topIndustry[0]} — your thesis appears focused here`,
            type: 'insight'
          });
        }
      }
      
      // Passed by industry
      const passedByIndustry = {};
      passedDeals.forEach(d => {
        const ind = d.industry || 'Other';
        passedByIndustry[ind] = (passedByIndustry[ind] || 0) + 1;
      });
      const mostPassedIndustry = Object.entries(passedByIndustry).sort((a, b) => b[1] - a[1])[0];
      if (mostPassedIndustry && mostPassedIndustry[1] >= 2) {
        patterns.push({
          text: `Most passes in ${mostPassedIndustry[0]} (${mostPassedIndustry[1]}) — consistent filter or missed category?`,
          type: 'learning'
        });
      }
    }
    
    // === STAGE-SPECIFIC PATTERNS (when viewing by stage) ===
    if (viewBy === 'stage') {
      // Stage performance comparison
      const stagePerformance = {};
      portfolioDeals.forEach(d => {
        const stage = d.stage || 'unknown';
        if (!stagePerformance[stage]) stagePerformance[stage] = { total: 0, withSignals: 0, avgHoldTime: 0 };
        stagePerformance[stage].total++;
        if (d.milestones?.some(m => m.type === 'fundraising' || m.type === 'growth') || d.monitoring?.followOns?.length > 0) {
          stagePerformance[stage].withSignals++;
        }
      });
      
      const stages = Object.entries(stagePerformance).filter(([_, v]) => v.total >= 1);
      if (stages.length >= 2) {
        const sorted = stages.sort((a, b) => (b[1].withSignals / b[1].total) - (a[1].withSignals / a[1].total));
        const best = sorted[0];
        if (best[1].withSignals > 0) {
          patterns.push({
            text: `${stageLabels[best[0]] || best[0]} investments showing most follow-on activity (${best[1].withSignals} of ${best[1].total})`,
            type: 'positive'
          });
        }
      }
      
      // Early stage vs later stage pass rate
      const earlyStages = ['pre-seed', 'seed'];
      const laterStages = ['series-a', 'series-b', 'growth'];
      const earlyPassed = passedDeals.filter(d => earlyStages.includes(d.stage)).length;
      const laterPassed = passedDeals.filter(d => laterStages.includes(d.stage)).length;
      if (earlyPassed > 0 && laterPassed > 0) {
        if (earlyPassed > laterPassed * 2) {
          patterns.push({
            text: `Passing more often on early-stage (${earlyPassed}) than later-stage (${laterPassed}) deals`,
            type: 'neutral'
          });
        }
      }
      
      // Deferred by stage
      const deferredByStage = {};
      deferredDeals.forEach(d => {
        const stage = d.stage || 'unknown';
        deferredByStage[stage] = (deferredByStage[stage] || 0) + 1;
      });
      const mostDeferredStage = Object.entries(deferredByStage).sort((a, b) => b[1] - a[1])[0];
      if (mostDeferredStage && mostDeferredStage[1] >= 2) {
        patterns.push({
          text: `Most deferrals at ${stageLabels[mostDeferredStage[0]] || mostDeferredStage[0]} (${mostDeferredStage[1]}) — timing uncertainty at this stage?`,
          type: 'learning'
        });
      }
    }
    
    // === SOURCE-SPECIFIC PATTERNS (when viewing by source) ===
    if (viewBy === 'source') {
      // Source performance
      const sourcePerformance = {};
      portfolioDeals.forEach(d => {
        const src = d.source || d.investment?.source || 'Other';
        if (!sourcePerformance[src]) sourcePerformance[src] = { total: 0, withSignals: 0 };
        sourcePerformance[src].total++;
        if (d.milestones?.some(m => m.type === 'fundraising' || m.type === 'growth') || d.monitoring?.followOns?.length > 0) {
          sourcePerformance[src].withSignals++;
        }
      });
      
      const sources = Object.entries(sourcePerformance).filter(([_, v]) => v.total >= 1);
      if (sources.length >= 1) {
        const withSignals = sources.filter(([_, v]) => v.withSignals > 0);
        if (withSignals.length > 0) {
          const best = withSignals.sort((a, b) => (b[1].withSignals / b[1].total) - (a[1].withSignals / a[1].total))[0];
          patterns.push({
            text: `${best[0]} deals showing strongest early traction (${best[1].withSignals} of ${best[1].total})`,
            type: 'positive'
          });
        }
      }
      
      // Source concentration
      const topSource = Object.entries(sourceBreakdown).sort((a, b) => b[1].count - a[1].count)[0];
      if (topSource && portfolioDeals.length > 0) {
        const pct = Math.round((topSource[1].count / portfolioDeals.length) * 100);
        if (pct > 60) {
          patterns.push({
            text: `${pct}% of deals from ${topSource[0]} — consider if pipeline is diversified enough`,
            type: 'insight'
          });
        }
      }
      
      // Cold vs warm comparison
      const warmDeals = portfolioDeals.filter(d => (d.source || d.investment?.source) === 'Warm intro');
      const coldDeals = portfolioDeals.filter(d => (d.source || d.investment?.source) === 'Cold inbound');
      if (warmDeals.length > 0 && coldDeals.length > 0) {
        patterns.push({
          text: `${warmDeals.length} warm intro investments vs ${coldDeals.length} cold inbound — tracking relative performance`,
          type: 'neutral'
        });
      }
    }
    
    // === CHECK SIZE PATTERNS (when viewing by check) ===
    if (viewBy === 'check') {
      // Check size vs signals
      const checkPerformance = {};
      portfolioDeals.forEach(d => {
        const amount = d.investment?.amount || 0;
        let band = '<$25K';
        if (amount >= 100000) band = '$100K+';
        else if (amount >= 50000) band = '$50-100K';
        else if (amount >= 25000) band = '$25-50K';
        if (!checkPerformance[band]) checkPerformance[band] = { total: 0, withSignals: 0 };
        checkPerformance[band].total++;
        if (d.milestones?.some(m => m.type === 'fundraising' || m.type === 'growth') || d.monitoring?.followOns?.length > 0) {
          checkPerformance[band].withSignals++;
        }
      });
      
      const checks = Object.entries(checkPerformance).filter(([_, v]) => v.total >= 1);
      const withSignals = checks.filter(([_, v]) => v.withSignals > 0);
      if (withSignals.length > 0) {
        const best = withSignals.sort((a, b) => (b[1].withSignals / b[1].total) - (a[1].withSignals / a[1].total))[0];
        patterns.push({
          text: `${best[0]} checks showing most follow-on signals (${best[1].withSignals} of ${best[1].total})`,
          type: 'positive'
        });
      }
      
      // Check size variance
      const amounts = portfolioDeals.map(d => d.investment?.amount || 0).filter(a => a > 0);
      if (amounts.length >= 2) {
        const min = Math.min(...amounts);
        const max = Math.max(...amounts);
        if (max > min * 3) {
          patterns.push({
            text: `Check sizes range from ${fmtCurrency(min)} to ${fmtCurrency(max)} — signals conviction variation or deliberate sizing`,
            type: 'insight'
          });
        }
      }
    }
    
    // === FALLBACK PATTERNS (always available) ===
    if (patterns.length === 0) {
      // Generic patterns when no view-specific patterns found
      const documentedInvestments = portfolioDeals.filter(d => d.investment?.whyYes?.length > 5);
      if (documentedInvestments.length > 0) {
        patterns.push({
          text: `${documentedInvestments.length} investment${documentedInvestments.length > 1 ? 's have' : ' has'} documented reasoning — patterns will emerge as outcomes unfold`,
          type: 'neutral'
        });
      }
      
      if (deferredDeals.length > 0) {
        const deferredWithCriteria = deferredDeals.filter(d => d.watching?.trigger?.length > 5);
        if (deferredWithCriteria.length > 0) {
          patterns.push({
            text: `${deferredWithCriteria.length} deferred deal${deferredWithCriteria.length > 1 ? 's have' : ' has'} clear revisit criteria`,
            type: 'insight'
          });
        }
      }
    }
    
    return patterns.slice(0, 3);
  };
  
  const reasoningPatterns = getReasoningPatterns();

  return (
    <div className="min-h-screen bg-stone-50 dark:bg-stone-900">
      {/* Header */}
      <header className="sticky top-0 z-30 bg-stone-50/90 dark:bg-stone-900/90 backdrop-blur-lg border-b border-stone-200 dark:border-stone-700">
        <div className="flex items-center justify-between px-6 py-4">
          <button onClick={onClose} className="flex items-center gap-1 text-stone-500 dark:text-stone-400">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="15 18 9 12 15 6"/></svg>
            <span className="text-sm">Back</span>
          </button>
          <h1 className="text-lg font-semibold text-stone-900 dark:text-stone-100">Capital & Signals</h1>
          <div className="w-12"/>
        </div>
      </header>

      <div className="p-6 space-y-6 max-w-2xl mx-auto">
        
        {/* === SECTION 1: CAPITAL REALITY === */}
        <div className="bg-white dark:bg-stone-800 rounded-2xl p-6 border border-stone-200 dark:border-stone-700">
          {/* Hero number */}
          <div className="text-center mb-6">
            <p className="text-xs text-stone-400 uppercase tracking-wide mb-1">Capital Deployed</p>
            <p className="text-4xl font-bold text-stone-900 dark:text-white">{fmtCurrency(totalCapital)}</p>
            <p className="text-sm text-stone-500 mt-1">
              {portfolioDeals.length} investments · avg {fmtCurrency(avgCheckSize)}
            </p>
          </div>
          
          {/* View toggle */}
          <div className="flex items-center justify-center gap-1 mb-5 p-1 bg-stone-100 dark:bg-stone-700 rounded-lg">
            {[
              { key: 'industry', label: 'Industry' },
              { key: 'stage', label: 'Stage' },
              { key: 'source', label: 'Source' },
              { key: 'check', label: 'Check Size' }
            ].map(v => (
              <button
                key={v.key}
                onClick={() => setViewBy(v.key)}
                className={`px-3 py-1.5 rounded-md text-xs font-medium transition-colors ${
                  viewBy === v.key
                    ? 'bg-white dark:bg-stone-600 text-stone-900 dark:text-white shadow-sm'
                    : 'text-stone-500 dark:text-stone-400'
                }`}
              >
                {v.label}
              </button>
            ))}
          </div>
          
          {/* Single chart */}
          {Object.keys(breakdown.data).length === 0 ? (
            <p className="text-sm text-stone-400 text-center py-8">No investments yet</p>
          ) : (
            <div className="space-y-3">
              {Object.entries(breakdown.data)
                .sort((a, b) => b[1].amount - a[1].amount)
                .map(([key, data]) => {
                  const pct = totalCapital > 0 ? Math.round((data.amount / totalCapital) * 100) : 0;
                  const label = breakdown.labels[key] || key;
                  const color = breakdown.colors[key] || '#78716C';
                  
                  return (
                    <div key={key}>
                      <div className="flex items-center justify-between mb-1">
                        <div className="flex items-center gap-2">
                          <span className="w-2.5 h-2.5 rounded-full" style={{ backgroundColor: color }}/>
                          <span className="text-sm text-stone-700 dark:text-stone-300">{label}</span>
                          <span className="text-xs text-stone-400">({data.count})</span>
                        </div>
                        <span className="text-sm font-medium text-stone-900 dark:text-white">{pct}%</span>
                      </div>
                      <div className="relative w-full h-2 bg-stone-100 dark:bg-stone-700 rounded-full overflow-hidden">
                        <div 
                          className="h-full rounded-full transition-all duration-500"
                          style={{ width: `${pct}%`, backgroundColor: color }}
                        />
                        {/* Target marker if exists */}
                        {data.target && (
                          <div 
                            className="absolute top-0 h-full w-0.5 bg-stone-400 dark:bg-stone-500"
                            style={{ left: `${data.target}%` }}
                          />
                        )}
                      </div>
                    </div>
                  );
                })}
            </div>
          )}
          
          {/* Time view toggle (collapsed by default) */}
          {timeBreakdown.length >= 2 && (
            <div className="mt-5 pt-4 border-t border-stone-100 dark:border-stone-700">
              <button
                onClick={() => setShowTimeView(!showTimeView)}
                className="flex items-center gap-2 text-xs text-stone-400 hover:text-stone-600 dark:hover:text-stone-300 transition-colors"
              >
                <svg 
                  width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
                  className={`transition-transform ${showTimeView ? 'rotate-180' : ''}`}
                >
                  <polyline points="6 9 12 15 18 9"/>
                </svg>
                <span>View over time</span>
              </button>
              
              {showTimeView && (
                <div className="mt-4 space-y-3">
                  <p className="text-[10px] text-stone-400 uppercase tracking-wide">Allocation by period</p>
                  {timeBreakdown.map((period, idx) => (
                    <div key={idx}>
                      <div className="flex items-center justify-between mb-1">
                        <span className="text-xs text-stone-500">{period.period}</span>
                        <span className="text-[10px] text-stone-400">{fmtCurrency(period.total)}</span>
                      </div>
                      {/* Stacked bar */}
                      <div className="w-full h-3 bg-stone-100 dark:bg-stone-700 rounded-full overflow-hidden flex">
                        {period.segments.map((seg, sIdx) => (
                          <div
                            key={sIdx}
                            className="h-full transition-all duration-500"
                            style={{ 
                              width: `${seg.percentage}%`, 
                              backgroundColor: seg.color,
                              marginLeft: sIdx > 0 ? '1px' : '0'
                            }}
                            title={`${seg.category}: ${seg.percentage}%`}
                          />
                        ))}
                      </div>
                    </div>
                  ))}
                  <p className="text-[10px] text-stone-400 italic mt-2">Shows drift as motion, not judgment</p>
                </div>
              )}
            </div>
          )}
        </div>

        {/* === SECTION 2: ALIGNMENT & TENSION === */}
        {tensions.length > 0 && (
          <div className="bg-white dark:bg-stone-800 rounded-2xl p-5 border border-stone-200 dark:border-stone-700">
            <p className="text-xs text-stone-400 uppercase tracking-wide mb-3">Where you're drifting from intent</p>
            <div className="space-y-2">
              {tensions.map((t, idx) => (
                <p key={idx} className="text-sm text-stone-600 dark:text-stone-300">
                  • {t.text}
                </p>
              ))}
            </div>
          </div>
        )}

        {/* === SECTION 3: LEARNING SIGNALS === */}
        {(missedSignals.length > 0 || beliefs.length > 0) && (
          <div className="space-y-4">
            {/* Missed signals */}
            {missedSignals.length > 0 && (
              <div className="bg-amber-50 dark:bg-amber-900/20 rounded-2xl p-5 border border-amber-200 dark:border-amber-800">
                <p className="text-xs text-amber-600 dark:text-amber-400 uppercase tracking-wide mb-3">Deals worth revisiting</p>
                <div className="space-y-3">
                  {missedSignals.map((s, idx) => (
                    <div key={idx}>
                      <p className="text-sm font-medium text-amber-800 dark:text-amber-300">{s.company}</p>
                      <p className="text-xs text-amber-600/70 dark:text-amber-400/60">{s.context}</p>
                    </div>
                  ))}
                </div>
              </div>
            )}
            
            {/* Beliefs under stress - collapsed by default */}
            {beliefs.length > 0 && (
              <div className="bg-white dark:bg-stone-800 rounded-2xl border border-stone-200 dark:border-stone-700 overflow-hidden">
                <button
                  onClick={() => setShowBeliefs(!showBeliefs)}
                  className="w-full flex items-center justify-between p-5 text-left"
                >
                  <div>
                    <p className="text-xs text-stone-400 uppercase tracking-wide">Beliefs under stress</p>
                    <p className="text-xs text-stone-500 mt-0.5">{beliefs.length} patterns being tracked</p>
                  </div>
                  <svg 
                    width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
                    className={`text-stone-400 transition-transform ${showBeliefs ? 'rotate-180' : ''}`}
                  >
                    <polyline points="6 9 12 15 18 9"/>
                  </svg>
                </button>
                {showBeliefs && (
                  <div className="px-5 pb-5 space-y-3">
                    {beliefs.map((b, idx) => (
                      <div key={idx} className="p-3 bg-stone-50 dark:bg-stone-700/50 rounded-xl">
                        <p className="text-sm text-stone-700 dark:text-stone-300">"{b.belief}"</p>
                        <p className="text-xs text-stone-400 mt-1">{b.frequency} · {b.outcome}</p>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>
        )}

        {/* === SECTION 4: WHAT'S CHANGED (Continuity Signals) === */}
        {continuitySignals.length > 0 && (
          <div className="bg-white dark:bg-stone-800 rounded-2xl p-5 border border-stone-200 dark:border-stone-700">
            <p className="text-xs text-stone-400 uppercase tracking-wide">What's changed</p>
            <p className="text-[11px] text-stone-400 mt-0.5 mb-4">Signal activity detected since your decisions</p>
            <div className="space-y-4">
              {continuitySignals.map((signal, idx) => (
                <div key={idx} className="relative">
                  <div className="flex items-start gap-3">
                    <div className={`w-2 h-2 rounded-full mt-1.5 flex-shrink-0 ${
                      signal.type === 'invested' ? 'bg-emerald-500' :
                      signal.type === 'deferred' ? 'bg-amber-500' :
                      signal.type === 'passed' ? 'bg-stone-400' :
                      'bg-blue-500'
                    }`}/>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center justify-between gap-2">
                        <p className="text-sm text-stone-800 dark:text-stone-200">{signal.headline}</p>
                        {/* Signal density indicator */}
                        <div className="flex items-center gap-0.5 flex-shrink-0">
                          {[...Array(Math.min(signal.signalCount || 1, 7))].map((_, i) => (
                            <div 
                              key={i} 
                              className={`w-1.5 h-1.5 rounded-full ${
                                signal.type === 'invested' ? 'bg-emerald-400' :
                                signal.type === 'deferred' ? 'bg-amber-400' :
                                signal.type === 'passed' ? 'bg-stone-300' :
                                'bg-blue-400'
                              }`}
                            />
                          ))}
                          {(signal.signalCount || 1) > 7 && (
                            <span className="text-[10px] text-stone-400 ml-1">+{signal.signalCount - 7}</span>
                          )}
                        </div>
                      </div>
                      <p className="text-xs text-stone-500 dark:text-stone-400 mt-1">{signal.context}</p>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Empty state when no signals */}
        {continuitySignals.length === 0 && portfolioDeals.length > 0 && (
          <div className="bg-white dark:bg-stone-800 rounded-2xl p-5 border border-stone-200 dark:border-stone-700">
            <p className="text-xs text-stone-400 uppercase tracking-wide mb-2">What's changed</p>
            <p className="text-sm text-stone-500">No new activity detected since your last review.</p>
          </div>
        )}

        {/* === HOW YOUR REASONING HAS AGED (collapsed, pattern reflection) === */}
        {(portfolioDeals.length > 0 || passedDeals.length > 0 || deferredDeals.length > 0) && (
          <div className="bg-white dark:bg-stone-800 rounded-2xl border border-stone-200 dark:border-stone-700 overflow-hidden">
            <button
              onClick={() => setShowDiscipline(!showDiscipline)}
              className="w-full flex items-center justify-between p-5 text-left"
            >
              <div>
                <p className="text-xs text-stone-400 uppercase tracking-wide">
                  {viewBy === 'industry' ? 'Industry patterns' :
                   viewBy === 'stage' ? 'Stage patterns' :
                   viewBy === 'source' ? 'Source patterns' :
                   viewBy === 'check' ? 'Check size patterns' :
                   'How your reasoning has aged'}
                </p>
                <p className="text-xs text-stone-500 mt-0.5">
                  {viewBy === 'industry' ? 'How your industry bets are tracking' :
                   viewBy === 'stage' ? 'Performance signals by investment stage' :
                   viewBy === 'source' ? 'Which deal sources are performing' :
                   viewBy === 'check' ? 'How allocation size relates to outcomes' :
                   'Patterns from your documented decisions'}
                </p>
              </div>
              <svg 
                width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
                className={`text-stone-400 transition-transform ${showDiscipline ? 'rotate-180' : ''}`}
              >
                <polyline points="6 9 12 15 18 9"/>
              </svg>
            </button>
            {showDiscipline && (
              <div className="px-5 pb-5 space-y-4">
                {/* Text patterns */}
                {reasoningPatterns.length > 0 ? (
                  <div className="space-y-3">
                    {reasoningPatterns.map((pattern, idx) => (
                      <div key={idx} className="flex items-start gap-3 p-3 bg-stone-50 dark:bg-stone-700/50 rounded-xl">
                        <div className={`w-1.5 h-1.5 rounded-full mt-2 flex-shrink-0 ${
                          pattern.type === 'positive' ? 'bg-emerald-500' :
                          pattern.type === 'learning' ? 'bg-amber-500' :
                          pattern.type === 'insight' ? 'bg-blue-500' :
                          'bg-stone-400'
                        }`}/>
                        <p className="text-sm text-stone-600 dark:text-stone-300">{pattern.text}</p>
                      </div>
                    ))}
                  </div>
                ) : (
                  <p className="text-sm text-stone-500 p-3">
                    Document your reasoning on decisions to see patterns emerge over time.
                  </p>
                )}
                
                {/* Activity Heatmap (only for industry view with enough data) */}
                {viewBy === 'industry' && portfolioDeals.length >= 2 && (
                  <div className="pt-3 border-t border-stone-100 dark:border-stone-700">
                    <p className="text-[10px] text-stone-400 uppercase tracking-wide mb-3">Signal activity by category</p>
                    <div className="space-y-2">
                      {Object.entries(industryBreakdown)
                        .sort((a, b) => b[1].count - a[1].count)
                        .slice(0, 5)
                        .map(([industry, data]) => {
                          // Count different signal types for this industry
                          const industryDeals = portfolioDeals.filter(d => (d.industry || 'Other') === industry);
                          const signals = {
                            funding: industryDeals.filter(d => d.milestones?.some(m => m.type === 'fundraising') || d.monitoring?.followOns?.length > 0).length,
                            growth: industryDeals.filter(d => d.milestones?.some(m => m.type === 'growth')).length,
                            hires: industryDeals.filter(d => d.milestones?.some(m => m.type === 'hire' || m.type === 'team')).length,
                            press: industryDeals.filter(d => d.milestones?.some(m => m.type === 'press' || m.type === 'announcement')).length
                          };
                          
                          return (
                            <div key={industry} className="flex items-center gap-3">
                              <span className="text-xs text-stone-500 w-20 truncate">{industry}</span>
                              <div className="flex gap-1">
                                {['funding', 'growth', 'hires', 'press'].map(type => (
                                  <div
                                    key={type}
                                    className={`w-4 h-4 rounded-sm ${
                                      signals[type] > 0 
                                        ? type === 'funding' ? 'bg-emerald-400' :
                                          type === 'growth' ? 'bg-blue-400' :
                                          type === 'hires' ? 'bg-violet-400' :
                                          'bg-amber-400'
                                        : 'bg-stone-100 dark:bg-stone-700'
                                    }`}
                                    title={`${type}: ${signals[type]}`}
                                  />
                                ))}
                              </div>
                              <span className="text-[10px] text-stone-400">({data.count})</span>
                            </div>
                          );
                        })}
                    </div>
                    <div className="flex items-center gap-3 mt-3 text-[9px] text-stone-400">
                      <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-sm bg-emerald-400"/> Funding</span>
                      <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-sm bg-blue-400"/> Growth</span>
                      <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-sm bg-violet-400"/> Hires</span>
                      <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-sm bg-amber-400"/> Press</span>
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>
        )}

        {/* === FOOTER === */}
        <p className="text-center text-xs text-stone-400 py-2">
          Context, not advice · Continuity, not judgment
        </p>
      </div>
    </div>
  );
};

// Attachments Component
const AttachmentsSection = ({ attachments = [], onAdd }) => {
  const typeIcons = { deck: '📊', financials: '📈', legal: '📄', update: '📬', other: '📎' };
  const typeColors = { deck: 'bg-blue-50 text-blue-700', financials: 'bg-emerald-50 text-emerald-700', legal: 'bg-amber-50 text-amber-700', update: 'bg-violet-50 text-violet-700', other: 'bg-stone-100 text-stone-600' };
  
  return (
    <Card>
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-sm font-medium text-stone-900">Attachments ({attachments.length})</h3>
        <button onClick={onAdd} className="text-xs text-[#5B6DC4] hover:underline">+ Add file</button>
      </div>
      {attachments.length === 0 ? (
        <p className="text-sm text-stone-400">No attachments yet</p>
      ) : (
        <div className="space-y-2">
          {attachments.map(att => (
            <div key={att.id} className="flex items-center justify-between p-2 bg-stone-50 rounded-lg">
              <div className="flex items-center gap-2 min-w-0">
                <span className={`w-8 h-8 rounded-lg flex items-center justify-center text-sm ${typeColors[att.type] || typeColors.other}`}>
                  {typeIcons[att.type] || typeIcons.other}
                </span>
                <div className="min-w-0">
                  <p className="text-sm font-medium text-stone-900 truncate">{att.name}</p>
                  <p className="text-xs text-stone-500">{att.size}</p>
                </div>
              </div>
              <button className="p-1 text-stone-400 hover:text-stone-600">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3"/></svg>
              </button>
            </div>
          ))}
        </div>
      )}
    </Card>
  );
};

// Founders Section Component - Editable
const FoundersSection = ({ founders = [], onUpdate }) => {
  const [expanded, setExpanded] = useState(null);
  const [showAddFounder, setShowAddFounder] = useState(false);
  const [newFounder, setNewFounder] = useState({ name: '', role: 'CEO', email: '', linkedIn: '', background: '' });
  
  const addFounder = () => {
    if (newFounder.name.trim()) {
      onUpdate([...founders, { ...newFounder, name: newFounder.name.trim() }]);
      setNewFounder({ name: '', role: 'CEO', email: '', linkedIn: '', background: '' });
      setShowAddFounder(false);
    }
  };

  const updateFounder = (idx, field, value) => {
    const updated = [...founders];
    updated[idx] = { ...updated[idx], [field]: value };
    onUpdate(updated);
  };

  const removeFounder = (idx) => {
    onUpdate(founders.filter((_, i) => i !== idx));
  };
  
  return (
    <Card>
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-sm font-medium text-stone-900">Founders ({founders.length})</h3>
        <button onClick={() => setShowAddFounder(true)} className="text-xs text-[#5B6DC4] hover:underline">+ Add founder</button>
      </div>
      
      {showAddFounder && (
        <div className="mb-3 p-3 bg-stone-50 rounded-xl space-y-2">
          <input type="text" placeholder="Name *" value={newFounder.name} onChange={e => setNewFounder({...newFounder, name: e.target.value})} className="w-full p-2 border border-stone-200 rounded-lg text-sm text-stone-900 bg-white" />
          <div className="grid grid-cols-2 gap-2">
            <input type="text" placeholder="Role" value={newFounder.role} onChange={e => setNewFounder({...newFounder, role: e.target.value})} className="p-2 border border-stone-200 rounded-lg text-sm text-stone-900 bg-white" />
            <input type="email" placeholder="Email" value={newFounder.email} onChange={e => setNewFounder({...newFounder, email: e.target.value})} className="p-2 border border-stone-200 rounded-lg text-sm text-stone-900 bg-white" />
          </div>
          <input type="text" placeholder="LinkedIn URL" value={newFounder.linkedIn} onChange={e => setNewFounder({...newFounder, linkedIn: e.target.value})} className="w-full p-2 border border-stone-200 rounded-lg text-sm text-stone-900 bg-white" />
          <input type="text" placeholder="Background (e.g., Ex-Google, Stanford)" value={newFounder.background} onChange={e => setNewFounder({...newFounder, background: e.target.value})} className="w-full p-2 border border-stone-200 rounded-lg text-sm text-stone-900 bg-white" />
          <div className="flex gap-2">
            <button onClick={addFounder} className="flex-1 py-2 bg-[#5B6DC4] text-white text-sm rounded-lg">Add</button>
            <button onClick={() => setShowAddFounder(false)} className="px-4 py-2 bg-stone-100 text-stone-600 text-sm rounded-lg">Cancel</button>
          </div>
        </div>
      )}

      {founders.length === 0 && !showAddFounder ? (
        <p className="text-sm text-stone-400">No founders added yet</p>
      ) : (
        <div className="space-y-2">
          {founders.map((founder, idx) => (
            <div key={idx} className="border border-stone-100 rounded-xl overflow-hidden">
              <button 
                onClick={() => setExpanded(expanded === idx ? null : idx)}
                className="w-full flex items-center justify-between p-3 hover:bg-stone-50"
              >
                <div className="flex items-center gap-3">
                  <div className="w-10 h-10 rounded-full bg-gradient-to-br from-stone-300 to-stone-400 flex items-center justify-center text-white font-semibold text-sm">
                    {founder.name.split(' ').map(n => n[0]).join('').slice(0, 2)}
                  </div>
                  <div className="text-left">
                    <p className="font-medium text-stone-900 text-sm">{founder.name}</p>
                    <p className="text-xs text-stone-500">{founder.role}</p>
                  </div>
                </div>
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className={`text-stone-400 transition-transform ${expanded === idx ? 'rotate-180' : ''}`}><polyline points="6 9 12 15 18 9"/></svg>
              </button>
              {expanded === idx && (
                <div className="px-3 pb-3 pt-1 border-t border-stone-100 bg-stone-50 space-y-2">
                  <div className="grid grid-cols-2 gap-2">
                    <div>
                      <label className="text-xs text-stone-500">Name</label>
                      <input type="text" value={founder.name} onChange={e => updateFounder(idx, 'name', e.target.value)} className="w-full p-2 border border-stone-200 rounded-lg text-sm text-stone-900 bg-white" />
                    </div>
                    <div>
                      <label className="text-xs text-stone-500">Role</label>
                      <input type="text" value={founder.role || ''} onChange={e => updateFounder(idx, 'role', e.target.value)} className="w-full p-2 border border-stone-200 rounded-lg text-sm text-stone-900 bg-white" />
                    </div>
                  </div>
                  <div>
                    <label className="text-xs text-stone-500">Email</label>
                    <input type="email" value={founder.email || ''} onChange={e => updateFounder(idx, 'email', e.target.value)} className="w-full p-2 border border-stone-200 rounded-lg text-sm text-stone-900 bg-white" />
                  </div>
                  <div>
                    <label className="text-xs text-stone-500">LinkedIn</label>
                    <input type="text" value={founder.linkedIn || ''} onChange={e => updateFounder(idx, 'linkedIn', e.target.value)} className="w-full p-2 border border-stone-200 rounded-lg text-sm text-stone-900 bg-white" />
                  </div>
                  <div>
                    <label className="text-xs text-stone-500">Background</label>
                    <input type="text" value={founder.background || ''} onChange={e => updateFounder(idx, 'background', e.target.value)} className="w-full p-2 border border-stone-200 rounded-lg text-sm text-stone-900 bg-white" />
                  </div>
                  <button onClick={() => removeFounder(idx)} className="text-xs text-red-600 hover:underline">Remove founder</button>
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </Card>
  );
};

// Deal Terms Component - Editable
const DealTermsSection = ({ terms = {}, onUpdate }) => {
  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState(terms);

  const saveTerms = () => {
    onUpdate(form);
    setEditing(false);
  };

  if (editing) {
    return (
      <Card>
        <h3 className="text-sm font-medium text-stone-900 mb-3">Deal Terms</h3>
        <div className="space-y-3">
          <div className="relative">
            <label className="text-xs text-stone-500">Instrument</label>
            <select value={form.instrument || ''} onChange={e => setForm({...form, instrument: e.target.value})} className="w-full mt-1 p-2 pr-10 border border-stone-200 rounded-lg text-sm text-stone-900 bg-white appearance-none cursor-pointer">
              <option value="">Select...</option>
              <option value="SAFE">SAFE</option>
              <option value="Convertible Note">Convertible Note</option>
              <option value="Equity">Equity</option>
              <option value="Other">Other</option>
            </select>
            <svg className="absolute right-3 top-[30px] pointer-events-none text-stone-400" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="6 9 12 15 18 9"/></svg>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-xs text-stone-500">Cap</label>
              <input type="number" placeholder="12000000" value={form.cap || ''} onChange={e => setForm({...form, cap: e.target.value ? Number(e.target.value) : null})} className="w-full mt-1 p-2 border border-stone-200 rounded-lg text-sm text-stone-900 bg-white" />
            </div>
            <div>
              <label className="text-xs text-stone-500">Valuation</label>
              <input type="number" placeholder="10000000" value={form.valuation || ''} onChange={e => setForm({...form, valuation: e.target.value ? Number(e.target.value) : null})} className="w-full mt-1 p-2 border border-stone-200 rounded-lg text-sm text-stone-900 bg-white" />
            </div>
          </div>
          <div>
            <label className="text-xs text-stone-500">Discount %</label>
            <input type="number" placeholder="20" value={form.discount || ''} onChange={e => setForm({...form, discount: e.target.value ? Number(e.target.value) : null})} className="w-full mt-1 p-2 border border-stone-200 rounded-lg text-sm text-stone-900 bg-white" />
          </div>
          <div className="flex flex-wrap gap-3 pt-2">
            <label className="flex items-center gap-2 cursor-pointer">
              <input type="checkbox" checked={form.proRata || false} onChange={e => setForm({...form, proRata: e.target.checked})} className="w-4 h-4 rounded" />
              <span className="text-sm text-stone-700">Pro-rata rights</span>
            </label>
            <label className="flex items-center gap-2 cursor-pointer">
              <input type="checkbox" checked={form.mfn || false} onChange={e => setForm({...form, mfn: e.target.checked})} className="w-4 h-4 rounded" />
              <span className="text-sm text-stone-700">MFN</span>
            </label>
            <label className="flex items-center gap-2 cursor-pointer">
              <input type="checkbox" checked={form.boardSeat || false} onChange={e => setForm({...form, boardSeat: e.target.checked})} className="w-4 h-4 rounded" />
              <span className="text-sm text-stone-700">Board seat</span>
            </label>
          </div>
          <div>
            <label className="text-xs text-stone-500">Notes</label>
            <input type="text" placeholder="Additional notes..." value={form.notes || ''} onChange={e => setForm({...form, notes: e.target.value})} className="w-full mt-1 p-2 border border-stone-200 rounded-lg text-sm text-stone-900 bg-white" />
          </div>
          <div className="flex gap-2 pt-2">
            <button onClick={saveTerms} className="flex-1 py-2 bg-[#5B6DC4] text-white text-sm rounded-lg">Save</button>
            <button onClick={() => { setForm(terms); setEditing(false); }} className="px-4 py-2 bg-stone-100 text-stone-600 text-sm rounded-lg">Cancel</button>
          </div>
        </div>
      </Card>
    );
  }
  
  const hasTerms = terms.instrument || terms.cap || terms.valuation || terms.discount;
  
  return (
    <Card>
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-sm font-medium text-stone-900">Deal Terms</h3>
        <button onClick={() => { setForm(terms); setEditing(true); }} className="text-xs text-[#5B6DC4] hover:underline">{hasTerms ? 'Edit' : '+ Add terms'}</button>
      </div>
      {!hasTerms ? (
        <p className="text-sm text-stone-400">No terms entered yet</p>
      ) : (
        <>
          <div className="grid grid-cols-2 gap-3">
            {terms.instrument && <div><p className="text-xs text-stone-500">Instrument</p><p className="text-sm font-medium text-stone-900">{terms.instrument}</p></div>}
            {terms.cap && <div><p className="text-xs text-stone-500">Cap</p><p className="text-sm font-medium text-stone-900">{formatCurrency(terms.cap)}</p></div>}
            {terms.valuation && <div><p className="text-xs text-stone-500">Valuation</p><p className="text-sm font-medium text-stone-900">{formatCurrency(terms.valuation)}</p></div>}
            {terms.discount && <div><p className="text-xs text-stone-500">Discount</p><p className="text-sm font-medium text-stone-900">{terms.discount}%</p></div>}
          </div>
          {(terms.proRata || terms.mfn || terms.boardSeat) && (
            <div className="flex gap-2 mt-3 pt-3 border-t border-stone-100">
              {terms.proRata && <span className="px-2 py-1 bg-emerald-50 text-emerald-700 text-xs rounded">Pro-rata</span>}
              {terms.mfn && <span className="px-2 py-1 bg-blue-50 text-blue-700 text-xs rounded">MFN</span>}
              {terms.boardSeat && <span className="px-2 py-1 bg-violet-50 text-violet-700 text-xs rounded">Board seat</span>}
            </div>
          )}
          {terms.notes && <p className="text-xs text-stone-500 mt-2">{terms.notes}</p>}
        </>
      )}
    </Card>
  );
};

// Milestones Timeline Component
const MilestonesTimeline = ({ milestones = [], onAdd }) => {
  const typeIcons = { fundraising: '💰', hiring: '👥', growth: '📈', product: '🚀', partnership: '🤝', other: '📌' };
  const typeColors = { fundraising: 'bg-emerald-500', hiring: 'bg-blue-500', growth: 'bg-violet-500', product: 'bg-amber-500', partnership: 'bg-pink-500', other: 'bg-stone-400' };
  
  const sorted = [...milestones].sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());
  
  return (
    <Card>
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-sm font-medium text-stone-900">Milestones ({milestones.length})</h3>
        <button onClick={onAdd} className="text-xs text-[#5B6DC4] hover:underline">+ Add milestone</button>
      </div>
      {sorted.length === 0 ? (
        <p className="text-sm text-stone-400">No milestones recorded</p>
      ) : (
        <div className="relative">
          <div className="absolute left-4 top-2 bottom-2 w-0.5 bg-stone-200"></div>
          <div className="space-y-4">
            {sorted.map((m, idx) => (
              <div key={m.id} className="flex gap-3 relative">
                <div className={`w-8 h-8 rounded-full ${typeColors[m.type] || typeColors.other} flex items-center justify-center text-sm z-10 flex-shrink-0`}>
                  {typeIcons[m.type] || typeIcons.other}
                </div>
                <div className="flex-1 min-w-0 pb-1">
                  <p className="text-sm font-medium text-stone-900">{m.title}</p>
                  <p className="text-xs text-stone-600">{m.description}</p>
                  <p className="text-xs text-stone-400 mt-1">{formatDate(m.date)}</p>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </Card>
  );
};

// Add Company Modal - supports all statuses
const AddPortfolioModal = ({ onClose, onAdd }) => {
  const [form, setForm] = useState({
    companyName: '',
    industry: '',
    stage: 'seed',
    companyStatus: 'screening', // 'screening' | 'invested' | 'deferred' | 'passed'
    engagement: 'active',
    // Investment fields (for invested)
    investmentAmount: '',
    investmentDate: '',
    vehicle: 'SAFE',
    // Defer fields
    deferReason: '',
    // Pass fields
    passReason: '',
    // Common fields
    founderName: '',
    founderRole: 'CEO',
    founderEmail: '',
    source: ''
  });

  const statusOptions = [
    { value: 'screening', label: 'Lead (Screening)', description: 'New opportunity to evaluate', color: '#5B6DC4' },
    { value: 'invested', label: 'Invested', description: 'Portfolio company', color: '#10b981' },
    { value: 'deferred', label: 'Deferred / Watching', description: 'Waiting for right timing', color: '#8b5cf6' },
    { value: 'passed', label: 'Passed', description: 'Decided not to invest', color: '#ef4444' }
  ];

  const handleSubmit = () => {
    if (!form.companyName) return;
    if (form.companyStatus === 'invested' && !form.investmentAmount) return;
    
    const now = new Date().toISOString();
    const baseFields = {
      id: Date.now().toString(),
      companyName: form.companyName,
      logoUrl: null,
      status: form.companyStatus,
      engagement: form.engagement,
      industry: form.industry || 'Other',
      stage: form.stage,
      source: { type: 'manual', name: form.source || 'Manual Entry' },
      statusEnteredAt: now,
      lastActivity: now,
      createdAt: now,
      founders: form.founderName ? [{
        name: form.founderName,
        role: form.founderRole,
        email: form.founderEmail || undefined
      }] : [],
      attachments: [],
      screening: { thesis: '', signals: [] }
    };

    let newDeal = { ...baseFields };

    // Add status-specific fields
    if (form.companyStatus === 'invested') {
      newDeal = {
        ...newDeal,
        terms: { instrument: form.vehicle },
        investment: {
          amount: Number(form.investmentAmount),
          vehicle: form.vehicle,
          date: form.investmentDate || now,
          updateFrequency: 'quarterly',
          metricsToWatch: []
        },
        monitoring: {
          healthStatus: 'stable',
          wouldInvestAgain: null,
          wouldIntro: null,
          followOns: []
        },
        milestones: []
      };
    } else if (form.companyStatus === 'deferred') {
      newDeal = {
        ...newDeal,
        deferData: {
          reason: form.deferReason || 'Imported from previous tool',
          condition: 'Date',
          conditionDetail: 'Review later'
        },
        deferType: 'watching'
      };
    } else if (form.companyStatus === 'passed') {
      newDeal = {
        ...newDeal,
        passed: {
          reason: form.passReason || 'Imported from previous tool',
          date: now
        }
      };
    }
    
    onAdd(newDeal);
    onClose();
  };

  const currentStatus = statusOptions.find(s => s.value === form.companyStatus);

  return (
    <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4">
      <div className="bg-white dark:bg-stone-800 rounded-2xl w-full max-w-lg max-h-[85vh] overflow-y-auto shadow-xl">
        <div className="sticky top-0 bg-white dark:bg-stone-800 px-4 py-3 border-b border-stone-200 dark:border-stone-700 flex items-center justify-between">
          <h2 className="font-semibold text-stone-900 dark:text-stone-100">Add Company</h2>
          <button onClick={onClose} className="p-1 text-stone-400 hover:text-stone-600 dark:hover:text-stone-300">
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M18 6L6 18M6 6l12 12"/></svg>
          </button>
        </div>
        
        <div className="p-4 space-y-4">
          {/* Company Status Selection - Dropdown */}
          <div>
            <label className="text-xs font-medium text-stone-600 dark:text-stone-400 uppercase tracking-wide">Status *</label>
            <div className="relative mt-2">
              <select
                value={form.companyStatus}
                onChange={e => setForm({...form, companyStatus: e.target.value})}
                className="w-full p-3 pr-10 border rounded-xl text-sm text-stone-900 dark:text-stone-100 bg-white dark:bg-stone-900 appearance-none cursor-pointer focus:outline-none focus:ring-2 focus:ring-[#5B6DC4]/20"
                style={{ borderColor: currentStatus?.color || '#e7e5e4' }}
              >
                {statusOptions.map(status => (
                  <option key={status.value} value={status.value}>
                    {status.label} — {status.description}
                  </option>
                ))}
              </select>
              <svg 
                className="absolute right-3 top-1/2 -translate-y-1/2 pointer-events-none text-stone-400" 
                width="16" 
                height="16" 
                viewBox="0 0 24 24" 
                fill="none" 
                stroke="currentColor" 
                strokeWidth="2"
              >
                <polyline points="6 9 12 15 18 9"/>
              </svg>
            </div>
          </div>

          {/* Active/Inactive Toggle */}
          <div className="flex items-center justify-between py-2">
            <div>
              <p className="text-sm font-medium text-stone-700 dark:text-stone-300">Engagement Status</p>
              <p className="text-xs text-stone-500 dark:text-stone-400">Is this actively being worked on?</p>
            </div>
            <button
              onClick={() => setForm({...form, engagement: form.engagement === 'active' ? 'inactive' : 'active'})}
              className={`px-3 py-1.5 rounded-lg text-sm font-medium transition-all ${
                form.engagement === 'active' 
                  ? 'bg-emerald-100 dark:bg-emerald-900/30 text-emerald-700 dark:text-emerald-400' 
                  : 'bg-stone-200 dark:bg-stone-700 text-stone-500 dark:text-stone-400'
              }`}
            >
              {form.engagement === 'active' ? 'Active' : 'Inactive'}
            </button>
          </div>

          <div className="border-t border-stone-200 dark:border-stone-700 pt-4">
            <p className="text-xs font-medium text-stone-600 dark:text-stone-400 uppercase tracking-wide mb-3">Company Details</p>
            
            <div className="space-y-3">
              <div>
                <label className="text-xs text-stone-500 dark:text-stone-400">Company Name *</label>
                <input 
                  type="text" 
                  value={form.companyName} 
                  onChange={e => setForm({...form, companyName: e.target.value})} 
                  placeholder="Acme Inc" 
                  className="w-full mt-1 p-3 border border-stone-200 dark:border-stone-700 rounded-xl text-sm text-stone-900 dark:text-stone-100 bg-white dark:bg-stone-900 placeholder-stone-400" 
                />
              </div>
              
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="text-xs text-stone-500 dark:text-stone-400">Industry</label>
                  <input 
                    type="text" 
                    value={form.industry} 
                    onChange={e => setForm({...form, industry: e.target.value})} 
                    placeholder="SaaS, Fintech..." 
                    className="w-full mt-1 p-3 border border-stone-200 dark:border-stone-700 rounded-xl text-sm text-stone-900 dark:text-stone-100 bg-white dark:bg-stone-900 placeholder-stone-400" 
                  />
                </div>
                <div>
                  <label className="text-xs text-stone-500 dark:text-stone-400">Funding Stage</label>
                  <div className="relative mt-1">
                    <select 
                      value={form.stage} 
                      onChange={e => setForm({...form, stage: e.target.value})} 
                      className="w-full p-3 pr-10 border border-stone-200 dark:border-stone-700 rounded-xl text-sm text-stone-900 dark:text-stone-100 bg-white dark:bg-stone-900 appearance-none cursor-pointer focus:outline-none focus:ring-2 focus:ring-[#5B6DC4]/20"
                    >
                      <option value="pre-seed">Pre-seed</option>
                      <option value="seed">Seed</option>
                      <option value="series-a">Series A</option>
                      <option value="series-b">Series B</option>
                      <option value="growth">Growth</option>
                    </select>
                    <svg 
                      className="absolute right-3 top-1/2 -translate-y-1/2 pointer-events-none text-stone-400" 
                      width="16" 
                      height="16" 
                      viewBox="0 0 24 24" 
                      fill="none" 
                      stroke="currentColor" 
                      strokeWidth="2"
                    >
                      <polyline points="6 9 12 15 18 9"/>
                    </svg>
                  </div>
                </div>
              </div>

              <div>
                <label className="text-xs text-stone-500 dark:text-stone-400">Source</label>
                <input 
                  type="text" 
                  value={form.source} 
                  onChange={e => setForm({...form, source: e.target.value})} 
                  placeholder="How did you find this company?" 
                  className="w-full mt-1 p-3 border border-stone-200 dark:border-stone-700 rounded-xl text-sm text-stone-900 dark:text-stone-100 bg-white dark:bg-stone-900 placeholder-stone-400" 
                />
              </div>
            </div>
          </div>

          {/* Conditional Investment Fields */}
          {form.companyStatus === 'invested' && (
            <div className="border-t border-stone-200 dark:border-stone-700 pt-4">
              <p className="text-xs font-medium text-stone-600 dark:text-stone-400 uppercase tracking-wide mb-3">Investment Details</p>
              <div className="space-y-3">
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="text-xs text-stone-500 dark:text-stone-400">Amount ($) *</label>
                    <input 
                      type="number" 
                      value={form.investmentAmount} 
                      onChange={e => setForm({...form, investmentAmount: e.target.value})} 
                      placeholder="25000" 
                      className="w-full mt-1 p-3 border border-stone-200 dark:border-stone-700 rounded-xl text-sm text-stone-900 dark:text-stone-100 bg-white dark:bg-stone-900 placeholder-stone-400" 
                    />
                  </div>
                  <div className="relative">
                    <label className="text-xs text-stone-500 dark:text-stone-400">Vehicle</label>
                    <select 
                      value={form.vehicle} 
                      onChange={e => setForm({...form, vehicle: e.target.value})} 
                      className="w-full mt-1 p-3 pr-10 border border-stone-200 dark:border-stone-700 rounded-xl text-sm text-stone-900 dark:text-stone-100 bg-white dark:bg-stone-900 appearance-none cursor-pointer"
                    >
                      <option value="SAFE">SAFE</option>
                      <option value="Convertible Note">Convertible Note</option>
                      <option value="Equity">Priced Equity</option>
                    </select>
                    <svg className="absolute right-3 top-[34px] pointer-events-none text-stone-400" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="6 9 12 15 18 9"/></svg>
                  </div>
                </div>
                <div>
                  <label className="text-xs text-stone-500 dark:text-stone-400">Investment Date</label>
                  <input 
                    type="date" 
                    value={form.investmentDate} 
                    onChange={e => setForm({...form, investmentDate: e.target.value})} 
                    className="w-full mt-1 p-3 border border-stone-200 dark:border-stone-700 rounded-xl text-sm text-stone-900 dark:text-stone-100 bg-white dark:bg-stone-900" 
                  />
                </div>
              </div>
            </div>
          )}

          {/* Conditional Defer Fields */}
          {form.companyStatus === 'deferred' && (
            <div className="border-t border-stone-200 dark:border-stone-700 pt-4">
              <p className="text-xs font-medium text-stone-600 dark:text-stone-400 uppercase tracking-wide mb-3">Why Deferred?</p>
              <textarea
                value={form.deferReason}
                onChange={e => setForm({...form, deferReason: e.target.value})}
                placeholder="Timing not right, waiting for product-market fit, etc."
                className="w-full p-3 border border-stone-200 dark:border-stone-700 rounded-xl text-sm text-stone-900 dark:text-stone-100 bg-white dark:bg-stone-900 placeholder-stone-400 resize-none"
                rows={2}
              />
            </div>
          )}

          {/* Conditional Pass Fields */}
          {form.companyStatus === 'passed' && (
            <div className="border-t border-stone-200 dark:border-stone-700 pt-4">
              <p className="text-xs font-medium text-stone-600 dark:text-stone-400 uppercase tracking-wide mb-3">Why Passed?</p>
              <textarea
                value={form.passReason}
                onChange={e => setForm({...form, passReason: e.target.value})}
                placeholder="Market too small, team concerns, valuation, etc."
                className="w-full p-3 border border-stone-200 dark:border-stone-700 rounded-xl text-sm text-stone-900 dark:text-stone-100 bg-white dark:bg-stone-900 placeholder-stone-400 resize-none"
                rows={2}
              />
            </div>
          )}

          {/* Founder Section */}
          <div className="border-t border-stone-200 dark:border-stone-700 pt-4">
            <p className="text-xs font-medium text-stone-600 dark:text-stone-400 uppercase tracking-wide mb-3">Founder (optional)</p>
            <div className="space-y-2">
              <div className="grid grid-cols-2 gap-3">
                <input 
                  type="text" 
                  value={form.founderName} 
                  onChange={e => setForm({...form, founderName: e.target.value})} 
                  placeholder="Name" 
                  className="p-3 border border-stone-200 dark:border-stone-700 rounded-xl text-sm text-stone-900 dark:text-stone-100 bg-white dark:bg-stone-900 placeholder-stone-400" 
                />
                <input 
                  type="text" 
                  value={form.founderRole} 
                  onChange={e => setForm({...form, founderRole: e.target.value})} 
                  placeholder="Role" 
                  className="p-3 border border-stone-200 dark:border-stone-700 rounded-xl text-sm text-stone-900 dark:text-stone-100 bg-white dark:bg-stone-900 placeholder-stone-400" 
                />
              </div>
              <input 
                type="email" 
                value={form.founderEmail} 
                onChange={e => setForm({...form, founderEmail: e.target.value})} 
                placeholder="Email" 
                className="w-full p-3 border border-stone-200 dark:border-stone-700 rounded-xl text-sm text-stone-900 dark:text-stone-100 bg-white dark:bg-stone-900 placeholder-stone-400" 
              />
            </div>
          </div>
        </div>
        
        <div className="sticky bottom-0 bg-white dark:bg-stone-800 px-4 py-3 border-t border-stone-200 dark:border-stone-700">
          <button 
            onClick={handleSubmit} 
            disabled={!form.companyName || (form.companyStatus === 'invested' && !form.investmentAmount)} 
            style={{ backgroundColor: currentStatus?.color || '#5B6DC4' }}
            className="w-full py-3 text-white rounded-xl text-sm font-medium disabled:opacity-50 disabled:cursor-not-allowed transition-all hover:opacity-90"
          >
            Add {currentStatus?.label || 'Company'}
          </button>
        </div>
      </div>
    </div>
  );
};

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
      {type === 'success' && (
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
          <polyline points="20 6 9 17 4 12"/>
        </svg>
      )}
      {type === 'error' && (
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
          <circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/>
        </svg>
      )}
      {message}
    </div>
  );
};

const ActionButton = ({ children, variant = 'secondary', onClick, disabled, className = '' }) => {
  const variants = {
    primary: 'bg-[#5B6DC4] text-white hover:bg-[#4F5FB3]',
    secondary: 'bg-stone-100 text-stone-700 hover:bg-stone-200 dark:bg-stone-700 dark:text-stone-300 dark:hover:bg-stone-600',
    success: 'bg-emerald-600 text-white hover:bg-emerald-700',
    danger: 'bg-red-600 text-white hover:bg-red-700',
    warning: 'bg-amber-100 text-amber-800 hover:bg-amber-200',
    ghost: 'bg-transparent text-stone-600 hover:bg-stone-100 dark:text-stone-400 dark:hover:bg-stone-800',
  };
  return <button onClick={onClick} disabled={disabled} className={`px-4 py-2.5 rounded-xl text-sm font-medium transition-all disabled:opacity-50 disabled:cursor-not-allowed ${variants[variant]} ${className}`}>{children}</button>;
};

const ProgressBar = ({ value, max, label }) => {
  const percent = max > 0 ? Math.round((value / max) * 100) : 0;
  return (
    <div>
      <div className="flex justify-between text-xs mb-1">
        <span className="text-stone-500">{label}</span>
        <span className="font-medium text-stone-700">{value}/{max}</span>
      </div>
      <div className="h-2 bg-stone-100 rounded-full overflow-hidden">
        <div className={`h-full rounded-full transition-all ${percent >= 70 ? 'bg-emerald-500' : percent >= 40 ? 'bg-amber-500' : 'bg-stone-300'}`} style={{ width: `${percent}%` }} />
      </div>
    </div>
  );
};

const TimeStamp = ({ label, date, warning }) => (
  <div className="flex justify-between items-center py-2 border-b border-stone-100 dark:border-stone-700 last:border-0">
    <span className="text-sm text-stone-500 dark:text-stone-400">{label}</span>
    <span className={`text-sm font-medium ${warning ? 'text-red-600 dark:text-red-400' : 'text-stone-900 dark:text-stone-100'}`}>{date ? `${daysAgo(date)}d ago` : '—'}</span>
  </div>
);

// Screening View - Working Notes with Integrated AI Research
const ScreeningView = ({ deal, onUpdate, onTransition, setToast }) => {
  const [entries, setEntries] = useState(deal.workingNotes || []);
  const [newNote, setNewNote] = useState('');
  const [isRecording, setIsRecording] = useState(false);
  const [isAIThinking, setIsAIThinking] = useState(false);
  const [showNeedMoreOptions, setShowNeedMoreOptions] = useState(null);
  
  // Decision modal state
  const [showInvestModal, setShowInvestModal] = useState(false);
  const [showWatchModal, setShowWatchModal] = useState(false);
  const [showPassModal, setShowPassModal] = useState(false);
  const [showMemoModal, setShowMemoModal] = useState(false);
  const [showConfetti, setShowConfetti] = useState(false);
  const [investReasoning, setInvestReasoning] = useState('');
  const [notificationPref, setNotificationPref] = useState('monthly');
  const [watchReason, setWatchReason] = useState('');
  const [watchCondition, setWatchCondition] = useState('');
  const [passReason, setPassReason] = useState('');

  // Confetti celebration component
  const ConfettiCelebration = () => {
    const confettiPieces = Array.from({ length: 50 }, (_, i) => ({
      id: i,
      left: Math.random() * 100,
      delay: Math.random() * 0.5,
      duration: 2 + Math.random() * 2,
      color: ['#10b981', '#34d399', '#6ee7b7', '#fbbf24', '#f59e0b', '#5B6DC4', '#818cf8'][Math.floor(Math.random() * 7)],
      size: 8 + Math.random() * 8,
      rotation: Math.random() * 360
    }));

    return (
      <div className="fixed inset-0 pointer-events-none z-[100] overflow-hidden">
        {confettiPieces.map(piece => (
          <div
            key={piece.id}
            className="absolute animate-bounce"
            style={{
              left: `${piece.left}%`,
              top: '-20px',
              width: piece.size,
              height: piece.size,
              backgroundColor: piece.color,
              borderRadius: Math.random() > 0.5 ? '50%' : '2px',
              transform: `rotate(${piece.rotation}deg)`,
              animation: `confetti-fall ${piece.duration}s ease-out ${piece.delay}s forwards`
            }}
          />
        ))}
        <style>{`
          @keyframes confetti-fall {
            0% {
              transform: translateY(0) rotate(0deg);
              opacity: 1;
            }
            100% {
              transform: translateY(100vh) rotate(720deg);
              opacity: 0;
            }
          }
        `}</style>
      </div>
    );
  };

  // Handle invest confirmation with celebration
  const handleInvestConfirm = () => {
    setShowConfetti(true);
    setTimeout(() => {
      onUpdate({ 
        ...deal, 
        investReasoning, 
        notificationPref,
        workingNotes: entries 
      });
      onTransition('invested');
      setShowInvestModal(false);
      setShowConfetti(false);
    }, 1500);
  };
  // Format timestamp for memo
  const formatTimestamp = (dateStr) => {
    const date = new Date(dateStr);
    return date.toLocaleString('en-US', { 
      month: 'short', 
      day: 'numeric', 
      year: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
      hour12: true 
    });
  };

  // Generate investment memo content
  const generateMemo = () => {
    const now = new Date();
    const memoDate = formatTimestamp(now.toISOString());
    
    // Get user notes (not AI responses)
    const userNotes = entries.filter(e => e.type === 'user' || e.type === 'voice');
    const aiInsights = entries.filter(e => e.type === 'ai');
    
    // Group by lens
    const byLens = {};
    entries.forEach(e => {
      if (e.lens) {
        if (!byLens[e.lens]) byLens[e.lens] = [];
        byLens[e.lens].push(e);
      }
    });

    return {
      generatedAt: memoDate,
      deal: {
        name: deal.companyName,
        stage: deal.stage,
        industry: deal.industry,
        location: deal.location || 'San Francisco, CA',
        overview: deal.overview || 'B2B payments platform simplifying cross-border transactions for SMBs.',
        founders: deal.founders || [],
        terms: deal.terms || {}
      },
      progress: {
        areasExplored: Object.values(lensProgress).filter(l => l.confident).length,
        totalAreas: 5,
        gaps: entries.filter(e => e.type === 'ai' && e.isGap && !e.userConfirmed).length
      },
      entries: entries.map(e => ({
        ...e,
        formattedTime: formatTimestamp(e.timestamp)
      })),
      byLens,
      userNotes,
      aiInsights
    };
  };
  
  // Lens progress tracking (derived from entries)
  const lensProgress = React.useMemo(() => {
    const lenses = {
      market: { name: 'Market size & timing', touched: false, confident: false, count: 0, entries: [] },
      team: { name: 'Founding team', touched: false, confident: false, count: 0, entries: [] },
      traction: { name: 'Traction & metrics', touched: false, confident: false, count: 0, entries: [] },
      edge: { name: 'Unique edge / moat', touched: false, confident: false, count: 0, entries: [] },
      product: { name: 'Product quality', touched: false, confident: false, count: 0, entries: [] },
    };
    
    entries.forEach(entry => {
      if (entry.lens && lenses[entry.lens]) {
        lenses[entry.lens].touched = true;
        lenses[entry.lens].count++;
        lenses[entry.lens].entries.push(entry);
        if (entry.userConfirmed) lenses[entry.lens].confident = true;
      }
    });
    
    return lenses;
  }, [entries]);

  const exploredCount = Object.values(lensProgress).filter(l => l.confident).length;
  const confidentCount = Object.values(lensProgress).filter(l => l.confident).length;

  // Get suggested next lenses based on what's not explored
  const suggestedNextLenses = React.useMemo(() => {
    return Object.entries(lensProgress)
      .filter(([key, lens]) => !lens.touched)
      .slice(0, 2)
      .map(([key]) => key);
  }, [lensProgress]);

  const updateDeal = (updates) => {
    onUpdate({ ...deal, ...updates });
  };

  // ============================================================================
  // CONTEXTUAL AI QUESTION GENERATION
  // Questions emerge from deal context + user notes, not fixed categories
  // ============================================================================

  // Extract key context from deal
  const dealContext = React.useMemo(() => ({
    industry: deal.industry || '',
    stage: deal.stage || '',
    companyName: deal.companyName || '',
    founders: deal.founders || [],
    overview: deal.overview || '',
    terms: deal.terms || {},
    source: deal.source || {},
  }), [deal]);

  // Analyze all user notes to understand what's been discussed
  const notesAnalysis = React.useMemo(() => {
    const userNotes = entries.filter(e => e.type === 'user' || e.type === 'voice');
    const allText = userNotes.map(n => n.content).join(' ').toLowerCase();
    
    // Track what topics have been mentioned
    const mentioned = {
      founders: allText.match(/founder|ceo|cto|team|experience|background|hire|who/),
      market: allText.match(/market|tam|opportunity|size|grow|segment|timing/),
      traction: allText.match(/revenue|mrr|arr|growth|customer|metric|user|sales/),
      competition: allText.match(/compet|moat|unique|different|edge|advantage|vs|versus/),
      product: allText.match(/product|tech|platform|feature|ux|demo|build/),
      risk: allText.match(/risk|concern|worry|fail|problem|issue|red flag/),
      valuation: allText.match(/valuation|price|cap|raise|round|terms|dilution/),
      regulatory: allText.match(/regulat|compliance|legal|license|permit/),
      unitEconomics: allText.match(/unit economics|ltv|cac|margin|burn|runway/),
      distribution: allText.match(/distribution|channel|sales|gtm|go to market|acquire/),
    };
    
    // Extract specific concerns or questions user has raised
    const concerns = userNotes
      .filter(n => n.content.match(/\?|concern|worry|unclear|don't know|not sure|wonder/i))
      .map(n => n.content);
    
    // Extract positive signals user has noted
    const positives = userNotes
      .filter(n => n.content.match(/like|strong|good|impressive|interesting|excited/i))
      .map(n => n.content);
    
    return { mentioned, concerns, positives, allText, noteCount: userNotes.length };
  }, [entries]);

  // Generate contextual questions based on deal + notes
  const generateContextualQuestions = React.useCallback(() => {
    const questions = [];
    const { industry, stage, founders, overview } = dealContext;
    const { mentioned, concerns, noteCount } = notesAnalysis;
    const industryLower = industry.toLowerCase();
    
    // INDUSTRY-SPECIFIC QUESTIONS
    if (industryLower.includes('fintech') || industryLower.includes('finance')) {
      if (!mentioned.regulatory) {
        questions.push({
          id: 'reg-fintech',
          question: 'What regulatory requirements apply here?',
          context: `${industry} companies typically need licenses or compliance frameworks`,
          category: 'regulatory',
          priority: 'high'
        });
      }
      if (!mentioned.unitEconomics) {
        questions.push({
          id: 'unit-fintech',
          question: 'What are the unit economics on each transaction?',
          context: 'Payment and fintech margins vary dramatically by model',
          category: 'economics',
          priority: 'medium'
        });
      }
    }
    
    if (industryLower.includes('health') || industryLower.includes('med') || industryLower.includes('bio')) {
      if (!mentioned.regulatory) {
        questions.push({
          id: 'reg-health',
          question: 'What\'s the regulatory pathway (FDA, HIPAA, etc)?',
          context: 'Healthcare products often require regulatory approval',
          category: 'regulatory',
          priority: 'high'
        });
      }
      questions.push({
        id: 'clinical-health',
        question: 'Is clinical validation required? What\'s the timeline?',
        context: 'Clinical trials can take years and significant capital',
        category: 'validation',
        priority: 'high'
      });
    }
    
    if (industryLower.includes('ai') || industryLower.includes('ml')) {
      if (!mentioned.product) {
        questions.push({
          id: 'moat-ai',
          question: 'What\'s the defensible moat beyond the model?',
          context: 'AI capabilities are increasingly commoditized',
          category: 'edge',
          priority: 'high'
        });
      }
      questions.push({
        id: 'data-ai',
        question: 'What proprietary data or training advantage do they have?',
        context: 'Data moats are often stronger than model moats in AI',
        category: 'edge',
        priority: 'medium'
      });
    }
    
    if (industryLower.includes('saas') || industryLower.includes('software')) {
      if (!mentioned.traction) {
        questions.push({
          id: 'metrics-saas',
          question: 'What are the core SaaS metrics (MRR, churn, NRR)?',
          context: 'SaaS businesses live and die by retention metrics',
          category: 'traction',
          priority: 'high'
        });
      }
    }
    
    if (industryLower.includes('marketplace') || industryLower.includes('platform')) {
      questions.push({
        id: 'chicken-egg',
        question: 'How are they solving the chicken-and-egg problem?',
        context: 'Marketplaces need both supply and demand to work',
        category: 'strategy',
        priority: 'high'
      });
    }
    
    if (industryLower.includes('hardware') || industryLower.includes('device')) {
      questions.push({
        id: 'manufacturing',
        question: 'What\'s the manufacturing and supply chain strategy?',
        context: 'Hardware scaling requires significant capital and expertise',
        category: 'operations',
        priority: 'high'
      });
    }

    // STAGE-SPECIFIC QUESTIONS
    if (stage === 'pre-seed' || stage === 'Pre-seed') {
      if (!mentioned.founders) {
        questions.push({
          id: 'founder-preseed',
          question: 'Why are these founders the right people for this problem?',
          context: 'At pre-seed, the bet is almost entirely on the team',
          category: 'team',
          priority: 'high'
        });
      }
      if (!mentioned.market) {
        questions.push({
          id: 'insight-preseed',
          question: 'What unique insight do they have that others don\'t?',
          context: 'Pre-seed companies need a contrarian but correct view',
          category: 'thesis',
          priority: 'high'
        });
      }
    }
    
    if (stage === 'seed' || stage === 'Seed') {
      if (!mentioned.traction) {
        questions.push({
          id: 'signal-seed',
          question: 'What early traction signals exist?',
          context: 'Seed stage should show some evidence of demand',
          category: 'traction',
          priority: 'high'
        });
      }
      if (!mentioned.distribution) {
        questions.push({
          id: 'gtm-seed',
          question: 'What\'s the go-to-market strategy?',
          context: 'Seed companies need a clear path to first customers',
          category: 'strategy',
          priority: 'medium'
        });
      }
    }
    
    if (stage === 'series-a' || stage === 'Series A') {
      if (!mentioned.traction) {
        questions.push({
          id: 'pmf-seriesa',
          question: 'Is there clear product-market fit? What\'s the evidence?',
          context: 'Series A should demonstrate repeatable demand',
          category: 'traction',
          priority: 'high'
        });
      }
      questions.push({
        id: 'scale-seriesa',
        question: 'Can this scale? What needs to be true?',
        context: 'Series A is about proving the model can scale',
        category: 'strategy',
        priority: 'high'
      });
    }

    // FOUNDER-CONTEXT QUESTIONS
    if (founders.length > 0) {
      const founderNames = founders.map(f => f.name).join(', ');
      if (!mentioned.founders) {
        questions.push({
          id: 'founder-context',
          question: `What's ${founders.length > 1 ? 'the founders\'' : founders[0]?.name + '\'s'} relevant background?`,
          context: `Current team: ${founderNames}`,
          category: 'team',
          priority: 'high'
        });
      }
    }

    // NOTE-REACTIVE QUESTIONS (based on what user has written)
    if (concerns.length > 0) {
      // User has expressed concerns - dig deeper
      const lastConcern = concerns[concerns.length - 1];
      if (lastConcern.match(/founder|team|experience/i) && !mentioned.founders) {
        questions.push({
          id: 'concern-team',
          question: 'What would make you confident in this team despite the concern?',
          context: `You noted: "${lastConcern.slice(0, 50)}..."`,
          category: 'team',
          priority: 'high',
          triggeredBy: 'your note'
        });
      }
      if (lastConcern.match(/market|competition|crowded/i)) {
        questions.push({
          id: 'concern-market',
          question: 'What would need to be true for them to win despite competition?',
          context: `You noted: "${lastConcern.slice(0, 50)}..."`,
          category: 'edge',
          priority: 'high',
          triggeredBy: 'your note'
        });
      }
    }

    // UNIVERSAL QUESTIONS (if not much has been explored)
    if (noteCount < 3) {
      if (!mentioned.risk) {
        questions.push({
          id: 'risk-universal',
          question: 'What would make this investment fail?',
          context: 'Pre-mortem thinking helps surface blind spots',
          category: 'risk',
          priority: 'medium'
        });
      }
      if (!mentioned.valuation) {
        questions.push({
          id: 'terms-universal',
          question: 'Do the terms make sense for the stage and traction?',
          context: 'Valuation should reflect risk and progress',
          category: 'terms',
          priority: 'medium'
        });
      }
    }

    // Sort by priority and return top questions
    const priorityOrder = { high: 0, medium: 1, low: 2 };
    return questions
      .sort((a, b) => priorityOrder[a.priority] - priorityOrder[b.priority])
      .slice(0, 5);
  }, [dealContext, notesAnalysis]);

  // Get current contextual questions
  const contextualQuestions = generateContextualQuestions();

  // Detect what topic a note is about (more flexible than fixed lenses)
  const detectTopic = (text) => {
    const lower = text.toLowerCase();
    if (lower.match(/market|tam|timing|opportunity|growing|size|segment/)) return 'market';
    if (lower.match(/founder|team|ceo|cto|experience|background|hire/)) return 'team';
    if (lower.match(/revenue|mrr|arr|growth|customer|traction|metric|user/)) return 'traction';
    if (lower.match(/compet|moat|unique|different|edge|defensi|advantage/)) return 'edge';
    if (lower.match(/product|tech|platform|feature|ux|quality|build/)) return 'product';
    if (lower.match(/risk|concern|fail|worry|red flag/)) return 'risk';
    if (lower.match(/valuation|price|terms|cap|raise/)) return 'terms';
    if (lower.match(/regulat|compliance|legal|license/)) return 'regulatory';
    return null;
  };

  // Legacy alias for compatibility
  const detectLens = detectTopic;

  // Get the user's original question that triggered an AI response
  const getOriginalQuestion = (entry) => {
    if (!entry.triggeredBy) return null;
    const original = entries.find(e => e.id === entry.triggeredBy);
    return original?.content || null;
  };

  // Generate a summary for "Add to notes"
  const generateNoteSummary = (entry) => {
    const summaries = {
      market: `Market appears large (${entry.detail?.includes('$150T') ? '$150T+ B2B cross-border' : 'significant opportunity'}). ${entry.keyInsight}`,
      team: `Team assessment: ${entry.keyInsight}`,
      traction: `Traction status: ${entry.keyInsight}`,
      edge: `Competitive position: ${entry.keyInsight}`,
      product: `Product evaluation: ${entry.keyInsight}`
    };
    return summaries[entry.lens] || entry.keyInsight;
  };

  // Handle "Add to my notes" action - adds summary without marking as explored
  const handleAddToNotes = (entry) => {
    const summary = generateNoteSummary(entry);
    const noteEntry = {
      id: Date.now(),
      type: 'user',
      content: summary,
      timestamp: new Date().toISOString(),
      lens: entry.lens,
      isFromAI: true, // Flag that this originated from AI
      sourceEntryId: entry.id
    };
    
    const updated = [...entries, noteEntry];
    // Mark the AI entry as having been added to notes
    const updatedWithMark = updated.map(e => 
      e.id === entry.id ? { ...e, addedToNotes: true } : e
    );
    setEntries(updatedWithMark);
    updateDeal({ workingNotes: updatedWithMark });
    
    // Don't mark as confirmed - user can still engage with the AI response
    setToast({ message: 'Added to your notes', type: 'success' });
  };

  // Need more follow-up options by lens
  const needMoreOptions = {
    market: [
      { label: 'Break down by SMB segment', query: 'Break down the market by SMB segment' },
      { label: 'What assumptions does this depend on?', query: 'What assumptions does this market size depend on?' },
      { label: 'Where could this be overstated?', query: 'Where could this market opportunity be overstated?' }
    ],
    team: [
      { label: 'Compare to successful founders', query: 'Compare to successful founders without domain experience' },
      { label: 'What are the key risks here?', query: 'What are the key team-related risks?' },
      { label: 'What should I ask them?', query: 'What questions should I ask the founders about their backgrounds?' }
    ],
    traction: [
      { label: 'What benchmarks should I expect?', query: 'What traction benchmarks should I expect at this stage?' },
      { label: 'What data should I request?', query: 'What specific traction data should I request from the founders?' },
      { label: 'How do I verify their claims?', query: 'How can I verify their traction claims?' }
    ],
    edge: [
      { label: 'How defensible is this really?', query: 'How defensible is their competitive advantage really?' },
      { label: 'Who are the biggest threats?', query: 'Who are the biggest competitive threats?' },
      { label: 'What could erode this moat?', query: 'What could erode their competitive moat over time?' }
    ],
    product: [
      { label: 'How do I evaluate without a demo?', query: 'How can I evaluate product quality without a demo?' },
      { label: 'What technical risks exist?', query: 'What technical risks should I be aware of?' },
      { label: 'What do customers say?', query: 'What do customers typically say about products like this?' }
    ]
  };

  // Generate AI research response based on user note
  const generateAIResponse = (userEntry) => {
    const lens = userEntry.lens;
    const content = userEntry.content.toLowerCase();
    
    // Contextual responses based on what user wrote + detected lens
    const responses = {
      market: [
        {
          condition: () => content.match(/tam|market size|how big/),
          response: {
            summary: "Market looks big, but framing matters",
            detail: "Global B2B cross-border payments volume exceeds $150 trillion annually. SMBs are roughly 40% of volume but underserved by banks. Whether that's actually addressable by a startup is a different question.",
            sources: [
              { name: "McKinsey Global Payments Report 2023", quality: "high", url: "https://www.mckinsey.com/industries/financial-services/our-insights/global-payments-report" },
              { name: "Juniper Research", quality: "medium", url: "https://www.juniperresearch.com/research/fintech-payments" }
            ],
            confidence: "High",
            followUp: "Want me to dig into the specific SMB segment they're targeting?",
            keyInsight: "Initial read: big market, but their slice is unclear"
          }
        },
        {
          condition: () => content.match(/timing|why now|moment/),
          response: {
            summary: "Timing might favor new entrants — maybe",
            detail: "Three things converging: (1) Real-time payment rails launching globally (FedNow, PIX, UPI), (2) SMB digitization accelerated post-COVID, (3) Legacy banks slow to modernize. Whether this creates a real window is debatable.",
            sources: [
              { name: "Federal Reserve", quality: "high", url: "https://www.federalreserve.gov/paymentsystems/fednow_about.htm" },
              { name: "Industry analysis", quality: "medium", url: "#" }
            ],
            confidence: "Medium",
            followUp: "Should I compare to when Wise/TransferWise entered the market?",
            keyInsight: "Rough sense: tailwinds exist, but not slam dunk"
          }
        },
        {
          condition: () => true, // default for market
          response: {
            summary: "Pain point seems real, numbers less clear",
            detail: "SMBs currently pay 3-5% in fees and wait 3-5 days for cross-border settlement. FinanceFlow's instant settlement claim, if achievable, would matter. The $50B+ fee pool they cite is worth questioning.",
            sources: [
              { name: "Company pitch materials", quality: "low" },
              { name: "World Bank Remittance Prices", quality: "high" }
            ],
            confidence: "medium",
            followUp: "The $50B TAM claim needs validation - want me to sanity check it?",
            keyInsight: "So far: pain seems real, TAM worth questioning"
          }
        }
      ],
      team: [
        {
          condition: () => content.match(/experience|background|before/),
          response: {
            summary: "Couldn't find much on founder backgrounds",
            detail: "Rachel Green (CEO) and Tom Martinez (CTO) - limited public info. Not unusual for early stage, but worth asking about directly.",
            sources: [
              { name: "LinkedIn", quality: "low", url: "https://linkedin.com" },
              { name: "Company website", quality: "low", url: "#" }
            ],
            confidence: "Low",
            followUp: "Key questions for founder call: prior roles, why this problem, relevant domain expertise?",
            keyInsight: "Early signal: backgrounds unclear, worth a call",
            isGap: true
          }
        },
        {
          condition: () => content.match(/concern|worry|risk|inexperienc/),
          response: {
            summary: "Your instinct here might be worth exploring",
            detail: "Founder-market fit matters, but isn't deterministic. Stripe founders had no payments experience. What often matters more: learning velocity, customer obsession, ability to recruit domain experts. Could go either way.",
            sources: [
              { name: "Startup patterns research", quality: "medium", url: "https://www.nfx.com/post/70-percent-of-value-founder-market-fit" }
            ],
            confidence: "Medium",
            followUp: "Want me to find examples of successful fintech founders without direct domain experience?",
            keyInsight: "Reasonable concern — unclear if dealbreaker"
          }
        },
        {
          condition: () => true,
          response: {
            summary: "Hard to assess team from afar",
            detail: "CEO/CTO combination suggests technical capability. Key questions that might matter: payments domain expertise, GTM experience, regulatory navigation skills.",
            sources: [
              { name: "Company profile", quality: "low", url: "#" }
            ],
            confidence: "Low",
            followUp: "What specific team qualities are most important for your investment thesis?",
            keyInsight: "Rough read: need a call to form real opinion",
            isGap: true
          }
        }
      ],
      traction: [
        {
          condition: () => content.match(/revenue|mrr|arr|number/),
          response: {
            summary: "No traction data in public materials",
            detail: "Revenue metrics not disclosed. At Seed stage this isn't unusual, but you'll probably want to ask about: current MRR, customer count, growth rate, retention.",
            sources: [
              { name: "Company materials", quality: "low" }
            ],
            confidence: "low",
            followUp: "Key data request: MRR, # of customers, MoM growth, churn rate",
            keyInsight: "Gap: no traction visibility yet",
            isGap: true
          }
        },
        {
          condition: () => content.match(/customer|user|pilot|beta/),
          response: {
            summary: "Customer validation is fuzzy",
            detail: "No information on pilot customers or beta users. For B2B payments, even 5-10 active SMB customers with real volume would be meaningful. Unclear if they have this.",
            sources: [
              { name: "Company materials", quality: "low" }
            ],
            confidence: "low",
            followUp: "Ask founders: Who are your first 10 customers? How did you acquire them?",
            keyInsight: "Open question: any real customers?",
            isGap: true
          }
        },
        {
          condition: () => true,
          response: {
            summary: "Early stage caveat applies",
            detail: "Seed stage means limited traction is expected, but some signal matters. Could look for: LOIs, pilot commitments, waitlist size, engaged beta users.",
            sources: [
              { name: "Stage-appropriate expectations", quality: "medium" }
            ],
            confidence: "medium",
            followUp: "What's the minimum traction signal you'd need to get comfortable?",
            keyInsight: "Stage-appropriate, but signal still unclear"
          }
        }
      ],
      edge: [
        {
          condition: () => content.match(/instant|settlement|fast|speed/),
          response: {
            summary: "Instant settlement would be notable if real",
            detail: "Current best-in-class (Wise) takes hours to days. Instant settlement usually requires: pre-funded accounts, specific banking partnerships, or novel treasury management. Each has tradeoffs. Worth understanding how they claim to do it.",
            sources: [
              { name: "Competitive analysis", quality: "medium" },
              { name: "Wise public filings", quality: "high" }
            ],
            confidence: "medium",
            followUp: "Technical diligence question: How do they achieve instant settlement? What's the capital requirement?",
            keyInsight: "Intriguing if true — needs digging"
          }
        },
        {
          condition: () => content.match(/compet|wise|stripe|paypal/),
          response: {
            summary: "Competitive field looks crowded but fragmented",
            detail: "Major players (Wise, PayPal, traditional banks) tend to focus on larger transactions. SMB cross-border seems underserved. Key risk to watch: Stripe expanding into this segment.",
            sources: [
              { name: "Public company filings", quality: "high" },
              { name: "Industry reports", quality: "medium" }
            ],
            confidence: "high",
            followUp: "Should I map out the competitive positioning in detail?",
            keyInsight: "Initial read: wedge exists, durability unclear"
          }
        },
        {
          condition: () => true,
          response: {
            summary: "Differentiation story depends on execution",
            detail: "The value prop (instant, cheap, SMB-focused) seems clear. Defensibility is the open question: technical moat, network effects, speed to scale before incumbents react. Hard to know from here.",
            sources: [
              { name: "Strategic analysis", quality: "medium" }
            ],
            confidence: "medium",
            followUp: "What would make you confident in their ability to build a moat?",
            keyInsight: "Rough sense: wedge clear, moat TBD"
          }
        }
      ],
      product: [
        {
          condition: () => content.match(/demo|see|try|product/),
          response: {
            summary: "Can't assess product without seeing it",
            detail: "No way to evaluate product quality from available materials. Open questions: Is there a working product? Demo available? Any customer feedback on UX?",
            sources: [
              { name: "No product access", quality: "low" }
            ],
            confidence: "low",
            followUp: "Might be worth requesting a product demo",
            keyInsight: "Gap: no product visibility",
            isGap: true
          }
        },
        {
          condition: () => content.match(/tech|architecture|build|engineer/),
          response: {
            summary: "Technical depth is a key unknown",
            detail: "For instant cross-border payments, the technical challenges are real: banking integrations, compliance, fraud prevention, treasury management. CTO background becomes relevant here.",
            sources: [
              { name: "Industry knowledge", quality: "medium" }
            ],
            confidence: "medium",
            followUp: "Technical diligence: What's the tech stack? How do they handle compliance?",
            keyInsight: "Open question: is the tech real?"
          }
        },
        {
          condition: () => true,
          response: {
            summary: "Product claims are just claims so far",
            detail: "The promise of simplifying cross-border payments sounds good. Without demo access or customer testimonials, product quality is unknown.",
            sources: [
              { name: "Company claims", quality: "low" }
            ],
            confidence: "low",
            followUp: "Add to diligence list: product demo, customer references, NPS if available",
            keyInsight: "Gap: product is still a black box",
            isGap: true
          }
        }
      ]
    };

    // Find matching response
    const lensResponses = responses[lens] || [];
    for (const item of lensResponses) {
      if (item.condition()) {
        return item.response;
      }
    }
    return null;
  };

  // Add a new note and trigger AI research
  const addNote = () => {
    if (!newNote.trim()) return;
    
    const detectedLens = detectLens(newNote);
    
    const userEntry = {
      id: Date.now(),
      type: 'user',
      content: newNote,
      timestamp: new Date().toISOString(),
      lens: detectedLens
    };
    
    const newEntries = [...entries, userEntry];
    setEntries(newEntries);
    setNewNote('');
    
    // If we detected a lens, generate AI response
    if (detectedLens) {
      setIsAIThinking(true);
      
      setTimeout(() => {
        const aiResponse = generateAIResponse(userEntry);
        
        if (aiResponse) {
          const aiEntry = {
            id: Date.now() + 1,
            type: 'ai',
            lens: detectedLens,
            triggeredBy: userEntry.id,
            ...aiResponse,
            timestamp: new Date().toISOString(),
            userConfirmed: null, // null = pending, true = confirmed, false = needs more
            userNote: null
          };
          
          setEntries(prev => [...prev, aiEntry]);
          updateDeal({ workingNotes: [...newEntries, aiEntry] });
        }
        
        setIsAIThinking(false);
      }, 1200);
    } else {
      updateDeal({ workingNotes: newEntries });
    }
  };

  // Auto-submit a quick prompt and trigger AI research immediately
  const autoSubmitPrompt = (prompt) => {
    const detectedLens = detectLens(prompt);
    
    const userEntry = {
      id: Date.now(),
      type: 'user',
      content: prompt,
      timestamp: new Date().toISOString(),
      lens: detectedLens
    };
    
    const newEntries = [...entries, userEntry];
    setEntries(newEntries);
    
    // Always trigger AI research for quick prompts
    setIsAIThinking(true);
    
    setTimeout(() => {
      const aiResponse = generateAIResponse(userEntry);
      
      if (aiResponse) {
        const aiEntry = {
          id: Date.now() + 1,
          type: 'ai',
          lens: detectedLens,
          triggeredBy: userEntry.id,
          ...aiResponse,
          timestamp: new Date().toISOString(),
          userConfirmed: null,
          userNote: null
        };
        
        setEntries(prev => [...prev, aiEntry]);
        updateDeal({ workingNotes: [...newEntries, aiEntry] });
      }
      
      setIsAIThinking(false);
    }, 1200);
  };

  // Handle user confirmation of AI insight
  const handleConfirmation = (entryId, confirmed, note = '') => {
    const entry = entries.find(e => e.id === entryId);
    const updated = entries.map(e => {
      if (e.id === entryId) {
        return { ...e, userConfirmed: confirmed, userNote: note || null };
      }
      return e;
    });
    setEntries(updated);
    updateDeal({ workingNotes: updated });
    
    if (confirmed) {
      setToast({ message: `${lensNames[entry?.lens] || 'Area'} explored`, type: 'success' });
    } else if (entry) {
      // Show scoped follow-up options instead of auto-generating
      setShowNeedMoreOptions(entryId);
    }
  };

  // Handle selecting a "Need more" option
  const handleNeedMoreOption = (entry, option) => {
    setShowNeedMoreOptions(null);
    
    // Create user entry for the follow-up
    const userEntry = {
      id: Date.now(),
      type: 'user',
      content: option.query,
      timestamp: new Date().toISOString(),
      lens: entry.lens,
      isFollowUp: true
    };
    
    const newEntries = [...entries, userEntry];
    setEntries(newEntries);
    setIsAIThinking(true);
    
    // Generate response
    setTimeout(() => {
      const deeperInsights = {
        market: {
          'Break down by SMB segment': {
            summary: "SMB market breakdown by segment",
            detail: "The $20T SMB cross-border market segments as: (1) E-commerce sellers: ~$8T, fastest growing at 25% YoY. (2) Professional services: ~$5T, stable but fragmented. (3) Manufacturing/trade: ~$4T, larger ticket sizes. (4) Other SMBs: ~$3T. E-commerce is the most attractive entry point - high volume, digital-native customers.",
            keyInsight: "E-commerce SMBs ($8T, 25% growth) are the ideal beachhead"
          },
          'What assumptions does this depend on?': {
            summary: "Key assumptions behind the market opportunity",
            detail: "The $50B+ opportunity assumes: (1) SMBs continue shifting to digital cross-border payments (likely). (2) Incumbent banks remain slow to adapt (historically true). (3) Regulatory environment stays favorable (uncertain). (4) No major platform captures this segment first (risk). Biggest assumption risk: Stripe or similar expanding downmarket.",
            keyInsight: "Platform risk (Stripe expanding) is the key assumption to stress-test"
          },
          'Where could this be overstated?': {
            summary: "Where the opportunity might be overstated",
            detail: "Potential overstatement areas: (1) TAM includes transactions that will never leave traditional banking. (2) SMB willingness to switch from existing solutions may be lower than assumed. (3) Customer acquisition costs in fragmented SMB market are often underestimated. (4) Regulatory barriers in key corridors may limit serviceable market.",
            keyInsight: "Realistic SAM is likely 20-30% of stated TAM"
          }
        },
        team: {
          'Compare to successful founders': {
            summary: "Comparison to successful non-domain founders",
            detail: "Successful fintech founders without direct experience: Stripe (Collisons - software), Robinhood (Tenev - physics), Plaid (Perret - finance but not banking infra). Common traits: exceptional technical ability, obsessive customer focus, recruited domain experts early. Key question: What domain experts have they hired or advised by?",
            keyInsight: "Track record of recruiting domain experts is more predictive than founder background"
          },
          'What are the key risks here?': {
            summary: "Key team-related risks",
            detail: "Primary team risks: (1) Payments is heavily regulated - inexperience could mean compliance missteps. (2) Banking relationships are relationship-driven - may lack network. (3) SMB sales is different from enterprise - need scrappy GTM DNA. (4) Two-person founding team may need to scale quickly.",
            keyInsight: "Regulatory navigation and banking relationships are the critical gaps"
          },
          'What should I ask them?': {
            summary: "Questions for founder assessment",
            detail: "High-signal questions: (1) 'Walk me through a recent regulatory or compliance challenge.' (2) 'Who are your key advisors with payments experience?' (3) 'How did you acquire your first 5 customers?' (4) 'What's been your biggest mistake so far and what did you learn?' Listen for specificity and self-awareness.",
            keyInsight: "Listen for specificity - vague answers are yellow flags"
          }
        },
        traction: {
          'What benchmarks should I expect?': {
            summary: "Seed-stage fintech traction benchmarks",
            detail: "Strong Seed traction for B2B fintech: (1) $10-50K MRR, (2) 5-20 paying customers, (3) 15-30% MoM growth, (4) <3 month payback on CAC, (5) Net revenue retention >100%. For pre-revenue: 3-5 signed LOIs, active pilots with real volume, or 100+ qualified waitlist with clear intent signals.",
            keyInsight: "At Seed: 5-20 customers + 15%+ MoM growth is strong"
          },
          'What data should I request?': {
            summary: "Specific data request for traction",
            detail: "Request these specific data points: (1) Monthly transaction volume and growth rate, (2) Number of active customers and cohort retention, (3) Unit economics: CAC, LTV, payback period, (4) Pipeline: qualified leads, conversion rate, sales cycle, (5) If pre-revenue: LOIs, pilot details, waitlist quality.",
            keyInsight: "Transaction volume growth is the most important metric at this stage"
          },
          'How do I verify their claims?': {
            summary: "Traction verification methods",
            detail: "Verification approaches: (1) Customer references - ask to speak with 2-3 current users, (2) Bank statements showing transaction volume, (3) Dashboard access or screen share of real metrics, (4) Third-party data if available (app store rankings, web traffic), (5) Ask about specific customer stories - vagueness is a red flag.",
            keyInsight: "Customer references are the gold standard - reluctance to provide them is a red flag"
          }
        },
        edge: {
          'How defensible is this really?': {
            summary: "Defensibility assessment",
            detail: "Defensibility factors: (1) Technical moat: Instant settlement is hard but replicable with enough capital. (2) Network effects: Moderate - more SMBs = more corridors = better rates. (3) Switching costs: Low-medium for SMBs. (4) Regulatory moat: Licenses take time but aren't permanent barriers. Overall: Defensibility is moderate - execution speed matters more than moat.",
            keyInsight: "Speed to scale matters more than technical moat"
          },
          'Who are the biggest threats?': {
            summary: "Competitive threat assessment",
            detail: "Key competitive threats: (1) Stripe expanding into SMB cross-border (highest risk), (2) Wise launching SMB-specific products (medium risk), (3) Regional players with local banking relationships, (4) Vertical-specific solutions (e.g., for e-commerce). Stripe is the elephant - their entry would compress the opportunity significantly.",
            keyInsight: "Stripe expansion is the primary competitive risk to monitor"
          },
          'What could erode this moat?': {
            summary: "Moat erosion risks",
            detail: "Moat erosion scenarios: (1) Real-time payment rails become ubiquitous, reducing speed advantage. (2) Banks finally modernize cross-border offerings. (3) Crypto/stablecoin solutions mature and reduce friction. (4) Larger player acquires the technology. Timeline: Most risks are 3-5 years out, giving runway to build scale.",
            keyInsight: "3-5 year window before infrastructure commoditizes"
          }
        },
        product: {
          'How do I evaluate without a demo?': {
            summary: "Product evaluation without demo access",
            detail: "Alternative evaluation methods: (1) Request recorded product walkthrough, (2) Ask for customer case studies with specific metrics, (3) Search for user reviews on G2, Capterra, or industry forums, (4) LinkedIn search for beta users and reach out directly, (5) Ask founders to show their NPS or CSAT scores. If they resist all transparency, that's a signal.",
            keyInsight: "Resistance to showing any product evidence is a red flag"
          },
          'What technical risks exist?': {
            summary: "Technical risk assessment",
            detail: "Key technical risks in cross-border payments: (1) Banking integration reliability and uptime, (2) FX rate management and exposure, (3) Compliance/KYC at scale across jurisdictions, (4) Fraud detection in real-time settlement, (5) Data security given financial data sensitivity. Ask: 'What's your uptime been? Have you had any security incidents?'",
            keyInsight: "Uptime and security track record are essential diligence items"
          },
          'What do customers say?': {
            summary: "Typical customer feedback patterns",
            detail: "For cross-border payment products, customers typically value: (1) Speed - this is usually #1, (2) Cost transparency - hidden fees are a major pain point, (3) Reliability - failed transfers are very damaging, (4) Support - when things go wrong, responsiveness matters. Ask for verbatim customer quotes - specific praise is more credible than general satisfaction.",
            keyInsight: "Request verbatim customer quotes - specificity indicates real feedback"
          }
        }
      };
      
      const lensInsights = deeperInsights[entry.lens] || {};
      const insight = lensInsights[option.label] || {
        summary: "Additional research",
        detail: "I've looked into this further. The best next step would be to discuss directly with the founders to get primary source information.",
        keyInsight: "Recommend direct founder discussion"
      };
      
      const aiEntry = {
        id: Date.now() + 1,
        type: 'ai',
        lens: entry.lens,
        triggeredBy: userEntry.id,
        summary: insight.summary,
        detail: insight.detail,
        keyInsight: insight.keyInsight,
        sources: [{ name: "Analysis", quality: "medium" }],
        confidence: "medium",
        followUp: null,
        timestamp: new Date().toISOString(),
        userConfirmed: null
      };
      
      setEntries(prev => [...prev, aiEntry]);
      updateDeal({ workingNotes: [...newEntries, aiEntry] });
      setIsAIThinking(false);
    }, 1200);
  };

  // Handle follow-up question - auto-submit
  const handleFollowUp = (entry) => {
    const followUpText = entry.followUp;
    
    // Create user entry for the follow-up
    const userEntry = {
      id: Date.now(),
      type: 'user',
      content: followUpText,
      timestamp: new Date().toISOString(),
      lens: entry.lens,
      isFollowUp: true
    };
    
    const newEntries = [...entries, userEntry];
    setEntries(newEntries);
    setIsAIThinking(true);
    
    // Generate response to the follow-up
    setTimeout(() => {
      const followUpResponses = {
        market: {
          "sanity-check": {
            summary: "Rough TAM sanity check",
            detail: "The $50B claim probably refers to annual fee revenue from SMB cross-border payments, not transaction volume. Back-of-envelope: $20T SMB volume × 0.25% average take rate = $50B. Plausible math, but aggressive — assumes they capture the entire fee pool. Realistic serviceable market might be $5-10B in their target corridors.",
            sources: [{ name: "Independent calculation", quality: "medium" }, { name: "Industry fee benchmarks", quality: "high" }],
            confidence: "high",
            followUp: null,
            keyInsight: "Early math: TAM plausible, SAM probably smaller"
          },
          "default": {
            summary: "One way to think about the market",
            detail: "Breaking down the SMB cross-border opportunity: US-EU corridor (~30% of volume), US-Asia (~25%), Intra-Asia (~20%), LatAm (~15%), Other (~10%). US-EU is most competitive. LatAm and Intra-Asia have less competition but more regulatory complexity. Depends which corridors they're targeting.",
            sources: [{ name: "Corridor analysis", quality: "medium" }],
            confidence: "medium",
            followUp: "Want me to look at specific regulatory requirements in their target markets?",
            keyInsight: "Rough framing: corridor choice matters"
          }
        },
        team: {
          "default": {
            summary: "Some questions that might help",
            detail: "Questions you could ask: (1) Walk me through your most complex technical challenge, (2) Who's your first payments/fintech hire going to be?, (3) Tell me about a time you were wrong about a product decision, (4) How do you divide responsibilities between CEO/CTO day-to-day?",
            sources: [{ name: "Due diligence patterns", quality: "medium" }],
            confidence: "high",
            followUp: null,
            keyInsight: "Possible angles for a founder call"
          }
        },
        traction: {
          "default": {
            summary: "Standard data request framing",
            detail: "You could ask: 'To help us move forward, could you share: (1) Current MRR and MoM growth rate, (2) Number of active customers and transaction volume, (3) Customer acquisition cost and payback period, (4) Net revenue retention or churn rate, (5) 2-3 customer references we could speak with.'",
            sources: [{ name: "Standard Seed diligence", quality: "high" }],
            confidence: "high",
            followUp: null,
            keyInsight: "Template for data request"
          }
        },
        edge: {
          "default": {
            summary: "Technical questions that might reveal depth",
            detail: "Things you could ask: (1) How do you achieve instant settlement - pre-funding, banking partnerships, or other?, (2) What's your capital efficiency ratio?, (3) Which banking/payment partners are you integrated with?, (4) How do you handle FX risk?, (5) What's your compliance/licensing status?",
            sources: [{ name: "Technical DD framework", quality: "medium" }],
            confidence: "high",
            followUp: null,
            keyInsight: "These might reveal if the tech claim is real"
          }
        },
        product: {
          "default": {
            summary: "Ways to get product signal without demo",
            detail: "Some options: (1) Request recorded product walkthrough, (2) Ask for customer case study with metrics, (3) Check LinkedIn for beta user feedback, (4) Search Twitter/X for mentions, (5) Ask founders to connect you with 2-3 current users.",
            sources: [{ name: "Product DD alternatives", quality: "medium" }],
            confidence: "medium",
            followUp: null,
            keyInsight: "Customer references might be best proxy"
          }
        }
      };
      
      const lensResponses = followUpResponses[entry.lens] || {};
      const response = followUpText.toLowerCase().includes('sanity') || followUpText.toLowerCase().includes('check') 
        ? (lensResponses["sanity-check"] || lensResponses["default"])
        : lensResponses["default"] || {
            summary: "Follow-up research",
            detail: "I've looked into this further. The best next step would be to discuss directly with the founders to get primary source information.",
            sources: [{ name: "Additional research", quality: "low" }],
            confidence: "low",
            followUp: null,
            keyInsight: "Recommend direct founder discussion"
          };
      
      const aiEntry = {
        id: Date.now() + 1,
        type: 'ai',
        lens: entry.lens,
        triggeredBy: userEntry.id,
        ...response,
        timestamp: new Date().toISOString(),
        userConfirmed: null
      };
      
      setEntries(prev => [...prev, aiEntry]);
      updateDeal({ workingNotes: [...newEntries, aiEntry] });
      setIsAIThinking(false);
    }, 1200);
  };

  // Handle attachment
  const handleAttachment = () => {
    const attachment = {
      id: Date.now(),
      type: 'attachment',
      content: '[Pitch deck attached]',
      fileName: 'FinanceFlow_Pitch_Deck.pdf',
      timestamp: new Date().toISOString(),
      lens: null
    };
    
    const newEntries = [...entries, attachment];
    setEntries(newEntries);
    
    // AI reacts to attachment
    setTimeout(() => {
      const aiReaction = {
        id: Date.now() + 1,
        type: 'ai',
        lens: 'market',
        triggeredBy: attachment.id,
        summary: "Quick scan of the deck",
        detail: "Claims I noticed: $50B TAM, instant settlement via proprietary tech, 2 pilot customers. The TAM calculation methodology isn't shown — worth asking about.",
        sources: [{ name: "FinanceFlow_Pitch_Deck.pdf", quality: "primary" }],
        confidence: "medium",
        followUp: "Want me to fact-check the $50B TAM claim against industry data?",
        keyInsight: "Initial scan: some claims worth questioning",
        timestamp: new Date().toISOString(),
        userConfirmed: null
      };
      
      setEntries(prev => [...prev, aiReaction]);
      updateDeal({ workingNotes: [...newEntries, aiReaction] });
    }, 1500);
    
    setToast({ message: 'Deck attached', type: 'success' });
  };

  // Voice recording
  const toggleRecording = () => {
    if (isRecording) {
      setIsRecording(false);
      // Simulate voice transcription
      const voiceEntry = {
        id: Date.now(),
        type: 'voice',
        content: '"I like the market opportunity but I\'m worried about the team\'s lack of payments experience..."',
        timestamp: new Date().toISOString(),
        lens: 'team'
      };
      
      const newEntries = [...entries, voiceEntry];
      setEntries(newEntries);
      
      // AI responds to voice note
      setTimeout(() => {
        const aiReaction = {
          id: Date.now() + 1,
          type: 'ai',
          lens: 'team',
          triggeredBy: voiceEntry.id,
          summary: "That's a reasonable thing to wonder about",
          detail: "Domain expertise matters but isn't always predictive. Stripe founders had no payments background. What sometimes matters more: technical depth, learning velocity, ability to recruit domain experts. Could go either way.",
          sources: [{ name: "Pattern matching from fintechs", quality: "medium" }],
          confidence: "medium",
          followUp: "Want me to find examples of successful founders who entered payments without direct experience?",
          keyInsight: "Reasonable concern — unclear if dealbreaker",
          timestamp: new Date().toISOString(),
          userConfirmed: null
        };
        
        setEntries(prev => [...prev, aiReaction]);
        updateDeal({ workingNotes: [...newEntries, aiReaction] });
      }, 1200);
      
      setToast({ message: 'Voice note transcribed', type: 'success' });
    } else {
      setIsRecording(true);
      setToast({ message: 'Recording... tap again to stop', type: 'success' });
    }
  };

  const formatTime = (ts) => {
    const d = new Date(ts);
    const now = new Date();
    const diffMs = now - d;
    const diffMins = Math.floor(diffMs / 60000);
    const diffHours = Math.floor(diffMs / 3600000);
    const diffDays = Math.floor(diffMs / 86400000);
    
    // Show relative time for recent entries
    if (diffMins < 1) return 'just now';
    if (diffMins < 60) return `${diffMins}m ago`;
    if (diffHours < 24) return `${diffHours}h ago`;
    
    // Show date + time for older entries
    const timeStr = d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true });
    if (diffDays < 7) {
      const dayStr = d.toLocaleDateString('en-US', { weekday: 'short' });
      return `${dayStr} ${timeStr}`;
    }
    
    // Full date for entries older than a week
    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) + ' ' + timeStr;
  };

  const lensNames = {
    market: 'Market',
    team: 'Team', 
    traction: 'Traction',
    edge: 'Moat',
    product: 'Product'
  };

  // Softer color palette matching the design
  const lensColors = {
    market: 'bg-blue-50 text-blue-600 dark:bg-blue-900/20 dark:text-blue-400',
    team: 'bg-violet-50 text-violet-600 dark:bg-violet-900/20 dark:text-violet-400',
    traction: 'bg-teal-50 text-teal-600 dark:bg-teal-900/20 dark:text-teal-400',
    edge: 'bg-orange-50 text-orange-600 dark:bg-orange-900/20 dark:text-orange-400',
    product: 'bg-pink-50 text-pink-600 dark:bg-pink-900/20 dark:text-pink-400'
  };

  const sourceQualityColors = {
    high: 'text-blue-600',
    medium: 'text-stone-500',
    low: 'text-stone-400',
    primary: 'text-blue-600'
  };

  // Count gaps
  const gaps = entries.filter(e => e.type === 'ai' && e.isGap && !e.userConfirmed).length;
  
  // Progressive disclosure - has user started?
  const hasStarted = entries.length > 0;
  const hasMultipleInputs = entries.filter(e => e.type === 'user' || e.type === 'voice').length >= 2;

  return (
    <div className="space-y-6">
      {/* Company Header */}
      <div className="bg-white dark:bg-stone-800 rounded-2xl p-5">
        <div className="flex items-start gap-4">
          <div className="w-14 h-14 rounded-xl flex items-center justify-center flex-shrink-0" style={{ backgroundColor: '#10b981' }}>
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2">
              <rect x="2" y="5" width="20" height="14" rx="2"/><line x1="2" y1="10" x2="22" y2="10"/>
            </svg>
          </div>
          
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 mb-1">
              <h2 className="text-xl font-bold text-stone-900 dark:text-white">{deal.companyName}</h2>
              <a href={deal.website || '#'} className="text-stone-400 hover:text-stone-600">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/>
                </svg>
              </a>
            </div>
            <p className="text-sm text-stone-500 dark:text-stone-400">
              {deal.stage} · {deal.industry} · <svg className="inline w-3 h-3 mb-0.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"/><circle cx="12" cy="10" r="3"/></svg> {deal.location || 'San Francisco, CA'}
            </p>
          </div>
        </div>

        <p className="mt-4 text-stone-600 dark:text-stone-300 text-sm leading-relaxed">
          {deal.overview || 'B2B payments platform simplifying cross-border transactions for SMBs. Reduces settlement time from 3-5 days to instant.'}
        </p>

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

      {/* Angles touched - Only show after multiple inputs, softer framing */}
      {hasMultipleInputs && (
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-xs text-stone-300">Angles touched:</span>
          {Object.entries(lensProgress).map(([key, lens]) => (
            <div 
              key={key}
              className="px-2.5 py-1 rounded-full text-xs flex items-center gap-1.5"
              style={
                lens.touched 
                  ? { backgroundColor: '#F5F5F4', color: '#78716C' }
                  : { backgroundColor: 'transparent', color: '#D6D3D1' }
              }
            >
              {lens.touched && (
                <span className="w-1 h-1 rounded-full" style={{ backgroundColor: '#A8A29E' }} />
              )}
              <span>{lens.name}</span>
            </div>
          ))}
        </div>
      )}

      {/* Working Notes - Conversation Flow */}
      <div className="bg-white dark:bg-stone-800 rounded-2xl overflow-hidden">
        <div className="p-4 border-b border-stone-100 dark:border-stone-700">
          <div className="flex items-center justify-between">
            <div>
              <h3 className="font-semibold text-stone-900 dark:text-white">
                {hasStarted ? 'Working Notes' : 'Your thoughts'}
              </h3>
              {hasStarted && (
                <p className="text-xs text-stone-300 dark:text-stone-600">Rough notes · nothing final</p>
              )}
            </div>
            {/* Remove status badges - too judgmental */}
          </div>
        </div>

        {/* Conversation entries */}
        <div className="p-4 space-y-4 max-h-[60vh] overflow-y-auto">
          {entries.length === 0 && (
            <div className="text-center py-12">
              <p className="text-stone-600 dark:text-stone-300 font-medium mb-2">What's your gut reaction to this company?</p>
              <p className="text-sm text-stone-400 dark:text-stone-500">Type below or use voice. No structure needed.</p>
            </div>
          )}
          
          {entries.map((entry, idx) => (
            <div key={entry.id}>
              {/* User entry */}
              {(entry.type === 'user' || entry.type === 'voice' || entry.type === 'attachment') && (
                <div className="flex gap-3">
                  <div className="w-8 h-8 rounded-full bg-stone-200 dark:bg-stone-700 flex items-center justify-center flex-shrink-0">
                    {entry.type === 'voice' ? (
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-stone-500">
                        <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"/>
                      </svg>
                    ) : entry.type === 'attachment' ? (
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-stone-500">
                        <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
                      </svg>
                    ) : (
                      <span className="text-xs font-medium text-stone-500">You</span>
                    )}
                  </div>
                  <div className="flex-1">
                    <div className="flex items-center gap-2 mb-1">
                      <span className="text-xs text-stone-400">{formatTime(entry.timestamp)}</span>
                      {entry.lens && (
                        <span className="text-xs px-2 py-0.5 rounded-full" style={{ backgroundColor: '#EEF2FF', color: '#5B6DC4' }}>
                          {lensNames[entry.lens]}
                        </span>
                      )}
                      {entry.isFromAI && (
                        <span className="text-xs text-stone-400 italic">from AI insight</span>
                      )}
                    </div>
                    <p className="text-stone-700 dark:text-stone-200">
                      {entry.type === 'voice' && <span className="italic">{entry.content}</span>}
                      {entry.type === 'attachment' && (
                        <span className="flex items-center gap-2">
                          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-stone-400">
                            <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/>
                          </svg>
                          {entry.fileName || entry.content}
                        </span>
                      )}
                      {entry.type === 'user' && entry.content}
                    </p>
                  </div>
                </div>
              )}

              {/* AI response - framed as thinking mirror, not verdict */}
              {entry.type === 'ai' && (
                <div className="flex gap-3 ml-4">
                  <div className="w-7 h-7 rounded-full flex items-center justify-center flex-shrink-0 bg-stone-200 dark:bg-stone-600">
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#78716C" strokeWidth="2">
                      <circle cx="12" cy="12" r="10"/><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"/><line x1="12" y1="17" x2="12.01" y2="17"/>
                    </svg>
                  </div>
                  <div className="flex-1 bg-stone-50/50 dark:bg-stone-700/30 rounded-xl p-4 border border-stone-100 dark:border-stone-700">
                    {/* Anchor to user's original question */}
                    {getOriginalQuestion(entry) && (
                      <p className="text-xs text-stone-400 mb-2 italic">
                        Re: "{getOriginalQuestion(entry).slice(0, 50)}{getOriginalQuestion(entry).length > 50 ? '...' : ''}"
                      </p>
                    )}
                    
                    {/* Softer lens tag */}
                    <div className="flex items-center gap-2 mb-3">
                      <span className="text-xs text-stone-400">
                        {lensNames[entry.lens]} angle
                      </span>
                      <span className="text-xs text-stone-300">·</span>
                      <span className="text-xs text-stone-300">
                        {entry.confidence === 'High' ? 'decent data' : entry.confidence === 'Medium' ? 'partial data' : 'thin data'}
                      </span>
                    </div>
                    
                    {/* Initial read - no green/yellow success framing */}
                    <div className="mb-3">
                      <p className="text-xs text-stone-400 mb-1">Initial read:</p>
                      <p className="text-sm text-stone-600 dark:text-stone-300">
                        {entry.keyInsight}
                      </p>
                    </div>

                    <p className="text-sm text-stone-500 dark:text-stone-400 mb-3">{entry.detail}</p>
                    
                    {/* Open loop - end with uncertainty */}
                    <p className="text-xs text-stone-400 italic mb-3">Could be wrong. Worth checking.</p>
                    
                    {/* Sources - now clickable */}
                    <div className="flex flex-wrap gap-2 mb-3">
                      {entry.sources.map((source, sidx) => (
                        <a 
                          key={sidx} 
                          href={source.url || '#'} 
                          target="_blank" 
                          rel="noopener noreferrer"
                          className={`text-xs flex items-center gap-1 hover:underline cursor-pointer ${sourceQualityColors[source.quality]}`}
                          onClick={(e) => { if (!source.url) e.preventDefault(); }}
                        >
                          <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                            <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>
                            <polyline points="15 3 21 3 21 9"/>
                            <line x1="10" y1="14" x2="21" y2="3"/>
                          </svg>
                          {source.name} →
                        </a>
                      ))}
                    </div>

                    {/* Actions - pending state */}
                    {entry.userConfirmed === null && !showNeedMoreOptions && (
                      <div className="flex flex-col gap-3 pt-3 border-t border-stone-100 dark:border-stone-600">
                        <div className="flex flex-wrap gap-2">
                          <button
                            onClick={() => handleConfirmation(entry.id, true)}
                            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-colors bg-stone-100 text-stone-600 hover:bg-stone-200"
                          >
                            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="20 6 9 17 4 12"/></svg>
                            Got it
                          </button>
                          <button
                            onClick={() => handleConfirmation(entry.id, false)}
                            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium bg-stone-50 text-stone-500 hover:bg-stone-100 transition-colors border border-stone-200"
                          >
                            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M21 12a9 9 0 1 1-9-9"/><path d="M21 3v9h-9"/></svg>
                            More on this
                          </button>
                          <button
                            onClick={() => {
                              setNewNote('');
                              document.querySelector('textarea')?.focus();
                            }}
                            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium bg-stone-50 text-stone-500 hover:bg-stone-100 transition-colors border border-stone-200"
                          >
                            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M12 19l7-7 3 3-7 7-3-3z"/><path d="M18 13l-1.5-7.5L2 2l3.5 14.5L13 18l5-5z"/></svg>
                            Add thought
                          </button>
                        </div>
                        
                        {/* Follow-up question - softer framing */}
                        {entry.followUp && (
                          <button
                            onClick={() => handleFollowUp(entry)}
                            className="w-full flex items-center gap-2 px-3 py-2 rounded-lg text-xs text-left transition-colors border border-stone-100 hover:border-stone-200 hover:bg-stone-50 text-stone-500"
                          >
                            <span>→ {entry.followUp}</span>
                          </button>
                        )}
                      </div>
                    )}
                    
                    {/* Dig deeper options - scoped follow-ups */}
                    {showNeedMoreOptions === entry.id && (
                      <div className="pt-3 border-t border-stone-100 dark:border-stone-600">
                        <p className="text-xs text-stone-500 mb-2">What would help?</p>
                        <div className="flex flex-wrap gap-2">
                          {(needMoreOptions[entry.lens] || []).map((option, idx) => (
                            <button
                              key={idx}
                              onClick={() => handleNeedMoreOption(entry, option)}
                              className="text-xs px-3 py-2 rounded-lg border border-stone-200 text-stone-600 hover:bg-stone-50 hover:border-stone-300 transition-colors text-left"
                            >
                              {option.label}
                            </button>
                          ))}
                        </div>
                        <button 
                          onClick={() => setShowNeedMoreOptions(null)}
                          className="text-xs text-stone-400 mt-2 hover:text-stone-600"
                        >
                          Cancel
                        </button>
                      </div>
                    )}
                    
                    {/* Confirmed state - softer, less permanent */}
                    {entry.userConfirmed === true && (
                      <div className="mt-3 p-2 rounded-lg bg-stone-50 dark:bg-stone-700/30">
                        <div className="flex items-center gap-2">
                          <span className="text-xs text-stone-400">
                            ✓ Noted
                          </span>
                        </div>
                      </div>
                    )}
                  </div>
                </div>
              )}
            </div>
          ))}

          {/* AI thinking indicator */}
          {isAIThinking && (
            <div className="flex gap-3 ml-4">
              <div className="w-8 h-8 rounded-full flex items-center justify-center flex-shrink-0 animate-pulse" style={{ backgroundColor: '#5B6DC4' }}>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2">
                  <path d="M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5"/>
                </svg>
              </div>
              <div className="flex items-center gap-2 text-sm text-stone-400">
                <span>Researching</span>
                <span className="flex gap-1">
                  <span className="w-1.5 h-1.5 bg-stone-400 rounded-full animate-bounce" style={{ animationDelay: '0ms' }}/>
                  <span className="w-1.5 h-1.5 bg-stone-400 rounded-full animate-bounce" style={{ animationDelay: '150ms' }}/>
                  <span className="w-1.5 h-1.5 bg-stone-400 rounded-full animate-bounce" style={{ animationDelay: '300ms' }}/>
                </span>
              </div>
            </div>
          )}
        </div>

        {/* Input area */}
        <div className="p-4 border-t border-stone-100 dark:border-stone-700">
          <div className="flex gap-2">
            <div className="flex-1 relative">
              <textarea
                value={newNote}
                onChange={(e) => setNewNote(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault();
                    addNote();
                  }
                }}
                placeholder="Type a thought, question, or concern..."
                className="w-full bg-stone-50 dark:bg-stone-700/50 rounded-xl px-4 py-3 pr-24 text-stone-800 dark:text-stone-200 placeholder-stone-400 text-sm focus:outline-none focus:ring-2 focus:ring-[#5B6DC4]/30 resize-none"
                rows={2}
              />
              <div className="absolute right-2 bottom-2 flex items-center gap-1">
                <button 
                  onClick={handleAttachment}
                  className="p-2 text-stone-400 hover:text-stone-600 transition-colors"
                  title="Attach file"
                >
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48"/>
                  </svg>
                </button>
                <button 
                  onClick={toggleRecording}
                  className={`p-2 transition-colors ${isRecording ? 'text-red-500 animate-pulse' : 'text-stone-400 hover:text-stone-600'}`}
                  title="Voice note"
                >
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/>
                  </svg>
                </button>
              </div>
            </div>
            <button
              onClick={addNote}
              disabled={!newNote.trim()}
              className="px-4 py-2 rounded-xl text-white font-medium disabled:opacity-50 disabled:cursor-not-allowed transition-all"
              style={{ backgroundColor: '#5B6DC4' }}
            >
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/>
              </svg>
            </button>
          </div>
          <p className="text-xs text-stone-400 mt-2">Press Enter to send · AI will auto-research relevant areas</p>
        </div>
      </div>

      {/* Contextual Questions - dynamically generated based on deal + notes */}
      {contextualQuestions.length > 0 && (
        <div className="bg-stone-50 dark:bg-stone-800/50 rounded-xl p-4 space-y-3">
          <div className="flex items-center gap-2">
            <svg className="text-[#5B6DC4]" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M9 18h6"/><path d="M10 22h4"/>
              <path d="M15.09 14c.18-.98.65-1.74 1.41-2.5A4.65 4.65 0 0 0 18 8 6 6 0 0 0 6 8c0 1 .23 2.23 1.5 3.5A4.61 4.61 0 0 1 8.91 14"/>
            </svg>
            <span className="text-xs font-medium text-stone-600 dark:text-stone-300">
              Questions worth exploring for this {deal.industry} {deal.stage}
            </span>
          </div>
          <div className="space-y-2">
            {contextualQuestions.slice(0, 3).map((q) => (
              <button
                key={q.id}
                onClick={() => autoSubmitPrompt(q.question)}
                disabled={isAIThinking}
                className="w-full text-left p-3 rounded-lg transition-all disabled:opacity-50 disabled:cursor-not-allowed hover:bg-white dark:hover:bg-stone-700 group"
                style={{ backgroundColor: 'transparent', border: '1px solid #E7E5E4' }}
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="flex-1">
                    <p className="text-sm font-medium text-stone-700 dark:text-stone-200 group-hover:text-[#5B6DC4]">
                      {q.question}
                    </p>
                    <p className="text-xs text-stone-400 mt-0.5">
                      {q.triggeredBy ? `Based on ${q.triggeredBy}` : q.context}
                    </p>
                  </div>
                  <span className={`text-xs px-2 py-0.5 rounded-full ${
                    q.priority === 'high' 
                      ? 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400' 
                      : 'bg-stone-100 text-stone-500 dark:bg-stone-700 dark:text-stone-400'
                  }`}>
                    {q.category}
                  </span>
                </div>
              </button>
            ))}
          </div>
          {contextualQuestions.length > 3 && (
            <p className="text-xs text-stone-400 text-center">
              +{contextualQuestions.length - 3} more questions available
            </p>
          )}
        </div>
      )}

      {/* Fallback quick prompts if no contextual questions (edge case) */}
      {contextualQuestions.length === 0 && hasStarted && (() => {
        const allPrompts = ['How big is this market?', 'What do we know about the founders?', 'Who are the competitors?', 'Is there any traction data?'];
        const askedQuestions = entries.filter(e => e.type === 'user').map(e => e.content);
        const remainingPrompts = allPrompts.filter(p => !askedQuestions.includes(p));
        
        if (remainingPrompts.length === 0) return null;
        
        return (
          <div className="flex flex-wrap gap-2 items-center">
            <span className="text-xs text-stone-400">Others often explore:</span>
            {remainingPrompts.map(prompt => (
              <button
                key={prompt}
                onClick={() => autoSubmitPrompt(prompt)}
                disabled={isAIThinking}
                className="text-xs px-3 py-1.5 rounded-full font-medium transition-all disabled:opacity-50 disabled:cursor-not-allowed"
                style={{ 
                  backgroundColor: '#F5F5F4', 
                  color: '#78716C',
                  border: '1px solid #E7E5E4'
                }}
                onMouseOver={(e) => {
                  e.currentTarget.style.backgroundColor = '#5B6DC4';
                  e.currentTarget.style.color = 'white';
                }}
                onMouseOut={(e) => {
                  e.currentTarget.style.backgroundColor = '#EEF2FF';
                  e.currentTarget.style.color = '#5B6DC4';
                }}
              >
                {prompt}
              </button>
            ))}
          </div>
        );
      })()}

      {/* Decision Section - Only show after user has started */}
      {hasStarted && (
        <div className="text-center pt-4" style={{ opacity: hasMultipleInputs ? 1 : 0.5 }}>
          <div className="flex items-center justify-center gap-4 mb-4">
            <div className="flex-1 h-px bg-stone-100 dark:bg-stone-700" />
            <span className="text-xs text-stone-300 tracking-wide">
              {hasMultipleInputs ? 'Whenever you\'re ready' : 'Keep exploring'}
            </span>
            <div className="flex-1 h-px bg-stone-100 dark:bg-stone-700" />
          </div>
          
          {/* Remove progress summary - too judgmental early on */}
          
          {gaps > 0 && hasMultipleInputs && (
            <p className="text-sm mb-4" style={{ color: '#8B6914' }}>
              You're choosing to decide with {gaps} open question{gaps > 1 ? 's' : ''}
            </p>
          )}
          
          <div className="flex flex-col items-center gap-3">
            <div className="flex items-center justify-center gap-4">
              <button 
                onClick={() => setShowInvestModal(true)}
                disabled={!hasMultipleInputs}
                className="flex flex-col items-center gap-1 px-6 py-3 rounded-xl font-medium transition-all text-white min-w-[100px] disabled:opacity-40 disabled:cursor-not-allowed"
                style={{ backgroundColor: '#10b981' }}
              >
                <span className="flex items-center gap-2">
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <circle cx="12" cy="12" r="10"/><path d="M12 6v12"/><path d="M6 12h12"/>
                  </svg>
                  Invest
                </span>
                <span className="text-[10px] opacity-80 font-normal">Record why you're investing now</span>
              </button>
              <button 
                onClick={() => setShowWatchModal(true)}
                disabled={!hasMultipleInputs}
                className="group flex flex-col items-center gap-1 px-6 py-3 rounded-xl font-medium transition-all border border-stone-300 text-stone-600 hover:border-amber-400 hover:text-amber-600 hover:bg-amber-50 min-w-[100px] disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:border-stone-300 disabled:hover:text-stone-600 disabled:hover:bg-transparent"
              >
                <span className="flex items-center gap-2">
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>
                  </svg>
                  Watch
                </span>
                <span className="text-[10px] opacity-70 font-normal group-hover:opacity-100">What would change your mind</span>
              </button>
              <button 
                onClick={() => setShowPassModal(true)}
                disabled={!hasMultipleInputs}
                className="group flex flex-col items-center gap-1 px-6 py-3 rounded-xl font-medium transition-all border border-stone-300 text-stone-600 hover:border-red-400 hover:text-red-600 hover:bg-red-50 min-w-[100px] disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:border-stone-300 disabled:hover:text-stone-600 disabled:hover:bg-transparent"
              >
                <span className="flex items-center gap-2">
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
                  </svg>
                  Pass
              </span>
              <span className="text-[10px] opacity-70 font-normal group-hover:opacity-100">Why is this a no right now?</span>
            </button>
          </div>
        </div>
        
        <p className="text-xs text-stone-400 mt-4">Take your time. You can always revisit this later.</p>
        
        {/* Generate Memo button - only show when ready */}
        {hasMultipleInputs && entries.length > 0 && (
          <button
            onClick={() => setShowMemoModal(true)}
            className="mt-6 flex items-center gap-2 mx-auto px-4 py-2 rounded-lg text-sm font-medium transition-all border border-stone-200 text-stone-500 hover:border-[#5B6DC4] hover:text-[#5B6DC4] hover:bg-[#5B6DC4]/5"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/><line x1="10" y1="9" x2="8" y2="9"/>
            </svg>
            Generate Investment Memo
          </button>
        )}
        </div>
      )}

      {/* Invest Modal */}
      {showInvestModal && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
          <div className="bg-white dark:bg-stone-800 rounded-2xl max-w-lg w-full max-h-[90vh] overflow-y-auto">
            <div className="p-6">
              {/* Header */}
              <div className="flex items-start justify-between mb-2">
                <div className="flex items-center gap-3">
                  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#5B6DC4" strokeWidth="2">
                    <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/>
                  </svg>
                  <h3 className="text-lg font-semibold text-stone-900 dark:text-white">Why I'm investing</h3>
                </div>
                <button 
                  onClick={() => setShowInvestModal(false)}
                  className="p-1 text-stone-400 hover:text-stone-600"
                >
                  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
                  </svg>
                </button>
              </div>
              <p className="text-sm text-stone-500 dark:text-stone-400 mb-6">
                Capture what convinced you. This helps you remember your thesis later.
              </p>

              {/* Your reasoning */}
              <div className="mb-6">
                <label className="block text-sm font-medium text-stone-700 dark:text-stone-300 mb-2">
                  Your reasoning
                </label>
                <textarea
                  value={investReasoning}
                  onChange={(e) => setInvestReasoning(e.target.value)}
                  placeholder="What convinced you? What's the thesis?"
                  className="w-full bg-stone-50 dark:bg-stone-700/50 rounded-xl p-4 text-stone-800 dark:text-stone-200 placeholder-stone-400 text-sm focus:outline-none focus:ring-2 focus:ring-[#5B6DC4]/30 min-h-[120px] resize-none border border-stone-200 dark:border-stone-600"
                />
              </div>

              {/* Notification preferences */}
              <div className="mb-6">
                <div className="flex items-center gap-2 mb-3">
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-stone-400">
                    <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 0 1-3.46 0"/>
                  </svg>
                  <span className="text-sm text-stone-600 dark:text-stone-400">Monitor updates for this company</span>
                </div>
                
                <div className="grid grid-cols-2 gap-3">
                  <button
                    onClick={() => setNotificationPref('weekly')}
                    className={`p-3 rounded-xl border-2 text-left transition-all ${
                      notificationPref === 'weekly' 
                        ? 'border-[#5B6DC4] bg-[#5B6DC4]/10 ring-2 ring-[#5B6DC4]/20' 
                        : 'border-stone-200 dark:border-stone-600 hover:border-stone-300'
                    }`}
                  >
                    <div className="flex items-center gap-2 mb-1">
                      {notificationPref === 'weekly' ? (
                        <div className="w-4 h-4 rounded-full bg-[#5B6DC4] flex items-center justify-center">
                          <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="3"><polyline points="20 6 9 17 4 12"/></svg>
                        </div>
                      ) : (
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-stone-400">
                          <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/>
                        </svg>
                      )}
                      <span className={`text-sm font-medium ${notificationPref === 'weekly' ? 'text-[#5B6DC4]' : 'text-stone-700 dark:text-stone-300'}`}>Weekly updates</span>
                    </div>
                    <p className="text-xs text-stone-500">Get notified weekly about company news</p>
                  </button>
                  
                  <button
                    onClick={() => setNotificationPref('monthly')}
                    className={`p-3 rounded-xl border-2 text-left transition-all ${
                      notificationPref === 'monthly' 
                        ? 'border-[#5B6DC4] bg-[#5B6DC4]/10 ring-2 ring-[#5B6DC4]/20' 
                        : 'border-stone-200 dark:border-stone-600 hover:border-stone-300'
                    }`}
                  >
                    <div className="flex items-center gap-2 mb-1">
                      {notificationPref === 'monthly' ? (
                        <div className="w-4 h-4 rounded-full bg-[#5B6DC4] flex items-center justify-center">
                          <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="3"><polyline points="20 6 9 17 4 12"/></svg>
                        </div>
                      ) : (
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-stone-400">
                          <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/>
                        </svg>
                      )}
                      <span className={`text-sm font-medium ${notificationPref === 'monthly' ? 'text-[#5B6DC4]' : 'text-stone-700 dark:text-stone-300'}`}>Monthly digest</span>
                    </div>
                    <p className="text-xs text-stone-500">Monthly summary of key updates</p>
                  </button>
                  
                  <button
                    onClick={() => setNotificationPref('milestones')}
                    className={`p-3 rounded-xl border-2 text-left transition-all ${
                      notificationPref === 'milestones' 
                        ? 'border-[#5B6DC4] bg-[#5B6DC4]/10 ring-2 ring-[#5B6DC4]/20' 
                        : 'border-stone-200 dark:border-stone-600 hover:border-stone-300'
                    }`}
                  >
                    <div className="flex items-center gap-2 mb-1">
                      {notificationPref === 'milestones' ? (
                        <div className="w-4 h-4 rounded-full bg-[#5B6DC4] flex items-center justify-center">
                          <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="3"><polyline points="20 6 9 17 4 12"/></svg>
                        </div>
                      ) : (
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-stone-400">
                          <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/>
                        </svg>
                      )}
                      <span className={`text-sm font-medium ${notificationPref === 'milestones' ? 'text-[#5B6DC4]' : 'text-stone-700 dark:text-stone-300'}`}>Milestones only</span>
                    </div>
                    <p className="text-xs text-stone-500">Only funding, launches, or major news</p>
                  </button>
                  
                  <button
                    onClick={() => setNotificationPref('none')}
                    className={`p-3 rounded-xl border-2 text-left transition-all ${
                      notificationPref === 'none' 
                        ? 'border-[#5B6DC4] bg-[#5B6DC4]/10 ring-2 ring-[#5B6DC4]/20' 
                        : 'border-stone-200 dark:border-stone-600 hover:border-stone-300'
                    }`}
                  >
                    <div className="flex items-center gap-2 mb-1">
                      {notificationPref === 'none' ? (
                        <div className="w-4 h-4 rounded-full bg-[#5B6DC4] flex items-center justify-center">
                          <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="3"><polyline points="20 6 9 17 4 12"/></svg>
                        </div>
                      ) : (
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-stone-400">
                          <path d="M13.73 21a2 2 0 0 1-3.46 0"/><path d="M18.63 13A17.89 17.89 0 0 1 18 8"/><path d="M6.26 6.26A5.86 5.86 0 0 0 6 8c0 7-3 9-3 9h14"/><path d="M18 8a6 6 0 0 0-9.33-5"/><line x1="1" y1="1" x2="23" y2="23"/>
                        </svg>
                      )}
                      <span className={`text-sm font-medium ${notificationPref === 'none' ? 'text-[#5B6DC4]' : 'text-stone-700 dark:text-stone-300'}`}>No notifications</span>
                    </div>
                    <p className="text-xs text-stone-500">I'll check back manually</p>
                  </button>
                </div>
              </div>

              {/* Actions - Centered */}
              <div className="flex items-center justify-center gap-3 pt-4 border-t border-stone-100 dark:border-stone-700">
                <button
                  onClick={() => setShowInvestModal(false)}
                  className="px-5 py-2.5 rounded-lg text-sm font-medium text-stone-600 hover:bg-stone-100 transition-colors"
                >
                  Cancel
                </button>
                <button
                  onClick={handleInvestConfirm}
                  className="px-5 py-2.5 rounded-lg text-sm font-medium text-white transition-colors hover:opacity-90"
                  style={{ backgroundColor: '#10b981' }}
                >
                  🎉 Confirm & Generate Memo
                </button>
              </div>
              
              <p className="text-xs text-stone-400 text-center mt-4">
                Your rationale will be saved and included in your investment memo
              </p>
            </div>
          </div>
        </div>
      )}

      {/* Confetti Animation */}
      {showConfetti && <ConfettiCelebration />}

      {/* Watch Modal */}
      {showWatchModal && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
          <div className="bg-white dark:bg-stone-800 rounded-2xl max-w-lg w-full max-h-[90vh] overflow-y-auto">
            <div className="p-6">
              {/* Header */}
              <div className="flex items-start justify-between mb-2">
                <div className="flex items-center gap-3">
                  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#D97706" strokeWidth="2">
                    <circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>
                  </svg>
                  <h3 className="text-lg font-semibold text-stone-900 dark:text-white">Why I'm watching</h3>
                </div>
                <button 
                  onClick={() => setShowWatchModal(false)}
                  className="p-1 text-stone-400 hover:text-stone-600"
                >
                  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
                  </svg>
                </button>
              </div>
              <p className="text-sm text-stone-500 dark:text-stone-400 mb-6">
                What would need to change for you to invest?
              </p>

              {/* Why watching */}
              <div className="mb-4">
                <label className="block text-sm font-medium text-stone-700 dark:text-stone-300 mb-2">
                  What's holding you back?
                </label>
                <textarea
                  value={watchReason}
                  onChange={(e) => setWatchReason(e.target.value)}
                  placeholder="e.g., Need to see more traction, waiting for next funding round..."
                  className="w-full bg-stone-50 dark:bg-stone-700/50 rounded-xl p-4 text-stone-800 dark:text-stone-200 placeholder-stone-400 text-sm focus:outline-none focus:ring-2 focus:ring-[#5B6DC4]/30 min-h-[80px] resize-none border border-stone-200 dark:border-stone-600"
                />
              </div>

              {/* Re-engage condition */}
              <div className="mb-6">
                <label className="block text-sm font-medium text-stone-700 dark:text-stone-300 mb-2">
                  When should we remind you to check back?
                </label>
                <div className="grid grid-cols-2 gap-2">
                  {['In 1 month', 'In 3 months', 'After next raise', 'When they hit milestones'].map(option => (
                    <button
                      key={option}
                      onClick={() => setWatchCondition(option)}
                      className={`px-3 py-2 rounded-lg text-sm text-left transition-colors ${
                        watchCondition === option 
                          ? 'bg-amber-100 text-amber-700 border border-amber-300' 
                          : 'bg-stone-50 text-stone-600 border border-stone-200 hover:border-stone-300'
                      }`}
                    >
                      {option}
                    </button>
                  ))}
                </div>
              </div>

              {/* Actions */}
              <div className="flex items-center justify-end gap-3 pt-4 border-t border-stone-100 dark:border-stone-700">
                <button
                  onClick={() => setShowWatchModal(false)}
                  className="px-5 py-2.5 rounded-lg text-sm font-medium text-stone-600 hover:bg-stone-100 transition-colors"
                >
                  Cancel
                </button>
                <button
                  onClick={() => {
                    onUpdate({ 
                      ...deal, 
                      deferData: { reason: watchReason, condition: watchCondition },
                      workingNotes: entries 
                    });
                    onTransition('deferred');
                    setShowWatchModal(false);
                  }}
                  className="px-5 py-2.5 rounded-lg text-sm font-medium text-white transition-colors"
                  style={{ backgroundColor: '#D97706' }}
                >
                  Add to Watchlist
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Pass Modal */}
      {showPassModal && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
          <div className="bg-white dark:bg-stone-800 rounded-2xl max-w-lg w-full max-h-[90vh] overflow-y-auto">
            <div className="p-6">
              {/* Header */}
              <div className="flex items-start justify-between mb-2">
                <div className="flex items-center gap-3">
                  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#DC2626" strokeWidth="2">
                    <circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/>
                  </svg>
                  <h3 className="text-lg font-semibold text-stone-900 dark:text-white">Why I'm passing</h3>
                </div>
                <button 
                  onClick={() => setShowPassModal(false)}
                  className="p-1 text-stone-400 hover:text-stone-600"
                >
                  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
                  </svg>
                </button>
              </div>
              <p className="text-sm text-stone-500 dark:text-stone-400 mb-6">
                Capture your reasoning so you remember why you passed.
              </p>

              {/* Pass reason */}
              <div className="mb-4">
                <label className="block text-sm font-medium text-stone-700 dark:text-stone-300 mb-2">
                  Main reason for passing
                </label>
                <div className="grid grid-cols-2 gap-2 mb-3">
                  {['Not thesis fit', 'Team concerns', 'Market too small', 'Too early', 'Valuation too high', 'Competitive concerns'].map(reason => (
                    <button
                      key={reason}
                      onClick={() => setPassReason(reason)}
                      className={`px-3 py-2 rounded-lg text-sm text-left transition-colors ${
                        passReason === reason 
                          ? 'bg-red-100 text-red-700 border border-red-300' 
                          : 'bg-stone-50 text-stone-600 border border-stone-200 hover:border-stone-300'
                      }`}
                    >
                      {reason}
                    </button>
                  ))}
                </div>
                <textarea
                  value={passReason}
                  onChange={(e) => setPassReason(e.target.value)}
                  placeholder="Add any additional notes..."
                  className="w-full bg-stone-50 dark:bg-stone-700/50 rounded-xl p-4 text-stone-800 dark:text-stone-200 placeholder-stone-400 text-sm focus:outline-none focus:ring-2 focus:ring-[#5B6DC4]/30 min-h-[60px] resize-none border border-stone-200 dark:border-stone-600"
                />
              </div>

              {/* Actions */}
              <div className="flex items-center justify-end gap-3 pt-4 border-t border-stone-100 dark:border-stone-700">
                <button
                  onClick={() => setShowPassModal(false)}
                  className="px-5 py-2.5 rounded-lg text-sm font-medium text-stone-600 hover:bg-stone-100 transition-colors"
                >
                  Cancel
                </button>
                <button
                  onClick={() => {
                    onUpdate({ 
                      ...deal, 
                      passReason,
                      workingNotes: entries 
                    });
                    onTransition('passed');
                    setShowPassModal(false);
                  }}
                  className="px-5 py-2.5 rounded-lg text-sm font-medium text-white transition-colors"
                  style={{ backgroundColor: '#DC2626' }}
                >
                  Confirm Pass
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Investment Memo Modal */}
      {showMemoModal && (() => {
        const memo = generateMemo();
        return (
          <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
            <div className="bg-white dark:bg-stone-800 rounded-2xl max-w-2xl w-full max-h-[90vh] overflow-hidden flex flex-col">
              {/* Header */}
              <div className="p-6 border-b border-stone-100 dark:border-stone-700">
                <div className="flex items-start justify-between">
                  <div className="flex items-center gap-3">
                    <div className="w-10 h-10 rounded-lg flex items-center justify-center" style={{ backgroundColor: '#EEF2FF' }}>
                      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#5B6DC4" strokeWidth="2">
                        <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/>
                      </svg>
                    </div>
                    <div>
                      <h3 className="text-lg font-semibold text-stone-900 dark:text-white">Investment Memo</h3>
                      <p className="text-xs text-stone-400">Generated {memo.generatedAt}</p>
                    </div>
                  </div>
                  <button 
                    onClick={() => setShowMemoModal(false)}
                    className="p-1 text-stone-400 hover:text-stone-600"
                  >
                    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                      <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
                    </svg>
                  </button>
                </div>
              </div>

              {/* Content - Scrollable */}
              <div className="flex-1 overflow-y-auto p-6 space-y-6">
                {/* Deal Overview */}
                <div className="bg-stone-50 dark:bg-stone-700/50 rounded-xl p-4">
                  <h4 className="text-sm font-semibold text-stone-900 dark:text-white mb-3 flex items-center gap-2">
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                      <rect x="2" y="5" width="20" height="14" rx="2"/><line x1="2" y1="10" x2="22" y2="10"/>
                    </svg>
                    Deal Overview
                  </h4>
                  <div className="grid grid-cols-2 gap-3 text-sm">
                    <div>
                      <span className="text-stone-500">Company</span>
                      <p className="font-medium text-stone-900 dark:text-white">{memo.deal.name}</p>
                    </div>
                    <div>
                      <span className="text-stone-500">Stage</span>
                      <p className="font-medium text-stone-900 dark:text-white">{memo.deal.stage}</p>
                    </div>
                    <div>
                      <span className="text-stone-500">Industry</span>
                      <p className="font-medium text-stone-900 dark:text-white">{memo.deal.industry}</p>
                    </div>
                    <div>
                      <span className="text-stone-500">Location</span>
                      <p className="font-medium text-stone-900 dark:text-white">{memo.deal.location}</p>
                    </div>
                  </div>
                  <p className="mt-3 text-sm text-stone-600 dark:text-stone-400">{memo.deal.overview}</p>
                  
                  {memo.deal.founders.length > 0 && (
                    <div className="mt-3 pt-3 border-t border-stone-200 dark:border-stone-600">
                      <span className="text-xs text-stone-500">Founders</span>
                      <div className="flex flex-wrap gap-2 mt-1">
                        {memo.deal.founders.map((f, i) => (
                          <span key={i} className="text-sm text-stone-700 dark:text-stone-300">
                            {f.name} ({f.role}){i < memo.deal.founders.length - 1 ? ',' : ''}
                          </span>
                        ))}
                      </div>
                    </div>
                  )}
                </div>

                {/* Research Progress */}
                <div className="bg-stone-50 dark:bg-stone-700/50 rounded-xl p-4">
                  <h4 className="text-sm font-semibold text-stone-900 dark:text-white mb-3 flex items-center gap-2">
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                      <polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/>
                    </svg>
                    Research Progress
                  </h4>
                  <div className="flex items-center gap-4">
                    <div className="flex-1">
                      <div className="flex items-center justify-between text-sm mb-1">
                        <span className="text-stone-600">Areas explored</span>
                        <span className="font-medium">{memo.progress.areasExplored} / {memo.progress.totalAreas}</span>
                      </div>
                      <div className="h-2 bg-stone-200 dark:bg-stone-600 rounded-full overflow-hidden">
                        <div 
                          className="h-full rounded-full transition-all" 
                          style={{ 
                            width: `${(memo.progress.areasExplored / memo.progress.totalAreas) * 100}%`,
                            backgroundColor: '#10b981'
                          }} 
                        />
                      </div>
                    </div>
                    {memo.progress.gaps > 0 && (
                      <span className="text-xs px-2 py-1 rounded-full" style={{ backgroundColor: '#FEF3CD', color: '#8B6914' }}>
                        {memo.progress.gaps} open gap{memo.progress.gaps > 1 ? 's' : ''}
                      </span>
                    )}
                  </div>
                </div>

                {/* Your Notes & Research */}
                <div>
                  <h4 className="text-sm font-semibold text-stone-900 dark:text-white mb-3 flex items-center gap-2">
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                      <path d="M12 19l7-7 3 3-7 7-3-3z"/><path d="M18 13l-1.5-7.5L2 2l3.5 14.5L13 18l5-5z"/>
                    </svg>
                    Your Notes & Research Timeline
                  </h4>
                  
                  <div className="space-y-3">
                    {memo.entries.map((entry, idx) => (
                      <div key={entry.id} className="border-l-2 border-stone-200 dark:border-stone-600 pl-4 py-2">
                        <div className="flex items-center gap-2 mb-1">
                          <span className="text-xs text-stone-400">{entry.formattedTime}</span>
                          {entry.lens && (
                            <span className="text-xs px-2 py-0.5 rounded-full" style={{ backgroundColor: '#EEF2FF', color: '#5B6DC4' }}>
                              {lensNames[entry.lens]}
                            </span>
                          )}
                          {entry.type === 'ai' && (
                            <span className="text-xs text-stone-400">AI Research</span>
                          )}
                          {entry.userConfirmed && (
                            <span className="text-xs" style={{ color: '#2D7A2D' }}>✓</span>
                          )}
                        </div>
                        
                        {entry.type === 'user' && (
                          <p className="text-sm text-stone-700 dark:text-stone-300">{entry.content}</p>
                        )}
                        
                        {entry.type === 'voice' && (
                          <p className="text-sm text-stone-700 dark:text-stone-300 italic">🎤 "{entry.content}"</p>
                        )}
                        
                        {entry.type === 'ai' && (
                          <div className="bg-white dark:bg-stone-800 rounded-lg p-3 mt-1">
                            {entry.keyInsight && (
                              <p className="text-sm font-medium mb-1" style={{ color: entry.isGap ? '#8B6914' : '#2D5A2D' }}>
                                {entry.isGap ? '⚠️ ' : '💡 '}{entry.keyInsight}
                              </p>
                            )}
                            <p className="text-sm text-stone-600 dark:text-stone-400">{entry.detail}</p>
                            {entry.sources && entry.sources.length > 0 && (
                              <div className="flex flex-wrap gap-1 mt-2">
                                {entry.sources.map((s, si) => (
                                  <span key={si} className="text-xs text-stone-400">📎 {s.name}</span>
                                ))}
                              </div>
                            )}
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                </div>
              </div>

              {/* Footer */}
              <div className="p-4 border-t border-stone-100 dark:border-stone-700 flex items-center justify-between">
                <p className="text-xs text-stone-400">
                  This memo captures your research as of {memo.generatedAt}
                </p>
                <div className="flex gap-2">
                  <button
                    onClick={() => {
                      // Save memo to deal
                      onUpdate({ 
                        ...deal, 
                        memo: { ...memo, savedAt: new Date().toISOString() },
                        workingNotes: entries 
                      });
                      setToast({ message: 'Memo saved to deal', type: 'success' });
                    }}
                    className="px-4 py-2 rounded-lg text-sm font-medium border border-stone-200 text-stone-600 hover:bg-stone-50 transition-colors"
                  >
                    Save to Deal
                  </button>
                  <button
                    onClick={() => {
                      // Copy to clipboard
                      const text = `INVESTMENT MEMO - ${memo.deal.name}\nGenerated: ${memo.generatedAt}\n\n` +
                        `DEAL OVERVIEW\n${memo.deal.name} | ${memo.deal.stage} | ${memo.deal.industry}\n${memo.deal.overview}\n\n` +
                        `RESEARCH NOTES\n` +
                        memo.entries.map(e => 
                          `[${e.formattedTime}] ${e.type === 'ai' ? 'AI: ' : ''}${e.content || e.keyInsight || ''}`
                        ).join('\n');
                      navigator.clipboard.writeText(text);
                      setToast({ message: 'Copied to clipboard', type: 'success' });
                    }}
                    className="px-4 py-2 rounded-lg text-sm font-medium text-white transition-colors"
                    style={{ backgroundColor: '#5B6DC4' }}
                  >
                    Copy to Clipboard
                  </button>
                </div>
              </div>
            </div>
          </div>
        );
      })()}
    </div>
  );
};

// Watching View
const DeferredView = ({ deal, onUpdate, onTransition }) => {
  const [revisitCriteria, setRevisitCriteria] = useState(deal.watching?.trigger || '');
  const [isMonitoring, setIsMonitoring] = useState(deal.tracked !== false);
  const [showFullNotes, setShowFullNotes] = useState(false);
  
  // Get deferred date
  const deferredDate = deal.statusEnteredAt || deal.deferData?.deferredAt;
  const deferredDateFormatted = deferredDate 
    ? new Date(deferredDate).toLocaleDateString('en-US', { month: 'short', year: 'numeric' })
    : 'Unknown';
  
  // Get original screening notes (first 2-4 lines)
  const getScreeningExcerpt = () => {
    const thesis = deal.screening?.thesis || '';
    const notes = deal.workingNotes?.filter(n => n.type === 'user')?.slice(0, 2) || [];
    if (thesis) return thesis;
    if (notes.length > 0) return notes.map(n => n.content).join(' ');
    return 'No screening notes recorded.';
  };
  
  // Determine signal state
  const getSignalState = () => {
    // Check for any activity since deferral
    const deferralTime = new Date(deferredDate || Date.now()).getTime();
    const recentSignals = deal.milestones?.filter(m => new Date(m.date).getTime() > deferralTime) || [];
    
    if (recentSignals.length === 0) {
      return {
        label: 'Quiet',
        description: 'No meaningful signals since deferral. Silence is information.',
        color: 'text-stone-500',
        bg: 'bg-stone-100'
      };
    }
    if (recentSignals.length >= 3) {
      return {
        label: 'Active',
        description: `${recentSignals.length} signals since deferral. May warrant a second look.`,
        color: 'text-emerald-600',
        bg: 'bg-emerald-50'
      };
    }
    return {
      label: 'Some activity',
      description: `${recentSignals.length} signal${recentSignals.length > 1 ? 's' : ''} since deferral.`,
      color: 'text-amber-600',
      bg: 'bg-amber-50'
    };
  };
  
  const signalState = getSignalState();
  
  const handleCriteriaChange = (value) => {
    setRevisitCriteria(value);
    onUpdate({ 
      ...deal, 
      watching: { 
        ...deal.watching, 
        trigger: value 
      } 
    });
  };
  
  const toggleMonitoring = () => {
    const newMonitoring = !isMonitoring;
    setIsMonitoring(newMonitoring);
    onUpdate({ ...deal, tracked: newMonitoring });
  };
  
  return (
    <div className="space-y-4">
      {/* Question prompt */}
      <p className="text-center text-stone-500 dark:text-stone-400 py-2">
        What evidence would change my mind?
      </p>

      {/* Decision snapshot - collapsible */}
      <div className="bg-white dark:bg-stone-800 rounded-2xl border border-stone-200 dark:border-stone-700 p-5">
        <div className="flex items-center justify-between mb-3">
          <h3 className="font-semibold text-stone-900 dark:text-stone-100">Decision snapshot</h3>
          <span className="text-xs text-stone-400">Recorded during initial screening · {deferredDateFormatted}</span>
        </div>
        <p className="text-sm text-stone-600 dark:text-stone-400 leading-relaxed line-clamp-3">
          {getScreeningExcerpt()}
        </p>
        {(deal.screening?.thesis || deal.workingNotes?.length > 0) && (
          <button 
            onClick={() => setShowFullNotes(!showFullNotes)}
            className="mt-3 text-xs text-[#5B6DC4] hover:underline"
          >
            {showFullNotes ? 'Hide full notes' : 'View full screening notes'}
          </button>
        )}
        {showFullNotes && deal.workingNotes && (
          <div className="mt-3 pt-3 border-t border-stone-100 dark:border-stone-700 space-y-2 max-h-48 overflow-y-auto">
            {deal.workingNotes.filter(n => n.type === 'user').map((note, idx) => (
              <p key={idx} className="text-xs text-stone-500 dark:text-stone-400">{note.content}</p>
            ))}
          </div>
        )}
      </div>

      {/* Revisit criteria */}
      <div className="bg-white dark:bg-stone-800 rounded-2xl border border-stone-200 dark:border-stone-700 p-5">
        <h3 className="font-semibold text-stone-900 dark:text-stone-100 mb-4">Revisit criteria</h3>
        <div className="relative">
          <textarea
            value={revisitCriteria}
            onChange={(e) => handleCriteriaChange(e.target.value)}
            placeholder="What signal or outcome would falsify your current view?"
            className="w-full min-h-[80px] p-4 rounded-xl text-sm text-stone-700 dark:text-stone-300 placeholder-stone-400 dark:placeholder-stone-500 bg-transparent resize-none focus:outline-none"
            style={{ 
              border: '2px dashed #d6d3d1',
              borderRadius: '12px'
            }}
          />
          <p className="mt-2 text-xs text-stone-400 dark:text-stone-500 px-1">
            Examples: repeatable sales motion, technical risk resolved, strong lead investor, evidence churn is stabilizing.
          </p>
        </div>
      </div>

      {/* Signal state */}
      <div className="bg-white dark:bg-stone-800 rounded-2xl border border-stone-200 dark:border-stone-700 p-5">
        <div className="flex items-center justify-between">
          <div>
            <h3 className="font-semibold text-stone-900 dark:text-stone-100">Signal state</h3>
            <p className="text-sm text-stone-500 dark:text-stone-400 mt-1">
              {signalState.description}
            </p>
            <p className="text-xs text-stone-400 dark:text-stone-500 mt-1">
              Deferred {deferredDateFormatted}
            </p>
          </div>
          <span className={`text-sm font-medium px-3 py-1 rounded-full ${signalState.bg} ${signalState.color}`}>
            {signalState.label}
          </span>
        </div>
      </div>

      {/* Ambient monitoring */}
      <div className="bg-white dark:bg-stone-800 rounded-2xl border border-stone-200 dark:border-stone-700 p-5">
        <div className="flex items-center justify-between">
          <div>
            <h3 className="font-semibold text-stone-900 dark:text-stone-100">Ambient monitoring</h3>
            <p className="text-sm text-stone-500 dark:text-stone-400 mt-0.5">
              Glance if something meaningful happens. No obligation.
            </p>
          </div>
          <div className="flex items-center gap-2">
            <span 
              className={`text-sm font-medium px-3 py-1 rounded-full transition-colors ${
                isMonitoring 
                  ? 'text-[#5B6DC4] bg-[#5B6DC4]/10' 
                  : 'text-stone-400 bg-stone-100 dark:bg-stone-700'
              }`}
            >
              {isMonitoring ? 'On' : 'Off'}
            </span>
            <button
              onClick={toggleMonitoring}
              className={`relative w-12 h-7 rounded-full transition-colors ${
                isMonitoring ? 'bg-[#5B6DC4]' : 'bg-stone-300 dark:bg-stone-600'
              }`}
            >
              <span 
                className={`absolute top-1 w-5 h-5 bg-white rounded-full shadow transition-transform ${
                  isMonitoring ? 'right-1' : 'left-1'
                }`}
              />
            </button>
          </div>
        </div>
      </div>

      {/* Learning framing */}
      <div className="bg-stone-50 dark:bg-stone-800/50 rounded-2xl border border-stone-200 dark:border-stone-700 p-4 text-center">
        <p className="text-sm text-stone-400 dark:text-stone-500">
          Collecting evidence on your judgment. Not missed opportunities.
        </p>
      </div>

      {/* Reopen in Screening */}
      <button 
        onClick={() => onTransition('screening')}
        className="w-full bg-white dark:bg-stone-800 rounded-2xl border border-stone-200 dark:border-stone-700 p-5 hover:bg-stone-50 dark:hover:bg-stone-700/50 transition-colors text-center"
      >
        <div className="flex items-center justify-center gap-2 text-[#5B6DC4]">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <polyline points="1 4 1 10 7 10"/>
            <path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10"/>
          </svg>
          <span className="font-semibold">Reopen in Screening</span>
        </div>
        <p className="text-sm text-stone-400 dark:text-stone-500 mt-1">
          Return this company to active evaluation.
        </p>
      </button>

      {/* Close for now */}
      <button 
        onClick={() => onTransition('passed')}
        className="w-full bg-white dark:bg-stone-800 rounded-2xl border border-stone-200 dark:border-stone-700 p-5 hover:bg-stone-50 dark:hover:bg-stone-700/50 transition-colors text-center"
      >
        <div className="flex items-center justify-center gap-2 text-stone-500 dark:text-stone-400">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <circle cx="12" cy="12" r="10"/>
          </svg>
          <span className="font-semibold">Close for now</span>
        </div>
        <p className="text-sm text-stone-400 dark:text-stone-500 mt-1">
          You can continue tracking and revisit later.
        </p>
      </button>
    </div>
  );
};

// Invested View - Clean confirmation design
const InvestedView = ({ deal, onUpdate, onTransition, setToast }) => {
  const [showChangeDecision, setShowChangeDecision] = useState(false);
  const inv = deal.investment || {};

  return (
    <div className="space-y-6">
      {/* Company Header - Same as Screening */}
      <div className="bg-white dark:bg-stone-800 rounded-2xl p-5">
        <div className="flex items-start gap-4">
          <div className="w-14 h-14 rounded-xl flex items-center justify-center flex-shrink-0" style={{ backgroundColor: '#10b981' }}>
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2">
              <rect x="2" y="5" width="20" height="14" rx="2"/><line x1="2" y1="10" x2="22" y2="10"/>
            </svg>
          </div>
          
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 mb-1">
              <h2 className="text-xl font-bold text-stone-900 dark:text-white">{deal.companyName}</h2>
              <a href={deal.website || '#'} className="text-stone-400 hover:text-stone-600">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/>
                </svg>
              </a>
            </div>
            <p className="text-sm text-stone-500 dark:text-stone-400">
              {deal.stage} · {deal.industry} · <svg className="inline w-3 h-3 mb-0.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"/><circle cx="12" cy="10" r="3"/></svg> {deal.location || 'San Francisco, CA'}
            </p>
          </div>
        </div>

        <p className="mt-4 text-stone-600 dark:text-stone-300 text-sm leading-relaxed">
          {deal.overview || 'B2B payments platform simplifying cross-border transactions for SMBs. Reduces settlement time from 3-5 days to instant.'}
        </p>

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

      {/* Investing Confirmation Card */}
      <div 
        className="rounded-2xl p-8 text-center"
        style={{ 
          background: 'linear-gradient(135deg, #D1FAE5 0%, #A7F3D0 50%, #6EE7B7 100%)',
          border: '1px solid #A7F3D0'
        }}
      >
        {/* Dollar icon with circle */}
        <div className="w-16 h-16 rounded-full mx-auto mb-4 flex items-center justify-center" style={{ backgroundColor: '#10b981' }}>
          <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="12" cy="12" r="10"/>
            <line x1="12" y1="6" x2="12" y2="18"/>
            <path d="M15 9.5c0-1.5-1.5-2.5-3-2.5s-3 .5-3 2.5c0 1.5 1.5 2 3 2.5s3 1 3 2.5c0 1.5-1.5 2.5-3 2.5s-3-1-3-2.5"/>
          </svg>
        </div>
        
        <h2 className="text-2xl font-bold mb-2" style={{ color: '#059669' }}>You're investing</h2>
        <p className="text-base mb-4" style={{ color: '#047857' }}>Time to finalize terms and wire the funds.</p>
        
        {/* Screening locked indicator */}
        <div className="flex items-center justify-center gap-2" style={{ color: '#6B7280' }}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/>
          </svg>
          <span className="text-sm">Screening locked</span>
        </div>
      </div>

      {/* Investment Thesis (if captured) */}
      {deal.investReasoning && (
        <div className="bg-white dark:bg-stone-800 rounded-2xl p-5">
          <div className="flex items-center gap-2 mb-3">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#5B6DC4" strokeWidth="2">
              <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/>
            </svg>
            <h3 className="font-medium text-stone-900 dark:text-white">Your investment thesis</h3>
          </div>
          <p className="text-sm text-stone-600 dark:text-stone-400 italic">"{deal.investReasoning}"</p>
          <p className="text-xs text-stone-400 mt-3">Captured at decision · included in your memo</p>
        </div>
      )}

      {/* Change Decision */}
      <div className="text-center pt-4">
        <button 
          onClick={() => setShowChangeDecision(true)}
          className="text-sm text-stone-400 hover:text-stone-600 transition-colors"
        >
          Change my decision
        </button>
      </div>

      {/* Change Decision Modal */}
      {showChangeDecision && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
          <div className="bg-white dark:bg-stone-800 rounded-2xl max-w-sm w-full p-6">
            <h3 className="text-lg font-semibold text-stone-900 dark:text-white mb-2">Change your decision?</h3>
            <p className="text-sm text-stone-500 dark:text-stone-400 mb-6">
              This will move the deal back to your pipeline for re-evaluation.
            </p>
            
            <div className="space-y-2">
              <button
                onClick={() => {
                  onTransition('screening');
                  setShowChangeDecision(false);
                }}
                className="w-full p-3 rounded-xl border border-stone-200 dark:border-stone-600 text-left hover:bg-stone-50 dark:hover:bg-stone-700 transition-colors"
              >
                <p className="text-sm font-medium text-stone-900 dark:text-white">Back to Screening</p>
                <p className="text-xs text-stone-500">Re-evaluate this opportunity</p>
              </button>
              
              <button
                onClick={() => {
                  onTransition('deferred');
                  setShowChangeDecision(false);
                }}
                className="w-full p-3 rounded-xl border border-stone-200 dark:border-stone-600 text-left hover:bg-stone-50 dark:hover:bg-stone-700 transition-colors"
              >
                <p className="text-sm font-medium text-stone-900 dark:text-white">Move to Watch</p>
                <p className="text-xs text-stone-500">Monitor but don't invest yet</p>
              </button>
              
              <button
                onClick={() => {
                  onTransition('passed');
                  setShowChangeDecision(false);
                }}
                className="w-full p-3 rounded-xl border border-stone-200 dark:border-stone-600 text-left hover:bg-stone-50 dark:hover:bg-stone-700 transition-colors"
              >
                <p className="text-sm font-medium text-stone-900 dark:text-white">Pass</p>
                <p className="text-xs text-stone-500">Decide not to invest</p>
              </button>
            </div>
            
            <button
              onClick={() => setShowChangeDecision(false)}
              className="w-full mt-4 p-2 text-sm text-stone-500 hover:text-stone-700 transition-colors"
            >
              Keep as Investing
            </button>
          </div>
        </div>
      )}
    </div>
  );
};

// Monitoring View
// Passed View
const PassedView = ({ deal, onUpdate, onTransition }) => {
  const p = deal.passed || { reasons: [], notes: '' };
  
  return (
    <div className="space-y-4">
      <div className="bg-stone-100 border border-stone-300 rounded-xl p-4">
        <p className="text-stone-600 font-medium text-center">{STATUS_CONFIG['passed'].question}</p>
      </div>

      <Card>
        <h3 className="text-sm font-medium text-stone-900 mb-3">Pass Reasons</h3>
        <div className="flex flex-wrap gap-2">
          {p.reasons?.map((r, i) => <span key={i} className="px-3 py-1 bg-red-50 text-red-700 rounded-full text-sm">{r}</span>)}
        </div>
      </Card>

      {p.notes && (
        <Card>
          <h3 className="text-sm font-medium text-stone-900 mb-2">Notes</h3>
          <p className="text-sm text-stone-600">{p.notes}</p>
        </Card>
      )}

      <Card>
        <TimeStamp label="Passed on" date={p.passedAt} />
      </Card>

      <div className="pt-2">
        <ActionButton variant="ghost" onClick={() => onTransition('screening')} className="w-full">Reactivate as Screening</ActionButton>
      </div>
    </div>
  );
};


// Portfolio Monitor Page - Health tracking and news feed for invested companies
const PortfolioMonitorPage = ({ deals, onBack, onSelectCompany, selectedDeal }) => {
  const [selectedFilter, setSelectedFilter] = useState(selectedDeal?.id || 'all');
  const [expandedTimeline, setExpandedTimeline] = useState({});
  
  // Get only invested companies
  const portfolioDeals = deals.filter(d => d.status === 'invested').sort((a, b) => 
    new Date(b.investment?.date || b.statusEnteredAt).getTime() - new Date(a.investment?.date || a.statusEnteredAt).getTime()
  );
  
  // Generate activity feed from all portfolio companies
  const generateActivityFeed = () => {
    const activities = [];
    
    portfolioDeals.forEach(deal => {
      // Add milestones as activities
      if (deal.milestones) {
        deal.milestones.forEach(m => {
          activities.push({
            id: `${deal.id}-${m.id}`,
            companyId: deal.id,
            companyName: deal.companyName,
            type: m.type,
            title: m.title,
            description: m.description,
            date: m.date,
            source: m.source || getSourceForType(m.type),
            sourceUrl: m.sourceUrl || '#',
            verified: m.verified !== false,
            sentiment: getSentimentForType(m.type, m.title)
          });
        });
      }
      
      // Add simulated recent signals for demo
      if (deal.companyName === 'CloudBase') {
        activities.push(
          { id: `${deal.id}-signal-1`, companyId: deal.id, companyName: deal.companyName, type: 'team', title: 'New VP of Engineering Hired', description: 'Former Google engineer Jane Smith joins as VP of Engineering to lead product development.', date: new Date(Date.now() - 2*86400000).toISOString(), source: 'LinkedIn', sourceUrl: 'https://linkedin.com', verified: true, sentiment: 'positive' },
          { id: `${deal.id}-signal-2`, companyId: deal.id, companyName: deal.companyName, type: 'product', title: 'Enterprise API v2.0 Launch', description: 'Major product update with new enterprise features including SSO, audit logs, and custom integrations.', date: new Date(Date.now() - 5*86400000).toISOString(), source: 'X (Twitter)', sourceUrl: 'https://twitter.com', verified: true, sentiment: 'positive' },
          { id: `${deal.id}-signal-3`, companyId: deal.id, companyName: deal.companyName, type: 'press', title: 'Featured in TechCrunch', description: 'CloudBase highlighted as one of the top DevTools startups to watch in 2025.', date: new Date(Date.now() - 12*86400000).toISOString(), source: 'TechCrunch', sourceUrl: 'https://techcrunch.com', verified: true, sentiment: 'positive' }
        );
      }
      
      if (deal.companyName === 'Acme Analytics') {
        activities.push(
          { id: `${deal.id}-signal-1`, companyId: deal.id, companyName: deal.companyName, type: 'partnership', title: 'AWS Marketplace Launch', description: 'Acme Analytics now available on AWS Marketplace for enterprise customers.', date: new Date(Date.now() - 3*86400000).toISOString(), source: 'AWS Blog', sourceUrl: 'https://aws.amazon.com/blogs', verified: true, sentiment: 'positive' },
          { id: `${deal.id}-signal-2`, companyId: deal.id, companyName: deal.companyName, type: 'hiring', title: 'Hiring 15 Engineers', description: '15 new engineering roles posted, signaling continued growth investment.', date: new Date(Date.now() - 8*86400000).toISOString(), source: 'LinkedIn', sourceUrl: 'https://linkedin.com', verified: true, sentiment: 'positive' },
          { id: `${deal.id}-signal-3`, companyId: deal.id, companyName: deal.companyName, type: 'podcast', title: 'CEO on Data Eng Podcast', description: 'David Lee discusses the future of analytics on the Data Engineering Podcast.', date: new Date(Date.now() - 15*86400000).toISOString(), source: 'Podcast', sourceUrl: 'https://dataengineeringpodcast.com', verified: true, sentiment: 'neutral' }
        );
      }
      
      if (deal.companyName === 'SecureVault') {
        activities.push(
          { id: `${deal.id}-signal-1`, companyId: deal.id, companyName: deal.companyName, type: 'fundraising', title: 'Reportedly Raising Series A', description: 'Sources indicate SecureVault is in talks for a $15M Series A round.', date: new Date(Date.now() - 1*86400000).toISOString(), source: 'The Information', sourceUrl: 'https://theinformation.com', verified: false, sentiment: 'positive' },
          { id: `${deal.id}-signal-2`, companyId: deal.id, companyName: deal.companyName, type: 'product', title: 'SOC 2 Type II Certification', description: 'SecureVault achieves SOC 2 Type II certification, enabling enterprise sales.', date: new Date(Date.now() - 10*86400000).toISOString(), source: 'Company Blog', sourceUrl: '#', verified: true, sentiment: 'positive' }
        );
      }
    });
    
    // Sort by date descending
    return activities.sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());
  };
  
  const getSourceForType = (type) => {
    const sources = {
      fundraising: 'Crunchbase',
      hiring: 'LinkedIn',
      growth: 'Company Update',
      product: 'Product Hunt',
      partnership: 'Press Release',
      press: 'TechCrunch'
    };
    return sources[type] || 'News';
  };
  
  const getSentimentForType = (type, title) => {
    const lower = title.toLowerCase();
    if (lower.includes('layoff') || lower.includes('shut down') || lower.includes('failed')) return 'negative';
    if (lower.includes('raised') || lower.includes('grew') || lower.includes('hired') || lower.includes('launch') || lower.includes('partnership')) return 'positive';
    return 'neutral';
  };
  
  const getTypeIcon = (type) => {
    const icons = {
      fundraising: <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><line x1="12" y1="1" x2="12" y2="23"/><path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"/></svg>,
      hiring: <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M16 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="8.5" cy="7" r="4"/><line x1="20" y1="8" x2="20" y2="14"/><line x1="23" y1="11" x2="17" y2="11"/></svg>,
      team: <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>,
      growth: <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="23 6 13.5 15.5 8.5 10.5 1 18"/><polyline points="17 6 23 6 23 12"/></svg>,
      product: <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/></svg>,
      partnership: <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M20.42 4.58a5.4 5.4 0 0 0-7.65 0l-.77.78-.77-.78a5.4 5.4 0 0 0-7.65 0C1.46 6.7 1.33 10.28 4 13l8 8 8-8c2.67-2.72 2.54-6.3.42-8.42z"/></svg>,
      press: <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M4 22h16a2 2 0 0 0 2-2V4a2 2 0 0 0-2-2H8a2 2 0 0 0-2 2v16a2 2 0 0 1-2 2Zm0 0a2 2 0 0 1-2-2v-9c0-1.1.9-2 2-2h2"/></svg>,
      podcast: <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><line x1="12" y1="19" x2="12" y2="23"/></svg>
    };
    return icons[type] || <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="10"/></svg>;
  };
  
  const getTypeColor = (type) => {
    const colors = {
      fundraising: { bg: 'bg-emerald-50', text: 'text-emerald-600', border: 'border-emerald-200' },
      hiring: { bg: 'bg-blue-50', text: 'text-blue-600', border: 'border-blue-200' },
      team: { bg: 'bg-violet-50', text: 'text-violet-600', border: 'border-violet-200' },
      growth: { bg: 'bg-emerald-50', text: 'text-emerald-600', border: 'border-emerald-200' },
      product: { bg: 'bg-pink-50', text: 'text-pink-600', border: 'border-pink-200' },
      partnership: { bg: 'bg-amber-50', text: 'text-amber-600', border: 'border-amber-200' },
      press: { bg: 'bg-stone-50', text: 'text-stone-600', border: 'border-stone-200' },
      podcast: { bg: 'bg-purple-50', text: 'text-purple-600', border: 'border-purple-200' }
    };
    return colors[type] || { bg: 'bg-stone-50', text: 'text-stone-600', border: 'border-stone-200' };
  };
  
  const getSourceIcon = (source) => {
    const lower = source.toLowerCase();
    if (lower.includes('linkedin')) return <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M16 8a6 6 0 0 1 6 6v7h-4v-7a2 2 0 0 0-2-2 2 2 0 0 0-2 2v7h-4v-7a6 6 0 0 1 6-6z"/><rect x="2" y="9" width="4" height="12"/><circle cx="4" cy="4" r="2"/></svg>;
    if (lower.includes('twitter') || lower.includes('x (')) return <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M22 4s-.7 2.1-2 3.4c1.6 10-9.4 17.3-18 11.6 2.2.1 4.4-.6 6-2C3 15.5.5 9.6 3 5c2.2 2.6 5.6 4.1 9 4-.9-4.2 4-6.6 7-3.8 1.1 0 3-1.2 3-1.2z"/></svg>;
    if (lower.includes('crunchbase')) return <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"/><line x1="3" y1="9" x2="21" y2="9"/><line x1="9" y1="21" x2="9" y2="9"/></svg>;
    if (lower.includes('techcrunch')) return <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M4 22h16a2 2 0 0 0 2-2V4a2 2 0 0 0-2-2H8a2 2 0 0 0-2 2v16a2 2 0 0 1-2 2Zm0 0a2 2 0 0 1-2-2v-9c0-1.1.9-2 2-2h2"/></svg>;
    if (lower.includes('podcast')) return <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"/></svg>;
    return <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="10"/><line x1="2" y1="12" x2="22" y2="12"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/></svg>;
  };
  
  const activityFeed = generateActivityFeed();
  
  // Filter activities
  const filteredActivities = selectedFilter === 'all' 
    ? activityFeed 
    : activityFeed.filter(a => a.companyId === selectedFilter);
  
  const formatRelativeDate = (date) => {
    const days = daysAgo(date);
    if (days === 0) return 'Today';
    if (days === 1) return 'Yesterday';
    if (days < 7) return `${days} days ago`;
    if (days < 30) return `${Math.floor(days / 7)} weeks ago`;
    return formatDate(date);
  };
  
  // Generate trajectory assessment for each company
  const getTrajectoryAssessment = (deal) => {
    const companyActivities = activityFeed.filter(a => a.companyId === deal.id);
    const positiveCount = companyActivities.filter(a => a.sentiment === 'positive').length;
    const recentActivity = companyActivities.filter(a => daysAgo(a.date) < 30).length;
    const investedDate = deal.investment?.date || deal.statusEnteredAt;
    const monthsSinceInvestment = Math.floor(daysAgo(investedDate) / 30);
    
    // Demo assessments based on company - with relative framing
    if (deal.companyName === 'CloudBase') {
      return {
        trajectory: 'accelerating',
        confidence: 'moderate',
        // Relative summary - compared to peers
        summary: 'Relative to similar DevTools companies at this stage, signals suggest accelerating execution.',
        // What changed since investment
        sinceThen: 'Since your investment: Series A closed, team grew 40%, shipped 3 major releases.',
        // Market context with comparison
        marketContext: 'Peer companies raised Series B 3-4 quarters after comparable hiring patterns. CloudBase is tracking ahead of median.',
        // Explicit comparison framing
        comparedTo: 'peers',
        uncertainty: null,
        assessedAt: new Date().toISOString()
      };
    }
    if (deal.companyName === 'Acme Analytics') {
      return {
        trajectory: 'steady',
        confidence: 'high',
        summary: 'Relative to your original thesis, execution remains consistent with expectations.',
        sinceThen: 'Since your investment: Hit $10M ARR (up from $1M), expanded to 80 employees, closed Series B.',
        marketContext: 'Analytics category exit multiples stable at 8-12x ARR. Acme tracking toward upper quartile if growth sustains.',
        comparedTo: 'thesis',
        uncertainty: null,
        assessedAt: new Date().toISOString()
      };
    }
    if (deal.companyName === 'SecureVault') {
      return {
        trajectory: 'too-early',
        confidence: 'low',
        summary: 'Too early to compare against benchmarks. Baseline still forming.',
        sinceThen: `Invested ${monthsSinceInvestment < 1 ? 'recently' : monthsSinceInvestment + ' months ago'}. Limited signal history to assess change.`,
        marketContext: 'Security category seeing increased funding. SOC 2 certification (achieved) typically unlocks enterprise pipeline within 2-3 quarters.',
        comparedTo: 'baseline',
        uncertainty: 'Insufficient signal density — check back in 60-90 days for meaningful comparison.',
        assessedAt: new Date().toISOString()
      };
    }
    
    // Default for other companies
    if (recentActivity === 0) {
      return {
        trajectory: 'unclear',
        confidence: 'low',
        summary: 'No recent signals to compare against expectations.',
        sinceThen: 'No observable changes since last assessment.',
        marketContext: null,
        comparedTo: null,
        uncertainty: 'Signal gap — no updates in 30+ days. Could be heads-down execution or concerning silence.',
        assessedAt: new Date().toISOString()
      };
    }
    
    return {
      trajectory: positiveCount > 2 ? 'steady' : 'unclear',
      confidence: 'low',
      summary: 'Limited signal history. Insufficient data for meaningful comparison.',
      sinceThen: null,
      marketContext: null,
      comparedTo: null,
      uncertainty: 'Insufficient data to assess trajectory confidently.',
      assessedAt: new Date().toISOString()
    };
  };
  
  const trajectoryConfig = {
    'accelerating': { 
      label: 'Accelerating', 
      color: '#10b981', 
      bg: 'bg-emerald-50', 
      icon: <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="23 6 13.5 15.5 8.5 10.5 1 18"/><polyline points="17 6 23 6 23 12"/></svg>
    },
    'steady': { 
      label: 'Steady', 
      color: '#5B6DC4', 
      bg: 'bg-[#5B6DC4]/10',
      icon: <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><line x1="5" y1="12" x2="19" y2="12"/><polyline points="12 5 19 12 12 19"/></svg>
    },
    'plateauing': { 
      label: 'Plateauing', 
      color: '#f59e0b', 
      bg: 'bg-amber-50',
      icon: <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><line x1="4" y1="12" x2="20" y2="12"/></svg>
    },
    'at-risk': { 
      label: 'At Risk', 
      color: '#ef4444', 
      bg: 'bg-red-50',
      icon: <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
    },
    'too-early': { 
      label: 'Too Early to Tell', 
      color: '#78716c', 
      bg: 'bg-stone-100',
      icon: <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="10"/><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>
    },
    'unclear': { 
      label: 'Unclear', 
      color: '#78716c', 
      bg: 'bg-stone-100',
      icon: <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><line x1="1" y1="1" x2="23" y2="23"/><path d="M9 9v3a3 3 0 0 0 5.12 2.12M15 9.34V9a3 3 0 0 0-5.94-.6"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>
    }
  };
  
  // Get comparison label
  const getComparisonLabel = (comparedTo) => {
    const labels = {
      'peers': 'vs. similar companies',
      'thesis': 'vs. your original thesis',
      'baseline': 'vs. investment baseline',
      'expectations': 'vs. expectations'
    };
    return labels[comparedTo] || null;
  };
  
  // Format interpretation date
  const formatInterpretationDate = (date) => {
    return new Date(date).toLocaleDateString('en-US', { month: 'short', year: 'numeric' });
  };
  
  // Get the selected company for single-company view
  const selectedCompany = selectedFilter !== 'all' ? portfolioDeals.find(d => d.id === selectedFilter) : null;
  const selectedTrajectory = selectedCompany ? getTrajectoryAssessment(selectedCompany) : null;
  
  return (
    <div className="min-h-screen bg-stone-50 dark:bg-stone-900">
      {/* Header */}
      <header className="bg-white dark:bg-stone-800 border-b border-stone-200 dark:border-stone-700 sticky top-0 z-10">
        <div className="px-6 py-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-4">
              <button onClick={onBack} className="flex items-center gap-2 text-stone-500 hover:text-stone-700">
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="15 18 9 12 15 6"/></svg>
                <span className="text-sm font-medium">Portfolio</span>
              </button>
              <div className="h-6 w-px bg-stone-200 dark:bg-stone-700"/>
              <h1 className="text-lg font-semibold text-stone-900 dark:text-white">Portfolio Context</h1>
            </div>
            <span className="text-xs text-stone-400">{portfolioDeals.length} companies</span>
          </div>
          <p className="text-sm text-stone-500 mt-1">Signals and interpretation · not predictions</p>
        </div>
      </header>
      
      {/* Company Filter Pills */}
      <div className="px-6 py-4 bg-white dark:bg-stone-800 border-b border-stone-200 dark:border-stone-700">
        <div className="flex gap-2 overflow-x-auto pb-1" style={{ scrollbarWidth: 'none' }}>
          <button
            onClick={() => setSelectedFilter('all')}
            className={`px-4 py-2 rounded-full text-sm font-medium whitespace-nowrap transition-colors ${
              selectedFilter === 'all'
                ? 'bg-stone-900 text-white'
                : 'bg-stone-100 text-stone-600 hover:bg-stone-200'
            }`}
          >
            All Companies
          </button>
          {portfolioDeals.map(deal => {
            const trajectory = getTrajectoryAssessment(deal);
            const config = trajectoryConfig[trajectory.trajectory];
            return (
              <button
                key={deal.id}
                onClick={() => setSelectedFilter(deal.id)}
                className={`px-4 py-2 rounded-full text-sm font-medium whitespace-nowrap transition-colors flex items-center gap-2 ${
                  selectedFilter === deal.id
                    ? 'bg-stone-900 text-white'
                    : 'bg-stone-100 text-stone-600 hover:bg-stone-200'
                }`}
              >
                <span 
                  className="w-2 h-2 rounded-full" 
                  style={{ backgroundColor: config.color }}
                  title={config.label}
                />
                {deal.companyName}
              </button>
            );
          })}
        </div>
      </div>
      
      {/* Trajectory Summary - Shows when single company selected */}
      {selectedCompany && selectedTrajectory && (
        <div className="px-6 py-4">
          <div className={`rounded-2xl border p-5 ${trajectoryConfig[selectedTrajectory.trajectory].bg} border-stone-200 dark:border-stone-700`}>
            {/* Company Header */}
            <div className="flex items-center justify-between mb-4">
              <div className="flex items-center gap-3">
                <div className="w-12 h-12 rounded-xl bg-white flex items-center justify-center text-lg font-bold text-stone-500 shadow-sm">
                  {selectedCompany.companyName.charAt(0)}
                </div>
                <div>
                  <h2 className="font-semibold text-stone-900">{selectedCompany.companyName}</h2>
                  <p className="text-sm text-stone-500">{selectedCompany.industry} · Invested {formatDate(selectedCompany.investment?.date || selectedCompany.statusEnteredAt)}</p>
                </div>
              </div>
              {/* Interpretation timestamp */}
              <div className="text-right">
                <p className="text-[10px] uppercase tracking-wide text-stone-400">Interpretation as of</p>
                <p className="text-xs font-medium text-stone-500">{formatInterpretationDate(selectedTrajectory.assessedAt)}</p>
              </div>
            </div>
            
            {/* Trajectory Badge + Relative Summary */}
            <div className="mb-4">
              <div className="flex items-center gap-2 mb-2">
                <span 
                  className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium"
                  style={{ backgroundColor: 'white', color: trajectoryConfig[selectedTrajectory.trajectory].color }}
                >
                  {trajectoryConfig[selectedTrajectory.trajectory].icon}
                  {trajectoryConfig[selectedTrajectory.trajectory].label}
                </span>
                {selectedTrajectory.comparedTo && (
                  <span className="text-xs text-stone-400 italic">
                    {getComparisonLabel(selectedTrajectory.comparedTo)}
                  </span>
                )}
              </div>
              <p className="text-sm text-stone-700 leading-relaxed">
                {selectedTrajectory.summary}
              </p>
            </div>
            
            {/* Since Investment - What changed */}
            {selectedTrajectory.sinceThen && (
              <div className="mb-4 p-3 rounded-lg bg-white/60 border border-stone-200/50">
                <p className="text-xs text-stone-400 uppercase tracking-wide mb-1">Since you invested</p>
                <p className="text-sm text-stone-600">{selectedTrajectory.sinceThen}</p>
              </div>
            )}
            
            {/* Market Context */}
            {selectedTrajectory.marketContext && (
              <div className="mb-4 pl-3 border-l-2 border-stone-300">
                <p className="text-xs text-stone-500 uppercase tracking-wide mb-1">Market Context</p>
                <p className="text-sm text-stone-600">{selectedTrajectory.marketContext}</p>
              </div>
            )}
            
            {/* Uncertainty Acknowledgment */}
            {selectedTrajectory.uncertainty && (
              <div className="flex items-start gap-2 p-3 rounded-lg bg-white/50 border border-stone-200">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#78716c" strokeWidth="2" className="mt-0.5 flex-shrink-0">
                  <circle cx="12" cy="12" r="10"/>
                  <path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"/>
                  <line x1="12" y1="17" x2="12.01" y2="17"/>
                </svg>
                <p className="text-sm text-stone-500">{selectedTrajectory.uncertainty}</p>
              </div>
            )}
          </div>
        </div>
      )}
      
      {/* Portfolio Overview - Shows when "All Companies" selected */}
      {selectedFilter === 'all' && (
        <div className="px-6 py-4">
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            {portfolioDeals.map(deal => {
              const trajectory = getTrajectoryAssessment(deal);
              const config = trajectoryConfig[trajectory.trajectory];
              const recentActivity = activityFeed.filter(a => a.companyId === deal.id).slice(0, 1)[0];
              
              return (
                <button
                  key={deal.id}
                  onClick={() => setSelectedFilter(deal.id)}
                  className="bg-white dark:bg-stone-800 rounded-xl p-4 border border-stone-200 dark:border-stone-700 hover:border-stone-300 transition-all text-left"
                >
                  {/* Header */}
                  <div className="flex items-center justify-between mb-3">
                    <div className="flex items-center gap-3">
                      <div className="w-10 h-10 rounded-lg bg-stone-100 flex items-center justify-center text-sm font-bold text-stone-500">
                        {deal.companyName.charAt(0)}
                      </div>
                      <div>
                        <h3 className="font-medium text-stone-900 dark:text-white">{deal.companyName}</h3>
                        <p className="text-xs text-stone-400">{deal.industry}</p>
                      </div>
                    </div>
                    <span 
                      className="w-3 h-3 rounded-full"
                      style={{ backgroundColor: config.color }}
                      title={config.label}
                    />
                  </div>
                  
                  {/* Trajectory Summary */}
                  <div className="mb-3">
                    <div className="flex items-center gap-1.5 mb-1">
                      <span style={{ color: config.color }}>{config.icon}</span>
                      <span className="text-xs font-medium" style={{ color: config.color }}>{config.label}</span>
                    </div>
                    <p className="text-xs text-stone-500 line-clamp-2">{trajectory.summary}</p>
                  </div>
                  
                  {/* Uncertainty flag if present */}
                  {trajectory.uncertainty && (
                    <div className="flex items-center gap-1.5 text-xs text-stone-400 mb-3">
                      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                        <circle cx="12" cy="12" r="10"/>
                        <path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"/>
                      </svg>
                      <span className="truncate">{trajectory.uncertainty.split('—')[0]}</span>
                    </div>
                  )}
                  
                  {/* Footer */}
                  <div className="flex items-center justify-between pt-3 border-t border-stone-100 dark:border-stone-700">
                    <span className="text-xs text-stone-400">
                      {recentActivity ? formatRelativeDate(recentActivity.date) : 'No recent signals'}
                    </span>
                    <span className="text-xs text-[#5B6DC4]">View →</span>
                  </div>
                </button>
              );
            })}
          </div>
        </div>
      )}
      
      {/* Observable Signals - Separated from interpretation */}
      <div className="px-6 py-6">
        <div className="bg-white dark:bg-stone-800 rounded-2xl border border-stone-200 dark:border-stone-700 overflow-hidden">
          <div className="p-4 border-b border-stone-100 dark:border-stone-700">
            <div className="flex items-center justify-between">
              <div>
                <h2 className="font-semibold text-stone-900 dark:text-white flex items-center gap-2">
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#78716c" strokeWidth="2">
                    <circle cx="12" cy="12" r="10"/>
                    <line x1="12" y1="16" x2="12" y2="12"/>
                    <line x1="12" y1="8" x2="12.01" y2="8"/>
                  </svg>
                  Observable Signals
                </h2>
                <p className="text-xs text-stone-400 mt-0.5">
                  Facts from third-party sources · {selectedFilter === 'all' ? 'all companies' : selectedCompany?.companyName}
                </p>
              </div>
              <span className="text-xs text-stone-400">{filteredActivities.length} signals</span>
            </div>
          </div>
          
          <div className="divide-y divide-stone-100 dark:divide-stone-700">
            {filteredActivities.length === 0 ? (
              <div className="p-8 text-center">
                <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="#d6d3d1" strokeWidth="1.5" className="mx-auto mb-3">
                  <circle cx="12" cy="12" r="10"/>
                  <path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"/>
                  <line x1="12" y1="17" x2="12.01" y2="17"/>
                </svg>
                <p className="text-stone-500 font-medium mb-1">No signals yet</p>
                <p className="text-sm text-stone-400">Observable facts will appear here as we track public sources</p>
              </div>
            ) : (
              filteredActivities.map((activity, idx) => {
                const typeColor = getTypeColor(activity.type);
                const isExpanded = expandedTimeline[activity.id];
                
                return (
                  <div key={activity.id} className="p-4 hover:bg-stone-50 dark:hover:bg-stone-700/50 transition-colors">
                    <div className="flex gap-4">
                      {/* Timeline indicator */}
                      <div className="flex flex-col items-center">
                        <div className={`w-2 h-2 rounded-full ${activity.sentiment === 'positive' ? 'bg-emerald-400' : activity.sentiment === 'negative' ? 'bg-red-400' : 'bg-stone-300'}`} />
                        {idx < filteredActivities.length - 1 && (
                          <div className="w-px flex-1 bg-stone-200 dark:bg-stone-700 mt-2" />
                        )}
                      </div>
                      
                      {/* Content */}
                      <div className="flex-1 min-w-0">
                        {/* Company + Type + Date row */}
                        <div className="flex items-center gap-2 mb-2 flex-wrap">
                          {selectedFilter === 'all' && (
                            <button
                              onClick={() => {
                                const deal = portfolioDeals.find(d => d.id === activity.companyId);
                                if (deal) onSelectCompany(deal);
                              }}
                              className="text-xs font-medium px-2 py-0.5 rounded bg-stone-100 text-stone-600 hover:bg-stone-200 transition-colors"
                            >
                              {activity.companyName}
                            </button>
                          )}
                          <span className={`text-xs px-2 py-0.5 rounded-full ${typeColor.bg} ${typeColor.text} flex items-center gap-1`}>
                            {getTypeIcon(activity.type)}
                            {activity.type}
                          </span>
                          {activity.verified && (
                            <span className="text-xs px-2 py-0.5 rounded-full bg-emerald-50 text-emerald-600 flex items-center gap-1">
                              <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3"><polyline points="20 6 9 17 4 12"/></svg>
                              Verified
                            </span>
                          )}
                          <span className="text-xs text-stone-400 ml-auto flex items-center gap-1">
                            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>
                            {formatRelativeDate(activity.date)}
                          </span>
                        </div>
                        
                        {/* Title */}
                        <h3 className="font-medium text-stone-900 dark:text-white mb-1 flex items-center gap-2">
                          {activity.title}
                          {activity.sentiment === 'positive' && (
                            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#10b981" strokeWidth="2">
                              <polyline points="23 6 13.5 15.5 8.5 10.5 1 18"/>
                            </svg>
                          )}
                        </h3>
                        
                        {/* Description */}
                        <p className="text-sm text-stone-500 dark:text-stone-400 mb-2">{activity.description}</p>
                        
                        {/* Source */}
                        <a 
                          href={activity.sourceUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="inline-flex items-center gap-1.5 text-xs text-stone-400 hover:text-[#5B6DC4] transition-colors"
                        >
                          {getSourceIcon(activity.source)}
                          {activity.source}
                          <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                            <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>
                            <polyline points="15 3 21 3 21 9"/>
                            <line x1="10" y1="14" x2="21" y2="3"/>
                          </svg>
                        </a>
                      </div>
                    </div>
                  </div>
                );
              })
            )}
          </div>
        </div>
      </div>
    </div>
  );
};

// Main App (internal, wrapped by auth)
function ConvexApp({ userMenu, syncStatus }) {
  const [page, setPage] = useState('list'); // Start at list instead of login since auth handles that
  const [activeTab, setActiveTab] = useState('active'); // 'active' | 'deferred' | 'portfolio'
  const [deals, setDeals] = useState([]);
  const [selected, setSelected] = useState(null);
  const [toast, setToast] = useState(null);
  const [filter, setFilter] = useState('all');
  const [search, setSearch] = useState('');
  const [sortBy, setSortBy] = useState('newest'); // 'newest' | 'oldest' | 'alphabetical'
  const [userPrefs, setUserPrefs] = useState(null);
  const [showAddPortfolio, setShowAddPortfolio] = useState(false);
  const [settings, setSettings] = useState(DEFAULT_SETTINGS);
  
  // Modal states for decision closure
  const [showDeferModal, setShowDeferModal] = useState(false);
  const [showInvestModal, setShowInvestModal] = useState(false);
  const [showPassModal, setShowPassModal] = useState(false);
  const [modalDeal, setModalDeal] = useState(null);

  // Theme effect - applies dark class to html element
  useEffect(() => {
    const applyTheme = () => {
      const root = document.documentElement;
      const body = document.body;
      const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
      const shouldBeDark = settings.appearance === 'dark' || (settings.appearance === 'auto' && prefersDark);
      
      if (shouldBeDark) {
        root.classList.add('dark');
        root.style.colorScheme = 'dark';
        body.style.backgroundColor = '#1c1917'; // stone-900
        body.style.color = '#fafaf9'; // stone-50
      } else {
        root.classList.remove('dark');
        root.style.colorScheme = 'light';
        body.style.backgroundColor = '#fafaf9'; // stone-50
        body.style.color = '#1c1917'; // stone-900
      }
    };

    applyTheme();

    // Listen for system preference changes when in auto mode
    const mediaQuery = window.matchMedia('(prefers-color-scheme: dark)');
    const handleChange = () => {
      if (settings.appearance === 'auto') {
        applyTheme();
      }
    };
    mediaQuery.addEventListener('change', handleChange);
    return () => mediaQuery.removeEventListener('change', handleChange);
  }, [settings.appearance]);

  useEffect(() => { setDeals(createDemoDeals()); }, []);

  // Computed deal lists for each tab
  const activeDeals = deals.filter(d => d.status === 'screening');
  const deferredDeals = deals.filter(d => d.status === 'deferred');
  const portfolioDeals = deals.filter(d => d.status === 'invested');
  const passedDeals = deals.filter(d => d.status === 'passed');

  // Counts for tabs
  const tabCounts = {
    active: activeDeals.length,
    deferred: deferredDeals.length,
    portfolio: portfolioDeals.length,
    passed: passedDeals.length
  };

  // Filter deals based on active tab
  const getFilteredDeals = () => {
    let base = [];
    if (activeTab === 'active') base = activeDeals;
    else if (activeTab === 'deferred') base = deferredDeals;
    else if (activeTab === 'portfolio') base = portfolioDeals;
    
    if (search) base = base.filter(d => d.companyName.toLowerCase().includes(search.toLowerCase()));
    
    if (filter !== 'all') {
      if (activeTab === 'deferred') {
        if (filter === 'watching') base = base.filter(d => d.deferType !== 'learning');
        if (filter === 'learning') base = base.filter(d => d.deferType === 'learning');
      } else if (activeTab === 'portfolio') {
        if (filter === 'invested') base = base.filter(d => !d.needsAttention);
        if (filter === 'needsAttention') base = base.filter(d => d.needsAttention);
      }
    }
    
    // Sort deals
    return base.sort((a, b) => {
      if (sortBy === 'newest') {
        return new Date(b.statusEnteredAt || b.createdAt).getTime() - new Date(a.statusEnteredAt || a.createdAt).getTime();
      }
      if (sortBy === 'oldest') {
        return new Date(a.statusEnteredAt || a.createdAt).getTime() - new Date(b.statusEnteredAt || b.createdAt).getTime();
      }
      if (sortBy === 'alphabetical') {
        return a.companyName.localeCompare(b.companyName);
      }
      return 0;
    });
  };

  const filtered = getFilteredDeals();

  const updateDeal = (updated) => {
    const now = new Date().toISOString();
    setDeals(prev => prev.map(d => d.id === updated.id ? { ...updated, lastActivity: now } : d));
    setSelected({ ...updated, lastActivity: now });
  };

  const addDeal = (newDeal) => {
    setDeals(prev => [newDeal, ...prev]);
    const statusLabel = STATUS_CONFIG[newDeal.status]?.label || newDeal.status;
    setToast({ message: `${newDeal.companyName} added as ${statusLabel}`, type: 'success' });
  };

  const transitionStatus = (dealId, newStatus, extras = {}) => {
    const now = new Date().toISOString();
    setDeals(prev => prev.map(d => d.id === dealId ? { ...d, status: newStatus, statusEnteredAt: now, lastActivity: now, lastAssessedAt: now, ...extras } : d));
    setSelected(prev => prev ? { ...prev, status: newStatus, statusEnteredAt: now, lastActivity: now, lastAssessedAt: now, ...extras } : null);
    setToast({ message: `Moved to ${STATUS_CONFIG[newStatus].label}`, type: 'success' });
  };

  // Decision closure handlers
  const handleDefer = (deal) => {
    setModalDeal(deal);
    setShowDeferModal(true);
  };

  const confirmDefer = (data) => {
    if (modalDeal) {
      transitionStatus(modalDeal.id, 'deferred', { 
        deferData: data,
        tracked: true // Deferred companies are tracked by default
      });
    }
    setShowDeferModal(false);
    setModalDeal(null);
  };

  const handleInvest = (deal) => {
    setModalDeal(deal);
    setShowInvestModal(true);
  };

  const confirmInvest = (data) => {
    if (modalDeal) {
      transitionStatus(modalDeal.id, 'invested', {
        investment: {
          ...modalDeal.investment,
          amount: data.amount,
          vehicle: data.vehicle,
          date: new Date().toISOString(),
          whyYes: data.whyYes
        }
      });
      // Navigate to portfolio monitor after investing
      setSelected(null);
      setPage('portfolio-monitor');
    }
    setShowInvestModal(false);
    setModalDeal(null);
  };

  const handlePass = (deal) => {
    setModalDeal(deal);
    setShowPassModal(true);
  };

  const confirmPass = (data) => {
    if (modalDeal) {
      transitionStatus(modalDeal.id, 'passed', {
        passed: {
          reason: data.reason,
          whyPass: data.whyPass,
          passedAt: new Date().toISOString()
        }
      });
    }
    setShowPassModal(false);
    setModalDeal(null);
  };

  const toggleEngagement = (dealId) => {
    setDeals(prev => prev.map(d => d.id === dealId ? { ...d, engagement: d.engagement === 'active' ? 'inactive' : 'active', lastActivity: new Date().toISOString() } : d));
    setSelected(prev => prev ? { ...prev, engagement: prev.engagement === 'active' ? 'inactive' : 'active' } : null);
  };

  const completeOnboarding = (prefs) => {
    setUserPrefs(prefs);
    setPage('list');
  };

  const skipOnboarding = () => {
    setPage('list');
  };

  // Settings page
  if (page === 'settings') return (
    <ThemeContext.Provider value={{ theme: settings.appearance, setTheme: (t) => setSettings(prev => ({ ...prev, appearance: t })) }}>
      <SettingsPage settings={settings} onUpdate={setSettings} onClose={() => setPage('list')} />
    </ThemeContext.Provider>
  );

  // Dashboard page
  if (page === 'dashboard') return (
    <ThemeContext.Provider value={{ theme: settings.appearance, setTheme: (t) => setSettings(prev => ({ ...prev, appearance: t })) }}>
      <DashboardPage deals={deals} onClose={() => setPage('list')} />
    </ThemeContext.Provider>
  );

  // Portfolio Monitor page
  if (page === 'portfolio-monitor') return (
    <ThemeContext.Provider value={{ theme: settings.appearance, setTheme: (t) => setSettings(prev => ({ ...prev, appearance: t })) }}>
      <PortfolioMonitorPage 
        deals={deals}
        selectedDeal={selected}
        onBack={() => { setSelected(null); setPage('list'); setActiveTab('portfolio'); }}
        onSelectCompany={(deal) => { setSelected(deal); }}
      />
    </ThemeContext.Provider>
  );

  // Login/Landing - Thesis design with animated orbs
  if (page === 'login') {
    // Generate orbs with different positions, sizes, speeds, and opacities
    const orbs = [
      // Top left cluster
      { id: 1, x: 5, y: 8, size: 24, opacity: 0.3, duration: 18, delay: 0 },
      { id: 2, x: 12, y: 4, size: 12, opacity: 0.2, duration: 22, delay: 2 },
      { id: 3, x: 3, y: 18, size: 8, opacity: 0.15, duration: 15, delay: 1 },
      // Top right cluster
      { id: 4, x: 88, y: 6, size: 16, opacity: 0.25, duration: 20, delay: 3 },
      { id: 5, x: 94, y: 14, size: 10, opacity: 0.2, duration: 17, delay: 0 },
      { id: 6, x: 82, y: 3, size: 6, opacity: 0.15, duration: 25, delay: 4 },
      // Left side
      { id: 7, x: 2, y: 35, size: 14, opacity: 0.2, duration: 19, delay: 2 },
      { id: 8, x: 6, y: 50, size: 20, opacity: 0.25, duration: 23, delay: 1 },
      { id: 9, x: 4, y: 65, size: 8, opacity: 0.15, duration: 16, delay: 3 },
      // Right side
      { id: 10, x: 95, y: 40, size: 18, opacity: 0.2, duration: 21, delay: 0 },
      { id: 11, x: 92, y: 55, size: 10, opacity: 0.25, duration: 18, delay: 2 },
      { id: 12, x: 97, y: 70, size: 14, opacity: 0.2, duration: 24, delay: 4 },
      // Bottom left cluster
      { id: 13, x: 8, y: 85, size: 16, opacity: 0.2, duration: 20, delay: 1 },
      { id: 14, x: 3, y: 92, size: 12, opacity: 0.25, duration: 17, delay: 3 },
      { id: 15, x: 15, y: 95, size: 8, opacity: 0.15, duration: 22, delay: 0 },
      // Bottom right cluster
      { id: 16, x: 90, y: 88, size: 20, opacity: 0.2, duration: 19, delay: 2 },
      { id: 17, x: 85, y: 94, size: 10, opacity: 0.3, duration: 16, delay: 1 },
      { id: 18, x: 96, y: 82, size: 6, opacity: 0.15, duration: 21, delay: 4 },
      // Bottom center
      { id: 19, x: 45, y: 96, size: 8, opacity: 0.15, duration: 18, delay: 2 },
      { id: 20, x: 55, y: 94, size: 10, opacity: 0.2, duration: 23, delay: 0 },
    ];

    return (
      <div className="min-h-screen bg-stone-100 dark:bg-stone-900 relative overflow-hidden">
        {/* Animated Orbs */}
        <style>{`
          @keyframes float {
            0%, 100% { transform: translate(0, 0); }
            25% { transform: translate(10px, -15px); }
            50% { transform: translate(-5px, 10px); }
            75% { transform: translate(-15px, -5px); }
          }
        `}</style>
        {orbs.map(orb => (
          <div
            key={orb.id}
            className="absolute rounded-full"
            style={{
              left: `${orb.x}%`,
              top: `${orb.y}%`,
              width: `${orb.size}px`,
              height: `${orb.size}px`,
              backgroundColor: '#5B6DC4',
              opacity: orb.opacity,
              animation: `float ${orb.duration}s ease-in-out infinite`,
              animationDelay: `${orb.delay}s`,
            }}
          />
        ))}

        {/* Content */}
        <div className="relative z-10 min-h-screen flex flex-col">
          {/* Header */}
          <header className="flex items-center justify-between px-6 py-4">
            <div className="flex items-center gap-2">
              <div className="w-8 h-8 rounded-lg flex items-center justify-center" style={{ backgroundColor: '#5B6DC4' }}>
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2.5">
                  <rect x="3" y="3" width="18" height="18" rx="2"/>
                </svg>
              </div>
              <span className="font-semibold text-stone-900 dark:text-stone-100">Thesis</span>
            </div>
            <button className="text-sm text-stone-500 dark:text-stone-400 hover:text-stone-700 dark:hover:text-stone-200">
              Log in
            </button>
          </header>

          {/* Main Content */}
          <main className="flex-1 flex flex-col items-center justify-center px-6">
            <h1 className="text-3xl md:text-4xl font-bold text-stone-900 dark:text-stone-100 text-center mb-4 max-w-lg">
              A decision system for angel investors.
            </h1>
            <p className="text-stone-500 dark:text-stone-400 text-center mb-10 max-w-md">
              Thesis isn't about finding better deals. It's about becoming a better decision-maker over time.
            </p>

            {/* CTA Button */}
            <button 
              onClick={() => setPage('howitworks')} 
              style={{ backgroundColor: '#5B6DC4' }} 
              className="px-8 py-3 text-white rounded-xl font-medium hover:opacity-90 transition-all shadow-lg mb-16"
            >
              Get Started
            </button>

            {/* Three pillars - horizontal row */}
            <div className="flex items-start justify-center gap-12 mb-8">
              <div className="text-center">
                <div className="w-14 h-14 mx-auto mb-3 flex items-center justify-center rounded-2xl bg-[#5B6DC4]/10">
                  <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="#5B6DC4" strokeWidth="1.5">
                    <line x1="5" y1="12" x2="19" y2="12"/>
                  </svg>
                </div>
                <p className="text-sm text-stone-600 dark:text-stone-400">Record decisions,<br/>not just outcomes</p>
              </div>
              <div className="text-center">
                <div className="w-14 h-14 mx-auto mb-3 flex items-center justify-center rounded-2xl bg-[#5B6DC4]/10">
                  <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="#5B6DC4" strokeWidth="1.5">
                    <circle cx="12" cy="12" r="9"/>
                    <polyline points="12 6 12 12 16 14"/>
                  </svg>
                </div>
                <p className="text-sm text-stone-600 dark:text-stone-400">See how your thinking<br/>evolves over years</p>
              </div>
              <div className="text-center">
                <div className="w-14 h-14 mx-auto mb-3 flex items-center justify-center rounded-2xl bg-[#5B6DC4]/10">
                  <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="#5B6DC4" strokeWidth="1.5">
                    <line x1="5" y1="12" x2="19" y2="12"/>
                    <polyline points="15 8 19 12 15 16"/>
                  </svg>
                </div>
                <p className="text-sm text-stone-600 dark:text-stone-400">Compare conviction<br/>to reality</p>
              </div>
            </div>
            
            <p className="text-stone-400 dark:text-stone-500 text-center text-sm">
              For operators investing alongside demanding careers — quickly and confidently.
            </p>
          </main>

          {/* Bottom decoration line */}
          <div className="flex justify-center pb-8">
            <div className="w-12 h-1 rounded-full bg-stone-300 dark:bg-stone-700 opacity-50"></div>
          </div>
        </div>
      </div>
    );
  }

  // How It Works page - shown after landing, before onboarding
  if (page === 'howitworks') {
    const steps = [
      {
        number: 1,
        title: 'Add a new lead',
        description: 'Name, stage, source. That\'s it.',
        icon: (
          <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="#5B6DC4" strokeWidth="1.5">
            <circle cx="12" cy="12" r="10"/>
            <line x1="12" y1="8" x2="12" y2="16"/>
            <line x1="8" y1="12" x2="16" y2="12"/>
          </svg>
        ),
        visual: (
          <div className="bg-white rounded-xl p-3 shadow-sm border border-stone-200 max-w-[200px]">
            <div className="flex items-center gap-2 mb-2">
              <div className="w-8 h-8 rounded-lg bg-purple-100 flex items-center justify-center text-xs font-bold text-purple-600">AI</div>
              <div>
                <p className="text-xs font-medium text-stone-800">Acme AI</p>
                <p className="text-[10px] text-stone-400">Seed · AI/ML</p>
              </div>
            </div>
            <div className="text-[10px] text-stone-500">via Sarah Chen</div>
          </div>
        )
      },
      {
        number: 2,
        title: 'Think out loud',
        description: 'Questions, concerns, gut reactions. Voice works too.',
        icon: (
          <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="#10B981" strokeWidth="1.5">
            <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>
          </svg>
        ),
        visual: (
          <div className="bg-white rounded-xl p-3 shadow-sm border border-stone-200 max-w-[200px]">
            <div className="space-y-2">
              <div className="bg-stone-100 rounded-lg p-2 text-[10px] text-stone-600">"How big is this market really?"</div>
              <div className="bg-stone-100 rounded-lg p-2 text-[10px] text-stone-600">"Team seems strong but..."</div>
              <div className="flex items-center gap-1 text-[10px] text-stone-400">
                <div className="w-2 h-2 rounded-full bg-red-400 animate-pulse"/>
                Recording...
              </div>
            </div>
          </div>
        )
      },
      {
        number: 3,
        title: 'Context fills in',
        description: 'Market size, competitors, team backgrounds. You stay in flow.',
        icon: (
          <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="#F59E0B" strokeWidth="1.5">
            <circle cx="11" cy="11" r="8"/>
            <line x1="21" y1="21" x2="16.65" y2="16.65"/>
            <line x1="11" y1="8" x2="11" y2="14"/>
            <line x1="8" y1="11" x2="14" y2="11"/>
          </svg>
        ),
        visual: (
          <div className="bg-white rounded-xl p-3 shadow-sm border border-stone-200 max-w-[200px]">
            <div className="flex items-start gap-2">
              <div className="w-5 h-5 rounded-full bg-amber-100 flex items-center justify-center flex-shrink-0">
                <span className="text-[10px]">💡</span>
              </div>
              <div>
                <p className="text-[10px] font-medium text-stone-800">Market is $24B and growing 18% YoY</p>
                <p className="text-[10px] text-blue-500 underline mt-1">Gartner 2024 →</p>
              </div>
            </div>
          </div>
        )
      },
      {
        number: 4,
        title: 'Decide and learn',
        description: 'Record your reasoning. Revisit it when outcomes are clear.',
        icon: (
          <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="#8B5CF6" strokeWidth="1.5">
            <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/>
            <polyline points="22 4 12 14.01 9 11.01"/>
          </svg>
        ),
        visual: (
          <div className="bg-white rounded-xl p-3 shadow-sm border border-stone-200 max-w-[200px]">
            <div className="flex items-center gap-2 mb-2">
              <div className="w-6 h-6 rounded-full bg-green-100 flex items-center justify-center">
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#10B981" strokeWidth="3"><polyline points="20 6 9 17 4 12"/></svg>
              </div>
              <span className="text-xs font-medium text-green-700">Invested</span>
            </div>
            <p className="text-[10px] text-stone-500 italic">"Strong team + clear wedge into enterprise..."</p>
          </div>
        )
      }
    ];

    return (
      <div className="min-h-screen bg-stone-50 dark:bg-stone-900">
        {/* Header */}
        <header className="flex items-center justify-between px-6 py-4">
          <button onClick={() => setPage('login')} className="flex items-center gap-1 text-stone-400 hover:text-stone-600">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="15 18 9 12 15 6"/></svg>
            <span className="text-sm">Back</span>
          </button>
          <button 
            onClick={() => setPage('onboarding')}
            className="text-sm font-medium"
            style={{ color: '#5B6DC4' }}
          >
            Skip
          </button>
        </header>

        {/* Content */}
        <main className="px-6 py-6 max-w-2xl mx-auto">
          <div className="text-center mb-10">
            <h1 className="text-2xl font-bold text-stone-900 dark:text-white mb-2">How Thesis Works</h1>
            <p className="text-stone-400 dark:text-stone-500 text-sm">A simple loop you'll repeat over time.</p>
          </div>

          {/* Steps - grouped as input (1-2) and reflection (3-4) */}
          <div className="space-y-6">
            {/* Input phase */}
            <div className="space-y-5">
              {steps.slice(0, 2).map((step, idx) => (
                <div key={step.number} className="flex gap-5 items-start">
                  <div className="flex flex-col items-center">
                    <div 
                      className="w-11 h-11 rounded-2xl flex items-center justify-center"
                      style={{ backgroundColor: idx === 0 ? '#5B6DC4' : '#10B981', opacity: 0.15 }}
                    >
                      {step.icon}
                    </div>
                    {idx < 1 && (
                      <div className="w-0.5 h-12 bg-stone-200 dark:bg-stone-700 mt-2"/>
                    )}
                  </div>
                  <div className="flex-1 pb-2">
                    <span className="text-[10px] font-bold text-stone-300 uppercase tracking-wide">Step {step.number}</span>
                    <h3 className="text-base font-semibold text-stone-900 dark:text-white mb-1">{step.title}</h3>
                    <p className="text-sm text-stone-500 dark:text-stone-400 mb-3">{step.description}</p>
                    {step.visual}
                  </div>
                </div>
              ))}
            </div>
            
            {/* Divider between phases */}
            <div className="flex items-center gap-3 py-2">
              <div className="flex-1 h-px bg-stone-200 dark:bg-stone-700"/>
              <span className="text-[10px] text-stone-300 dark:text-stone-600 uppercase tracking-wide">Then</span>
              <div className="flex-1 h-px bg-stone-200 dark:bg-stone-700"/>
            </div>
            
            {/* Reflection phase */}
            <div className="space-y-5">
              {steps.slice(2, 4).map((step, idx) => (
                <div key={step.number} className="flex gap-5 items-start">
                  <div className="flex flex-col items-center">
                    <div 
                      className="w-11 h-11 rounded-2xl flex items-center justify-center"
                      style={{ backgroundColor: idx === 0 ? '#F59E0B' : '#8B5CF6', opacity: 0.15 }}
                    >
                      {step.icon}
                    </div>
                    {idx < 1 && (
                      <div className="w-0.5 h-12 bg-stone-200 dark:bg-stone-700 mt-2"/>
                    )}
                  </div>
                  <div className="flex-1 pb-2">
                    <span className="text-[10px] font-bold text-stone-300 uppercase tracking-wide">Step {step.number}</span>
                    <h3 className="text-base font-semibold text-stone-900 dark:text-white mb-1">{step.title}</h3>
                    <p className="text-sm text-stone-500 dark:text-stone-400 mb-3">{step.description}</p>
                    {step.visual}
                  </div>
                </div>
              ))}
            </div>
          </div>

          {/* CTA */}
          <div className="mt-10 text-center">
            <button 
              onClick={() => setPage('onboarding')}
              style={{ backgroundColor: '#5B6DC4' }}
              className="px-8 py-3 text-white rounded-xl font-medium hover:opacity-90 transition-all shadow-lg"
            >
              Add your first company
            </button>
            <p className="text-xs text-stone-400 mt-4">Takes about 2 minutes to set up</p>
          </div>
        </main>
      </div>
    );
  }

  // Onboarding
  if (page === 'onboarding') return (
    <OnboardingFlow onComplete={completeOnboarding} onSkip={skipOnboarding} />
  );

  // Detail
  if (page === 'detail' && selected) {
    const config = STATUS_CONFIG[selected.status];
    const Views = { 'screening': ScreeningView, 'deferred': DeferredView, 'invested': InvestedView, 'passed': PassedView };
    const StageView = Views[selected.status];

    return (
      <div className="min-h-screen bg-stone-100 dark:bg-stone-900">
        {/* Header */}
        <header className="sticky top-0 z-30 bg-white dark:bg-stone-800 border-b border-stone-200 dark:border-stone-700">
          <div className="flex items-center justify-between px-6 py-4">
            <button onClick={() => setPage('list')} className="flex items-center gap-1 text-stone-500 dark:text-stone-400 hover:text-stone-700 dark:hover:text-stone-200 transition-colors">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="15 18 9 12 15 6"/></svg>
              <span className="text-sm font-medium">Pipeline</span>
            </button>
            {/* Status toggle - different for deferred */}
            {selected.status === 'deferred' ? (
              <div className="flex items-center bg-stone-100 dark:bg-stone-700 rounded-lg p-1">
                <button 
                  onClick={() => {
                    transitionStatus(selected.id, 'screening');
                  }}
                  className="px-4 py-1.5 rounded-md text-sm font-medium transition-all text-stone-500 dark:text-stone-400"
                >
                  Active
                </button>
                <button 
                  className="px-4 py-1.5 rounded-md text-sm font-medium bg-white dark:bg-stone-600 text-[#5B6DC4] shadow-sm"
                >
                  Watching
                </button>
              </div>
            ) : (
              <div className="flex items-center gap-2">
                <button 
                  onClick={() => toggleEngagement(selected.id)}
                  className={`px-3 py-1 rounded-lg text-sm font-medium transition-all ${
                    selected.engagement === 'active' 
                      ? 'bg-emerald-100 dark:bg-emerald-900/30 text-emerald-700 dark:text-emerald-400' 
                      : 'bg-stone-200 dark:bg-stone-700 text-stone-500 dark:text-stone-400'
                  }`}
                >
                  {selected.engagement === 'active' ? 'Active' : 'Inactive'}
                </button>
                <span 
                  className="px-3 py-1 rounded-lg text-sm font-medium border"
                  style={{ 
                    backgroundColor: selected.status === 'screening' ? 'rgba(91, 109, 196, 0.1)' : selected.status === 'invested' ? 'rgba(16, 185, 129, 0.1)' : 'rgba(91, 109, 196, 0.1)',
                    color: selected.status === 'screening' ? '#5B6DC4' : selected.status === 'invested' ? '#059669' : '#5B6DC4',
                    borderColor: selected.status === 'screening' ? 'rgba(91, 109, 196, 0.3)' : selected.status === 'invested' ? 'rgba(16, 185, 129, 0.3)' : 'rgba(91, 109, 196, 0.3)'
                  }}
                >
                  {config.label}
                </span>
              </div>
            )}
          </div>
        </header>
        <main className="px-6 py-6">
          {StageView && <StageView deal={selected} onUpdate={updateDeal} onTransition={(s, e) => transitionStatus(selected.id, s, e)} setToast={setToast} />}
        </main>
        {toast && <Toast message={toast.message} type={toast.type} onClose={() => setToast(null)} />}
      </div>
    );
  }

  // List with 3-tab navigation
  const getTabFilters = () => {
    if (activeTab === 'active') return [
      { key: 'all', label: 'All', count: activeDeals.length },
    ];
    if (activeTab === 'deferred') return [
      { key: 'all', label: 'All', count: deferredDeals.length },
      { key: 'watching', label: 'Watching', count: deferredDeals.filter(d => d.deferType !== 'learning').length, color: '#5B6DC4' },
      { key: 'learning', label: 'Learning', count: deferredDeals.filter(d => d.deferType === 'learning').length, color: '#5B6DC4' },
    ];
    if (activeTab === 'portfolio') return [
      { key: 'all', label: 'All', count: portfolioDeals.length },
      { key: 'invested', label: 'Invested', count: portfolioDeals.filter(d => !d.needsAttention).length, color: '#10b981' },
      { key: 'needsAttention', label: 'Needs Attention', count: portfolioDeals.filter(d => d.needsAttention).length, color: '#ef4444' },
    ];
    return [];
  };

  const tabFilters = getTabFilters();

  const getEmptyState = () => {
    if (activeTab === 'active') return { title: 'No leads yet', subtitle: 'Add a company to start evaluating. Take your time.' };
    if (activeTab === 'deferred') return { title: 'Nothing paused', subtitle: 'Deals you defer will rest here quietly.' };
    if (activeTab === 'portfolio') return { title: 'No investments yet', subtitle: 'When you invest, your portfolio builds here.' };
    return { title: 'No deals', subtitle: '' };
  };

  const emptyState = getEmptyState();

  // Get tab subtitle
  const getTabSubtitle = () => {
    if (activeTab === 'active') return 'Companies you\'re evaluating';
    if (activeTab === 'deferred') return 'Deferred doesn\'t mean no. It means not yet.';
    if (activeTab === 'portfolio') return 'Decisions you stand behind';
    return '';
  };

  return (
    <div className="min-h-screen bg-stone-100 dark:bg-stone-900">
      {/* Header */}
      <header className="bg-white dark:bg-stone-800 border-b border-stone-200 dark:border-stone-700">
        <div className="flex items-center justify-between px-6 py-4">
          <div className="flex items-center gap-3">
            <div className="flex items-center gap-2">
              <div className="w-8 h-8 rounded-lg flex items-center justify-center" style={{ backgroundColor: '#5B6DC4' }}>
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2.5">
                  <rect x="3" y="3" width="18" height="18" rx="2"/>
                </svg>
              </div>
              <span className="font-semibold text-stone-900 dark:text-stone-100">Convex</span>
            </div>
            {/* Sync Status */}
            {syncStatus}
          </div>
          <div className="flex items-center gap-3">
            <button 
              onClick={() => setPage('dashboard')}
              className="p-2 text-stone-400 hover:text-stone-600 dark:hover:text-stone-300 transition-colors"
              title="Capital & Signals"
            >
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <rect x="3" y="3" width="7" height="7" rx="1"/>
                <rect x="14" y="3" width="7" height="7" rx="1"/>
                <rect x="3" y="14" width="7" height="7" rx="1"/>
                <rect x="14" y="14" width="7" height="7" rx="1"/>
              </svg>
            </button>
            <button 
              onClick={() => setPage('settings')}
              className="p-2 text-stone-400 hover:text-stone-600 dark:hover:text-stone-300 transition-colors"
              title="Settings"
            >
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <circle cx="12" cy="12" r="3"/>
                <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"/>
              </svg>
            </button>
            <button 
              onClick={() => setShowAddPortfolio(true)}
              style={{ backgroundColor: '#5B6DC4' }}
              className="px-4 py-2 text-white text-sm font-medium rounded-xl hover:opacity-90 transition-colors flex items-center gap-1.5"
            >
              <span className="text-lg leading-none">+</span> Add Company
            </button>
            {/* User Menu */}
            {userMenu}
          </div>
        </div>

        {/* Tab Navigation */}
        <div className="px-6 pb-4">
          <div className="flex gap-1">
            <button 
              onClick={() => { setActiveTab('active'); setFilter('all'); }}
              className={`flex items-center gap-2 px-4 py-2.5 rounded-xl text-sm font-medium transition-all ${activeTab === 'active' ? 'bg-stone-100 dark:bg-stone-700 border border-stone-200 dark:border-stone-600' : 'hover:bg-stone-50 dark:hover:bg-stone-700/50'}`}
              style={{ color: activeTab === 'active' ? '#1c1917' : '#78716c' }}
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/></svg>
              Leads
              <span className="px-1.5 py-0.5 rounded text-xs font-medium" style={{ backgroundColor: activeTab === 'active' ? '#5B6DC4' : '#e7e5e4', color: activeTab === 'active' ? 'white' : '#78716c' }}>{tabCounts.active}</span>
            </button>
            <button 
              onClick={() => { setActiveTab('deferred'); setFilter('all'); }}
              className={`flex items-center gap-2 px-4 py-2.5 rounded-xl text-sm font-medium transition-all ${activeTab === 'deferred' ? 'bg-stone-100 dark:bg-stone-700 border border-stone-200 dark:border-stone-600' : 'hover:bg-stone-50 dark:hover:bg-stone-700/50'}`}
              style={{ color: activeTab === 'deferred' ? '#1c1917' : '#78716c' }}
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="10"/><line x1="10" y1="15" x2="10" y2="9"/><line x1="14" y1="15" x2="14" y2="9"/></svg>
              Deferred
              <span className="px-1.5 py-0.5 rounded text-xs font-medium" style={{ backgroundColor: activeTab === 'deferred' ? '#5B6DC4' : '#e7e5e4', color: activeTab === 'deferred' ? 'white' : '#78716c' }}>{tabCounts.deferred}</span>
            </button>
            <button 
              onClick={() => { setActiveTab('portfolio'); setFilter('all'); }}
              className={`flex items-center gap-2 px-4 py-2.5 rounded-xl text-sm font-medium transition-all ${activeTab === 'portfolio' ? 'bg-stone-100 dark:bg-stone-700 border border-stone-200 dark:border-stone-600' : 'hover:bg-stone-50 dark:hover:bg-stone-700/50'}`}
              style={{ color: activeTab === 'portfolio' ? '#1c1917' : '#78716c' }}
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M22 12h-4l-3 9L9 3l-3 9H2"/></svg>
              Portfolio
              <span className="px-1.5 py-0.5 rounded text-xs font-medium" style={{ backgroundColor: activeTab === 'portfolio' ? '#5B6DC4' : '#e7e5e4', color: activeTab === 'portfolio' ? 'white' : '#78716c' }}>{tabCounts.portfolio}</span>
            </button>
          </div>
        </div>
      </header>

      {/* Content */}
      <div className="px-6 py-6">
        {/* LEADS TAB - Momentum Summary */}
        {activeTab === 'active' && activeDeals.length > 0 && (() => {
          const dealsWithNotes = activeDeals.filter(d => d.workingNotes?.length > 0 || d.notes?.length > 0).length;
          const dealsWithProgress = activeDeals.filter(d => {
            const explored = d.workingNotes?.filter(n => n.type === 'ai' && n.userConfirmed)?.length || 0;
            return explored > 0;
          }).length;
          const upcomingReminders = activeDeals.filter(d => d.loiDue && daysUntil(d.loiDue) <= 7 && daysUntil(d.loiDue) >= 0).length;
          const dealsWithSignals = activeDeals.filter(d => d.hasNewSignal).length;
          
          return (
            <div className="mb-6 bg-white dark:bg-stone-800 rounded-2xl p-5 border border-stone-200 dark:border-stone-700">
              <div className="flex items-center justify-between mb-4">
                <div>
                  <h2 className="text-sm font-medium text-stone-900 dark:text-stone-100">Your momentum this week</h2>
                  <p className="text-xs text-stone-400 mt-0.5">Based on your activity across {activeDeals.length} active leads</p>
                </div>
                {dealsWithProgress > 0 && (
                  <div className="flex items-center gap-1.5 text-emerald-600">
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="23 6 13.5 15.5 8.5 10.5 1 18"/><polyline points="17 6 23 6 23 12"/></svg>
                    <span className="text-sm font-medium">Making progress</span>
                  </div>
                )}
              </div>
              
              <div className="grid grid-cols-4 gap-4">
                <div className="text-center">
                  <div className="text-2xl font-semibold text-stone-900 dark:text-stone-100">{dealsWithProgress}</div>
                  <div className="text-xs text-stone-500 dark:text-stone-400">in motion</div>
                </div>
                <div className="text-center">
                  <div className="text-2xl font-semibold text-stone-900 dark:text-stone-100">{dealsWithNotes}</div>
                  <div className="text-xs text-stone-500 dark:text-stone-400">with your notes</div>
                </div>
                <div className="text-center">
                  <div className={`text-2xl font-semibold ${upcomingReminders > 0 ? 'text-amber-600' : 'text-stone-900 dark:text-stone-100'}`}>
                    {upcomingReminders}
                  </div>
                  <div className="text-xs text-stone-500 dark:text-stone-400">due this week</div>
                </div>
                <div className="text-center">
                  <div className={`text-2xl font-semibold ${dealsWithSignals > 0 ? 'text-[#5B6DC4]' : 'text-stone-900 dark:text-stone-100'}`}>
                    {dealsWithSignals}
                  </div>
                  <div className="text-xs text-stone-500 dark:text-stone-400">new signals</div>
                </div>
              </div>

              {/* Process reflection - Pride through mirrors */}
              {dealsWithNotes >= 2 && (
                <div className="mt-4 pt-4 border-t border-stone-100 dark:border-stone-700">
                  <div className="flex items-start gap-2 text-stone-600 dark:text-stone-400">
                    <svg className="mt-0.5 text-stone-400" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"/></svg>
                    <p className="text-sm">
                      You've captured notes on {dealsWithNotes} of {activeDeals.length} leads. Your future self will thank you.
                    </p>
                  </div>
                </div>
              )}
            </div>
          );
        })()}

        {/* DEFERRED TAB - Relief message */}
        {activeTab === 'deferred' && deferredDeals.length > 0 && (() => {
          const dealsWithSignals = deferredDeals.filter(d => d.hasNewSignal).length;
          return (
            <>
              {/* Reframe message */}
              <div className="mb-6 text-center py-6">
                <div className="w-10 h-10 rounded-full bg-stone-100 dark:bg-stone-700 flex items-center justify-center mx-auto mb-3">
                  <svg className="text-stone-400" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M18 8h1a4 4 0 0 1 0 8h-1"/><path d="M2 8h16v9a4 4 0 0 1-4 4H6a4 4 0 0 1-4-4V8z"/><line x1="6" y1="1" x2="6" y2="4"/><line x1="10" y1="1" x2="10" y2="4"/><line x1="14" y1="1" x2="14" y2="4"/></svg>
                </div>
                <p className="text-sm text-stone-400 max-w-sm mx-auto">
                  These are conscious pauses, not forgotten deals. They'll surface when conditions change.
                </p>
              </div>

              {/* Signal alert - gentle */}
              {dealsWithSignals > 0 && (
                <div className="mb-5 bg-white dark:bg-stone-800 rounded-2xl p-4 border border-stone-200 dark:border-stone-700">
                  <div className="flex items-center gap-3">
                    <div className="w-8 h-8 rounded-full bg-[#5B6DC4]/10 flex items-center justify-center">
                      <svg className="text-[#5B6DC4]" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg>
                    </div>
                    <div>
                      <p className="text-sm text-stone-700 dark:text-stone-300">
                        <span className="font-medium">{dealsWithSignals} paused {dealsWithSignals === 1 ? 'deal has' : 'deals have'} new signals</span>
                      </p>
                      <p className="text-xs text-stone-400">Worth checking when you have a moment</p>
                    </div>
                  </div>
                </div>
              )}
            </>
          );
        })()}

        {/* PORTFOLIO TAB - Identity summary */}
        {activeTab === 'portfolio' && portfolioDeals.length > 0 && (() => {
          const totalDeployed = portfolioDeals.reduce((sum, d) => sum + (d.investment?.amount || 0), 0);
          const avgCheck = portfolioDeals.length > 0 ? totalDeployed / portfolioDeals.length : 0;
          const industries = [...new Set(portfolioDeals.map(d => d.industry))];
          const fmtCurrency = (n) => n >= 1000000 ? `$${(n / 1000000).toFixed(1)}M` : n >= 1000 ? `$${(n / 1000).toFixed(0)}K` : `$${n}`;
          
          return (
            <div className="mb-6 bg-white dark:bg-stone-800 rounded-2xl p-6 border border-stone-200 dark:border-stone-700">
              <div className="flex items-start justify-between mb-5">
                <div>
                  <h2 className="text-base font-medium text-stone-900 dark:text-stone-100">Your portfolio</h2>
                  <p className="text-sm text-stone-400 mt-0.5">
                    {portfolioDeals.length} {portfolioDeals.length === 1 ? 'company' : 'companies'} you've chosen to back
                  </p>
                </div>
                {totalDeployed > 0 && (
                  <div className="text-right">
                    <div className="text-xl font-semibold text-stone-900 dark:text-stone-100">{fmtCurrency(totalDeployed)}</div>
                    <p className="text-xs text-stone-400">deployed</p>
                  </div>
                )}
              </div>

              {/* Pattern reflection - narrative coherence */}
              <div className="pt-4 border-t border-stone-100 dark:border-stone-700 space-y-2">
                {industries.length > 0 && (
                  <div className="flex items-start gap-2 text-stone-600 dark:text-stone-400">
                    <svg className="mt-0.5 text-stone-400" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="5" r="3"/><line x1="12" y1="22" x2="12" y2="8"/><path d="M5 12H2a10 10 0 0 0 20 0h-3"/></svg>
                    <p className="text-sm">
                      You invest across <span className="font-medium text-stone-900 dark:text-stone-100">{industries.slice(0, 3).join(', ')}{industries.length > 3 ? ` +${industries.length - 3} more` : ''}</span>.
                      {avgCheck > 0 && <> Average check: {fmtCurrency(avgCheck)}.</>}
                    </p>
                  </div>
                )}
              </div>
            </div>
          );
        })()}

        {/* Subtitle + Portfolio Monitor button */}
        <div className="flex items-center justify-between mb-4">
          <p className="text-sm text-stone-500 dark:text-stone-400">
            {activeTab === 'active' ? 'Companies you\'re evaluating' : 
             activeTab === 'deferred' ? '' : 
             activeTab === 'portfolio' ? 'Companies' : ''}
          </p>
          {activeTab === 'portfolio' && portfolioDeals.length > 0 && (
            <button
              onClick={() => setPage('portfolio-monitor')}
              className="flex items-center gap-2 px-3 py-1.5 rounded-lg text-sm font-medium transition-colors"
              style={{ backgroundColor: '#5B6DC4', color: 'white' }}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <polyline points="23 6 13.5 15.5 8.5 10.5 1 18"/>
                <polyline points="17 6 23 6 23 12"/>
              </svg>
              Portfolio Context
            </button>
          )}
        </div>

        {/* Search and Filters - single row like screenshot */}
        <div className="mb-5">
          <div className="flex items-center gap-3 bg-white dark:bg-stone-800 rounded-2xl p-2 border border-stone-200 dark:border-stone-700">
            <div className="flex-1 relative">
              <svg className="absolute left-3 top-1/2 -translate-y-1/2 text-stone-400" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
              <input 
                type="search" 
                placeholder="Search companies, sectors, founders..." 
                value={search} 
                onChange={e => setSearch(e.target.value)} 
                className="w-full bg-transparent py-2 pl-10 pr-4 text-sm text-stone-900 dark:text-stone-100 placeholder-stone-400 focus:outline-none" 
              />
            </div>
            {/* Filter pills - inline with search */}
            <div className="flex gap-2">
              {tabFilters.map(f => (
                <button 
                  key={f.key} 
                  onClick={() => setFilter(f.key)} 
                  className={`px-4 py-2.5 rounded-xl text-sm font-medium whitespace-nowrap flex items-center gap-2 transition-colors ${
                    filter === f.key 
                      ? 'bg-stone-100 dark:bg-stone-700 text-stone-900 dark:text-stone-100' 
                      : 'text-stone-500 dark:text-stone-400 hover:bg-stone-50 dark:hover:bg-stone-700/50'
                  }`}
                >
                  {f.color && <span className="w-2 h-2 rounded-full" style={{ backgroundColor: f.color }}></span>}
                  {f.label}
                  <span className="text-stone-400">{f.count}</span>
                </button>
              ))}
            </div>
          </div>
        </div>

        {/* Cards */}
        <div className="space-y-3">
          {filtered.length === 0 ? (
            <div className="text-center py-16">
              <p className="text-stone-500 dark:text-stone-400 font-medium mb-1">{emptyState.title}</p>
              <p className="text-sm text-stone-400 dark:text-stone-500">{emptyState.subtitle}</p>
            </div>
          ) : (
            filtered.map(deal => {
              const founderName = deal.founders?.[0]?.name || deal.source?.name || '';
              const showLoi = deal.loiDue && (deal.status === 'screening' || deal.status === 'diligence');
              const loiDaysLeft = deal.loiDue ? daysUntil(deal.loiDue) : null;
              const formatLoiDate = () => {
                if (loiDaysLeft === null) return '';
                if (loiDaysLeft < 0) return `${Math.abs(loiDaysLeft)}d overdue`;
                if (loiDaysLeft <= 7) return `${loiDaysLeft}d`;
                return `${Math.ceil(loiDaysLeft / 7)}w`;
              };

              // Get badge styling based on status
              const getBadgeStyle = () => {
                if (deal.status === 'screening') {
                  return { bg: 'rgba(91, 109, 196, 0.1)', color: '#5B6DC4', border: 'rgba(91, 109, 196, 0.3)', label: 'Screening' };
                }
                if (deal.status === 'diligence') {
                  return { bg: 'rgba(245, 158, 11, 0.1)', color: '#d97706', border: 'rgba(245, 158, 11, 0.3)', label: 'Diligence' };
                }
                if (deal.status === 'deferred') {
                  return { bg: 'rgba(91, 109, 196, 0.1)', color: '#5B6DC4', border: 'rgba(91, 109, 196, 0.3)', label: deal.deferType === 'learning' ? 'Learning' : 'Watching' };
                }
                if (deal.status === 'invested') {
                  return deal.needsAttention 
                    ? { bg: 'rgba(239, 68, 68, 0.1)', color: '#dc2626', border: 'rgba(239, 68, 68, 0.3)', label: 'Needs Attention' }
                    : { bg: 'rgba(16, 185, 129, 0.1)', color: '#059669', border: 'rgba(16, 185, 129, 0.3)', label: 'Invested' };
                }
                return { bg: '#f5f5f4', color: '#78716c', border: '#e7e5e4', label: deal.status };
              };

              const badge = getBadgeStyle();

              // Get secondary info
              const getSecondaryInfo = () => {
                if (activeTab === 'active' && showLoi) {
                  const isUrgent = loiDaysLeft !== null && loiDaysLeft <= 5;
                  return { text: `LOI due · ${formatLoiDate()}`, color: isUrgent ? '#d97706' : '#a8a29e' };
                }
                if (activeTab === 'deferred' && deal.deferData?.conditionDetail) {
                  return { text: deal.deferData.conditionDetail, color: '#78716c', icon: '👁' };
                }
                if (activeTab === 'portfolio' && deal.portfolioMetrics) {
                  const isPositive = deal.portfolioMetrics.mrrChange?.startsWith('+');
                  return { 
                    text: `${deal.portfolioMetrics.mrrChange} MRR`, 
                    color: isPositive ? '#059669' : '#dc2626',
                    suffix: `${deal.portfolioMetrics.monthsInvested}mo`
                  };
                }
                return null;
              };

              const secondaryInfo = getSecondaryInfo();
              
              // Get qualitative hook - last note or open question
              const getQualitativeHook = () => {
                if (deal.workingNotes?.length > 0) {
                  // Find last user note or AI gap
                  const lastUserNote = [...deal.workingNotes].reverse().find(n => n.type === 'user' || n.type === 'voice');
                  const openGap = deal.workingNotes.find(n => n.type === 'ai' && n.isGap && !n.userConfirmed);
                  
                  if (openGap) {
                    return `Open question: ${openGap.keyInsight?.slice(0, 35) || 'needs exploration'}${openGap.keyInsight?.length > 35 ? '...' : ''}`;
                  }
                  if (lastUserNote) {
                    const content = lastUserNote.content?.replace(/^["']|["']$/g, '') || '';
                    return `Last note: ${content.slice(0, 35)}${content.length > 35 ? '...' : ''}`;
                  }
                }
                if (deal.notes?.length > 0) {
                  const lastNote = deal.notes[deal.notes.length - 1];
                  return `Last note: ${lastNote.slice(0, 35)}${lastNote.length > 35 ? '...' : ''}`;
                }
                return null;
              };
              
              const qualitativeHook = getQualitativeHook();
              
              // Calculate progress for Leads tab (areas explored)
              const getExploredCount = () => {
                if (!deal.workingNotes) return 0;
                const confirmedLenses = new Set(deal.workingNotes.filter(n => n.type === 'ai' && n.userConfirmed).map(n => n.lens));
                return confirmedLenses.size;
              };
              const exploredCount = getExploredCount();
              const progressPercent = (exploredCount / 5) * 100;
              
              // Check if this deal has a new signal
              const hasSignal = deal.hasNewSignal;
              
              // Get deferred reason display
              const getDeferReason = () => {
                if (!deal.deferData) return null;
                const reasons = { timing: 'Timing', conviction: 'Conviction', information: 'Information', life: 'Life happened' };
                return reasons[deal.deferData.condition] || deal.deferData.condition;
              };
              
              return (
                <div 
                  key={deal.id} 
                  onClick={() => { 
                    // Portfolio companies go to portfolio monitor, others go to detail
                    if (activeTab === 'portfolio' && deal.status === 'invested') {
                      setSelected(deal);
                      setPage('portfolio-monitor');
                    } else {
                      setSelected(deal); 
                      setPage('detail'); 
                    }
                  }}
                  className={`bg-white dark:bg-stone-800 rounded-2xl border cursor-pointer transition-all hover:shadow-sm ${
                    hasSignal && activeTab === 'active' 
                      ? 'border-[#5B6DC4]/30 shadow-sm' 
                      : activeTab === 'deferred'
                        ? 'border-stone-150 dark:border-stone-700 hover:border-stone-200'
                        : 'border-stone-200 dark:border-stone-700 hover:border-stone-300 dark:hover:border-stone-600'
                  }`}
                  style={activeTab === 'deferred' ? { borderColor: '#E7E5E4' } : {}}
                >
                  {/* Signal banner for Leads with new signals - Curiosity */}
                  {hasSignal && activeTab === 'active' && deal.signalText && (
                    <div className="px-5 py-2.5 bg-[#5B6DC4]/5 dark:bg-[#5B6DC4]/10 border-b border-[#5B6DC4]/10 rounded-t-2xl">
                      <div className="flex items-center justify-between">
                        <div className="flex items-center gap-2">
                          <svg className="text-[#5B6DC4]" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg>
                          <span className="text-sm text-stone-600 dark:text-stone-300">{deal.signalText}</span>
                        </div>
                        <span className="text-xs font-medium text-[#5B6DC4]">Worth a look →</span>
                      </div>
                    </div>
                  )}
                  
                  {/* Signal banner for Deferred - softer */}
                  {hasSignal && activeTab === 'deferred' && deal.signalText && (
                    <div className="px-5 py-2.5 bg-stone-50 dark:bg-stone-700/50 border-b border-stone-100 dark:border-stone-600 rounded-t-2xl">
                      <div className="flex items-center gap-2">
                        <svg className="text-[#5B6DC4]" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg>
                        <span className="text-sm text-stone-600 dark:text-stone-300">{deal.signalText}</span>
                        <span className="text-xs text-stone-400 ml-auto">Something shifted</span>
                      </div>
                    </div>
                  )}

                  <div className="p-5 flex items-center">
                    {/* Company Initial with progress ring for Leads */}
                    <div className="relative mr-4 flex-shrink-0">
                      <div className={`w-12 h-12 rounded-xl flex items-center justify-center ${
                        activeTab === 'deferred' 
                          ? 'bg-stone-50 dark:bg-stone-700' 
                          : activeTab === 'portfolio'
                            ? 'bg-emerald-50 dark:bg-emerald-900/30'
                            : 'bg-stone-200 dark:bg-stone-700'
                      }`}>
                        <span className={`text-lg font-semibold ${
                          activeTab === 'deferred'
                            ? 'text-stone-300 dark:text-stone-500'
                            : activeTab === 'portfolio'
                              ? 'text-emerald-600 dark:text-emerald-400'
                              : 'text-stone-500 dark:text-stone-400'
                        }`}>{deal.companyName?.charAt(0)?.toUpperCase()}</span>
                      </div>
                      {/* Progress ring for Leads - Momentum */}
                      {activeTab === 'active' && exploredCount > 0 && (
                        <svg className="absolute -inset-1 w-14 h-14" viewBox="0 0 56 56">
                          <circle cx="28" cy="28" r="26" fill="none" stroke="#E7E5E4" strokeWidth="2"/>
                          <circle cx="28" cy="28" r="26" fill="none" stroke="#5B6DC4" strokeWidth="2"
                            strokeDasharray={`${progressPercent * 1.63} 163`} strokeLinecap="round"
                            transform="rotate(-90 28 28)" className="transition-all duration-500"/>
                        </svg>
                      )}
                    </div>
                    
                    {/* Company Info */}
                    <div className="flex-1 min-w-0">
                      <h3 className={`font-semibold mb-0.5 ${
                        activeTab === 'deferred' 
                          ? 'text-stone-700 dark:text-stone-300' 
                          : 'text-stone-900 dark:text-stone-100'
                      }`}>{deal.companyName}</h3>
                      <p className={`text-sm ${
                        activeTab === 'deferred' 
                          ? 'text-stone-400 dark:text-stone-500' 
                          : 'text-stone-500 dark:text-stone-400'
                      }`}>{deal.industry} · {deal.stage}</p>
                      <p className={`text-sm ${
                        activeTab === 'deferred' 
                          ? 'text-stone-400 dark:text-stone-500' 
                          : 'text-stone-400 dark:text-stone-500'
                      }`}>{founderName}</p>
                      
                      {/* Leads: Show your note with "Your note:" prefix */}
                      {activeTab === 'active' && qualitativeHook && (
                        <p className="text-sm text-stone-500 dark:text-stone-400 mt-2 italic truncate">
                          {qualitativeHook.startsWith('Last note:') 
                            ? <><span className="text-stone-400 dark:text-stone-500 not-italic">Your note:</span> {qualitativeHook.replace('Last note: ', '')}</>
                            : qualitativeHook
                          }
                        </p>
                      )}
                      
                      {/* Deferred: Show your reasoning when you paused */}
                      {activeTab === 'deferred' && deal.deferData?.conditionDetail && (
                        <div className="mt-3 p-3 bg-stone-50 dark:bg-stone-700/50 rounded-xl">
                          <p className="text-sm text-stone-500 dark:text-stone-400 italic">"{deal.deferData.conditionDetail}"</p>
                          {deal.deferData.waitingFor && (
                            <p className="text-xs text-stone-400 dark:text-stone-500 mt-1">
                              Waiting for: {deal.deferData.waitingFor}
                            </p>
                          )}
                        </div>
                      )}
                      
                      {/* Portfolio: Show your thesis */}
                      {activeTab === 'portfolio' && deal.investment?.whyYes && (
                        <div className="mt-3 p-3 bg-stone-50 dark:bg-stone-700/50 rounded-xl">
                          <p className="text-xs text-stone-400 dark:text-stone-500 uppercase tracking-wide mb-1">Your thesis</p>
                          <p className="text-sm text-stone-600 dark:text-stone-300 line-clamp-2">"{deal.investment.whyYes}"</p>
                        </div>
                      )}
                    </div>
                  
                    {/* Right side - Badge and Info */}
                    <div className="flex flex-col items-end gap-1.5 ml-4">
                      {/* Badge - different styling for Deferred (muted) */}
                      {activeTab === 'deferred' ? (
                        <>
                          <span className="px-2.5 py-1 rounded-lg text-xs font-medium bg-stone-100 dark:bg-stone-700 text-stone-500 dark:text-stone-400">
                            {getDeferReason() || badge.label}
                          </span>
                          {deal.deferData?.deferredAt && (
                            <span className="text-xs text-stone-400 dark:text-stone-500">
                              Paused {formatRelativeTime(deal.deferData.deferredAt)}
                            </span>
                          )}
                        </>
                      ) : activeTab === 'portfolio' ? (
                        <>
                          <span className="text-sm font-medium text-stone-900 dark:text-stone-100">
                            {deal.investment?.amount ? `$${(deal.investment.amount / 1000).toFixed(0)}K` : ''}
                          </span>
                          {deal.investment?.date && (
                            <span className="text-xs text-stone-400 dark:text-stone-500">
                              {formatRelativeTime(deal.investment.date)}
                            </span>
                          )}
                        </>
                      ) : (
                        <>
                          <span 
                            className="px-2.5 py-1 rounded-lg text-xs font-medium"
                            style={{ backgroundColor: badge.bg, color: badge.color, border: `1px solid ${badge.border}` }}
                          >
                            {badge.label}
                          </span>
                          {secondaryInfo && (
                            <span className="text-xs flex items-center gap-1" style={{ color: secondaryInfo.color }}>
                              {secondaryInfo.icon && <span>{secondaryInfo.icon}</span>}
                              {secondaryInfo.text}
                              {secondaryInfo.suffix && <span className="text-stone-400 ml-1">{secondaryInfo.suffix}</span>}
                            </span>
                          )}
                        </>
                      )}
                    </div>
                  
                    {/* Chevron - more muted for Deferred */}
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" 
                      stroke={activeTab === 'deferred' ? '#d6d3d1' : '#a8a29e'} 
                      strokeWidth="2" className="ml-3 flex-shrink-0">
                      <polyline points="9 18 15 12 9 6"/>
                    </svg>
                  </div>
                </div>
              );
            })
          )}
        </div>
        
        {/* Footer messages - emotional closure for each tab */}
        {filtered.length > 0 && (
          <div className="mt-8 text-center space-y-1">
            {activeTab === 'active' && (
              <p className="text-sm text-stone-400 dark:text-stone-500">
                {(() => {
                  const inMotion = activeDeals.filter(d => {
                    const explored = d.workingNotes?.filter(n => n.type === 'ai' && n.userConfirmed)?.length || 0;
                    return explored > 0;
                  }).length;
                  if (inMotion === activeDeals.length) return "All leads in motion. You're building a deliberate practice.";
                  if (inMotion > 0) return `${inMotion} of ${activeDeals.length} leads have your attention. That's how good decisions get made.`;
                  return "Pick a company when you're ready. Thoughtful beats fast.";
                })()}
              </p>
            )}
            {activeTab === 'deferred' && (
              <p className="text-sm text-stone-400 dark:text-stone-500">
                {deferredDeals.length} {deferredDeals.length === 1 ? 'decision' : 'decisions'} resting. No rush to resolve them.
              </p>
            )}
            {activeTab === 'portfolio' && (
              <>
                <p className="text-sm text-stone-400 dark:text-stone-500">
                  {portfolioDeals.length} {portfolioDeals.length === 1 ? 'investment' : 'investments'}. Each one a deliberate choice.
                </p>
                <p className="text-xs text-stone-300 dark:text-stone-600">
                  The best investors stay curious about their own patterns
                </p>
              </>
            )}
          </div>
        )}
      </div>

      {/* Modals */}
      {showAddPortfolio && <AddPortfolioModal onClose={() => setShowAddPortfolio(false)} onAdd={addDeal} />}
      {showDeferModal && modalDeal && <DeferModal deal={modalDeal} onConfirm={confirmDefer} onClose={() => { setShowDeferModal(false); setModalDeal(null); }} />}
      {showInvestModal && modalDeal && <InvestModal deal={modalDeal} onConfirm={confirmInvest} onClose={() => { setShowInvestModal(false); setModalDeal(null); }} />}
      {showPassModal && modalDeal && <PassModal deal={modalDeal} onConfirm={confirmPass} onClose={() => { setShowPassModal(false); setModalDeal(null); }} />}
      {toast && <Toast message={toast.message} type={toast.type} onClose={() => setToast(null)} />}
    </div>
  );
}

// ============================================================================
// AUTHENTICATED APP WRAPPER
// ============================================================================

const AuthenticatedApp = () => {
  const { isAuthenticated, isLoading, user } = useAuth();
  const { loadData, saveData, syncWithBackend, isSyncing, lastSync } = useUserData();
  const [deals, setDeals] = useState([]);
  const [settings, setSettings] = useState(null);
  const [hasLoadedData, setHasLoadedData] = useState(false);
  
  // Load user data on auth
  useEffect(() => {
    if (isAuthenticated && !hasLoadedData) {
      telemetry.track('app_loaded', { userId: user?.id });
      
      // Load deals from user-isolated storage
      const storedDeals = loadData('deals');
      const storedSettings = loadData('settings');
      
      if (storedDeals && storedDeals.length > 0) {
        setDeals(storedDeals);
        telemetry.track('deals_loaded', { count: storedDeals.length });
      }
      
      if (storedSettings) {
        setSettings(storedSettings);
      }
      
      setHasLoadedData(true);
    }
  }, [isAuthenticated, hasLoadedData, loadData, user]);
  
  // Save deals when they change
  useEffect(() => {
    if (hasLoadedData && deals.length > 0) {
      saveData('deals', deals);
      // Optionally sync with backend
      // syncWithBackend(deals);
    }
  }, [deals, hasLoadedData, saveData]);
  
  // Save settings when they change
  useEffect(() => {
    if (hasLoadedData && settings) {
      saveData('settings', settings);
    }
  }, [settings, hasLoadedData, saveData]);
  
  if (isLoading) {
    return (
      <div className="min-h-screen bg-stone-50 dark:bg-stone-900 flex items-center justify-center">
        <div className="text-center">
          <div className="w-12 h-12 border-4 border-[#5B6DC4] border-t-transparent rounded-full animate-spin mx-auto mb-4"/>
          <p className="text-stone-500 dark:text-stone-400">Loading...</p>
        </div>
      </div>
    );
  }
  
  if (!isAuthenticated) {
    return <LoginPage />;
  }
  
  // Pass deals and settings to main app
  return (
    <ConvexAppWithData 
      initialDeals={deals}
      initialSettings={settings}
      onDealsChange={setDeals}
      onSettingsChange={setSettings}
      userMenu={<UserMenu />}
      syncStatus={<SyncStatus isSyncing={isSyncing} lastSync={lastSync} />}
    />
  );
};

// Wrapper that injects user data into the main app
const ConvexAppWithData = ({ 
  initialDeals, 
  initialSettings, 
  onDealsChange, 
  onSettingsChange,
  userMenu,
  syncStatus 
}) => {
  // This component bridges the auth system with the existing ConvexApp
  // For now, we'll render the existing app structure
  // The actual integration would modify ConvexApp to accept these props
  
  return (
    <ConvexApp 
      userMenu={userMenu}
      syncStatus={syncStatus}
    />
  );
};

// ============================================================================
// ROOT APP WITH PROVIDERS
// ============================================================================

const App = () => {
  const [showAuth, setShowAuth] = useState(true);
  const [user, setUser] = useState(null);
  const [hasCompletedOnboarding, setHasCompletedOnboarding] = useState(false);
  const [isNewUser, setIsNewUser] = useState(false);
  
  // Check for existing session
  useEffect(() => {
    try {
      const storedUser = localStorage.getItem('user');
      const onboardingComplete = localStorage.getItem('onboardingComplete');
      
      if (storedUser) {
        setUser(JSON.parse(storedUser));
        setShowAuth(false);
        setHasCompletedOnboarding(onboardingComplete === 'true');
      }
    } catch (e) {
      console.error('Failed to restore session', e);
    }
  }, []);
  
  const handleLogin = async (provider) => {
    // Simulate login
    const mockUser = {
      id: `user_${Math.random().toString(36).substr(2, 9)}`,
      email: `demo@${provider}.example.com`,
      name: 'Demo User',
      avatar: `https://ui-avatars.com/api/?name=Demo+User&background=5B6DC4&color=fff`,
      provider,
      createdAt: new Date().toISOString()
    };
    
    try {
      localStorage.setItem('user', JSON.stringify(mockUser));
      localStorage.setItem('authToken', `mock_token_${Date.now()}`);
      // Don't set onboardingComplete - new users need to complete it
    } catch (e) {
      console.error('Failed to save session', e);
    }
    
    setUser(mockUser);
    setShowAuth(false);
    setIsNewUser(true); // Flag this as a new signup
    setHasCompletedOnboarding(false); // New users haven't completed onboarding
  };
  
  const handleOnboardingComplete = (userPrefs) => {
    try {
      localStorage.setItem('onboardingComplete', 'true');
      if (userPrefs) {
        localStorage.setItem('userPrefs', JSON.stringify(userPrefs));
      }
    } catch (e) {
      console.error('Failed to save onboarding state', e);
    }
    setHasCompletedOnboarding(true);
    setIsNewUser(false);
  };
  
  const handleLogout = () => {
    try {
      localStorage.removeItem('user');
      localStorage.removeItem('authToken');
      localStorage.removeItem('onboardingComplete');
      localStorage.removeItem('userPrefs');
    } catch (e) {
      console.error('Failed to clear session', e);
    }
    setUser(null);
    setShowAuth(true);
    setHasCompletedOnboarding(false);
    setIsNewUser(false);
  };
  
  // Show login page if not authenticated
  if (showAuth && !user) {
    return <SimpleLoginPage onLogin={handleLogin} />;
  }
  
  // Show onboarding for new users who haven't completed it
  if (!hasCompletedOnboarding) {
    return (
      <OnboardingFlow 
        user={user}
        onComplete={handleOnboardingComplete}
        onLogout={handleLogout}
      />
    );
  }
  
  // Show main app for authenticated users who completed onboarding
  return (
    <ConvexApp 
      userMenu={<SimpleUserMenu user={user} onLogout={handleLogout} />}
      syncStatus={null}
    />
  );
};

// ============================================================================
// ONBOARDING FLOW (for new signups)
// ============================================================================

const OnboardingFlow = ({ user, onComplete, onLogout }) => {
  const [step, setStep] = useState('welcome'); // 'welcome' | 'howitworks' | 'questions'
  const [prefs, setPrefs] = useState({
    investorType: null,
    dealVolume: null,
    investmentStage: null,
    checkSize: null
  });
  
  // Welcome screen
  if (step === 'welcome') {
    return (
      <div style={{ minHeight: '100vh', background: 'linear-gradient(to bottom right, #fafaf9, #e7e5e4)', display: 'flex', flexDirection: 'column' }}>
        {/* Header */}
        <header style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '16px 24px' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <div style={{ width: '32px', height: '32px', background: '#5B6DC4', borderRadius: '8px', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2.5">
                <rect x="3" y="3" width="18" height="18" rx="2"/>
              </svg>
            </div>
            <span style={{ fontWeight: '600', color: '#1c1917' }}>Convex</span>
          </div>
          <button 
            onClick={onLogout}
            style={{ fontSize: '14px', color: '#78716c', background: 'none', border: 'none', cursor: 'pointer' }}
          >
            Sign out
          </button>
        </header>
        
        {/* Content */}
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', padding: '24px', textAlign: 'center' }}>
          <div style={{ width: '80px', height: '80px', background: '#5B6DC4', borderRadius: '20px', display: 'flex', alignItems: 'center', justifyContent: 'center', marginBottom: '24px', boxShadow: '0 10px 25px -5px rgba(91, 109, 196, 0.4)' }}>
            <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2">
              <path d="M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5"/>
            </svg>
          </div>
          
          <h1 style={{ fontSize: '28px', fontWeight: 'bold', color: '#1c1917', marginBottom: '8px' }}>
            Welcome{user?.name ? `, ${user.name.split(' ')[0]}` : ''}!
          </h1>
          <p style={{ fontSize: '16px', color: '#78716c', marginBottom: '32px', maxWidth: '400px' }}>
            Let's set up Convex to match how you invest. This takes about 2 minutes.
          </p>
          
          <button
            onClick={() => setStep('howitworks')}
            style={{
              padding: '14px 32px',
              background: '#5B6DC4',
              color: 'white',
              border: 'none',
              borderRadius: '12px',
              fontSize: '16px',
              fontWeight: '600',
              cursor: 'pointer',
              boxShadow: '0 4px 14px -3px rgba(91, 109, 196, 0.5)'
            }}
          >
            Get Started
          </button>
          
          <button
            onClick={() => onComplete(null)}
            style={{
              marginTop: '16px',
              padding: '10px 20px',
              background: 'transparent',
              color: '#a8a29e',
              border: 'none',
              fontSize: '14px',
              cursor: 'pointer'
            }}
          >
            Skip for now
          </button>
        </div>
      </div>
    );
  }
  
  // How it works screen
  if (step === 'howitworks') {
    const steps = [
      {
        number: 1,
        title: 'Capture deals quickly',
        description: 'Add companies as you hear about them. Voice notes, quick forms, or paste a deck link.',
        icon: '📥',
        color: '#5B6DC4'
      },
      {
        number: 2,
        title: 'Make decisions, not lists',
        description: 'Every deal gets a decision: Invest, Defer, or Pass. No purgatory.',
        icon: '⚖️',
        color: '#10B981'
      },
      {
        number: 3,
        title: 'Context fills in',
        description: 'Market size, competitors, team backgrounds. You stay in flow.',
        icon: '🔍',
        color: '#F59E0B'
      },
      {
        number: 4,
        title: 'Learn from outcomes',
        description: 'Record your reasoning. See how your thesis evolves over time.',
        icon: '📈',
        color: '#8B5CF6'
      }
    ];
    
    return (
      <div style={{ minHeight: '100vh', background: '#fafaf9', display: 'flex', flexDirection: 'column' }}>
        {/* Header */}
        <header style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '16px 24px' }}>
          <button 
            onClick={() => setStep('welcome')}
            style={{ display: 'flex', alignItems: 'center', gap: '4px', color: '#78716c', background: 'none', border: 'none', cursor: 'pointer', fontSize: '14px' }}
          >
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="15 18 9 12 15 6"/></svg>
            Back
          </button>
          <button 
            onClick={() => setStep('questions')}
            style={{ fontSize: '14px', color: '#5B6DC4', background: 'none', border: 'none', cursor: 'pointer', fontWeight: '500' }}
          >
            Skip
          </button>
        </header>
        
        {/* Content */}
        <div style={{ flex: 1, padding: '24px', maxWidth: '500px', margin: '0 auto' }}>
          <div style={{ textAlign: 'center', marginBottom: '32px' }}>
            <h1 style={{ fontSize: '24px', fontWeight: 'bold', color: '#1c1917', marginBottom: '8px' }}>How Convex Works</h1>
            <p style={{ color: '#78716c', fontSize: '14px' }}>A simple loop you'll repeat over time</p>
          </div>
          
          <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
            {steps.map((s) => (
              <div 
                key={s.number}
                style={{
                  background: 'white',
                  borderRadius: '16px',
                  padding: '20px',
                  border: '1px solid #e7e5e4',
                  display: 'flex',
                  gap: '16px',
                  alignItems: 'flex-start'
                }}
              >
                <div style={{
                  width: '48px',
                  height: '48px',
                  borderRadius: '12px',
                  background: `${s.color}15`,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  fontSize: '24px',
                  flexShrink: 0
                }}>
                  {s.icon}
                </div>
                <div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '4px' }}>
                    <span style={{ 
                      width: '20px', 
                      height: '20px', 
                      borderRadius: '50%', 
                      background: s.color, 
                      color: 'white', 
                      fontSize: '11px', 
                      fontWeight: '600',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center'
                    }}>
                      {s.number}
                    </span>
                    <h3 style={{ fontWeight: '600', color: '#1c1917', fontSize: '15px' }}>{s.title}</h3>
                  </div>
                  <p style={{ color: '#78716c', fontSize: '14px', lineHeight: '1.5' }}>{s.description}</p>
                </div>
              </div>
            ))}
          </div>
          
          <button
            onClick={() => setStep('questions')}
            style={{
              width: '100%',
              marginTop: '24px',
              padding: '14px',
              background: '#5B6DC4',
              color: 'white',
              border: 'none',
              borderRadius: '12px',
              fontSize: '16px',
              fontWeight: '600',
              cursor: 'pointer'
            }}
          >
            Continue
          </button>
        </div>
      </div>
    );
  }
  
  // Questions screen
  if (step === 'questions') {
    const questions = [
      {
        key: 'investorType',
        question: 'How do you invest?',
        options: [
          { value: 'solo', label: 'Solo angel', desc: 'Individual investments' },
          { value: 'syndicate', label: 'Syndicate lead', desc: 'Lead deals with co-investors' },
          { value: 'fund', label: 'Small fund', desc: 'GP of a micro-fund' }
        ]
      },
      {
        key: 'dealVolume',
        question: 'How many deals do you see per month?',
        options: [
          { value: 'low', label: '1-5', desc: 'Selective pipeline' },
          { value: 'medium', label: '5-20', desc: 'Active pipeline' },
          { value: 'high', label: '20+', desc: 'High volume' }
        ]
      },
      {
        key: 'investmentStage',
        question: 'What stage do you focus on?',
        options: [
          { value: 'pre-seed', label: 'Pre-seed', desc: 'Idea to early product' },
          { value: 'seed', label: 'Seed', desc: 'Product-market fit' },
          { value: 'mixed', label: 'Mixed', desc: 'Multiple stages' }
        ]
      },
      {
        key: 'checkSize',
        question: 'Typical check size?',
        options: [
          { value: 'small', label: '$5-25K', desc: 'Smaller bets' },
          { value: 'medium', label: '$25-100K', desc: 'Standard angel' },
          { value: 'large', label: '$100K+', desc: 'Larger positions' }
        ]
      }
    ];
    
    const currentQ = questions.find(q => !prefs[q.key]) || questions[questions.length - 1];
    const answeredCount = Object.values(prefs).filter(Boolean).length;
    const allAnswered = answeredCount === questions.length;
    
    return (
      <div style={{ minHeight: '100vh', background: '#fafaf9', display: 'flex', flexDirection: 'column' }}>
        {/* Header */}
        <header style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '16px 24px' }}>
          <button 
            onClick={() => setStep('howitworks')}
            style={{ display: 'flex', alignItems: 'center', gap: '4px', color: '#78716c', background: 'none', border: 'none', cursor: 'pointer', fontSize: '14px' }}
          >
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="15 18 9 12 15 6"/></svg>
            Back
          </button>
          <button 
            onClick={() => onComplete(prefs)}
            style={{ fontSize: '14px', color: '#5B6DC4', background: 'none', border: 'none', cursor: 'pointer', fontWeight: '500' }}
          >
            Skip
          </button>
        </header>
        
        {/* Progress */}
        <div style={{ padding: '0 24px', marginBottom: '24px' }}>
          <div style={{ display: 'flex', gap: '8px' }}>
            {questions.map((q, i) => (
              <div 
                key={q.key}
                style={{
                  flex: 1,
                  height: '4px',
                  borderRadius: '2px',
                  background: prefs[q.key] ? '#5B6DC4' : '#e7e5e4',
                  transition: 'background 0.3s'
                }}
              />
            ))}
          </div>
          <p style={{ fontSize: '12px', color: '#a8a29e', marginTop: '8px' }}>
            {answeredCount} of {questions.length} questions
          </p>
        </div>
        
        {/* Content */}
        <div style={{ flex: 1, padding: '0 24px 24px', maxWidth: '500px', margin: '0 auto', width: '100%' }}>
          {!allAnswered ? (
            <>
              <h2 style={{ fontSize: '22px', fontWeight: 'bold', color: '#1c1917', marginBottom: '24px' }}>
                {currentQ.question}
              </h2>
              
              <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
                {currentQ.options.map((opt) => (
                  <button
                    key={opt.value}
                    onClick={() => setPrefs(p => ({ ...p, [currentQ.key]: opt.value }))}
                    style={{
                      padding: '16px 20px',
                      background: prefs[currentQ.key] === opt.value ? '#5B6DC4' : 'white',
                      color: prefs[currentQ.key] === opt.value ? 'white' : '#1c1917',
                      border: `1px solid ${prefs[currentQ.key] === opt.value ? '#5B6DC4' : '#e7e5e4'}`,
                      borderRadius: '12px',
                      textAlign: 'left',
                      cursor: 'pointer',
                      transition: 'all 0.2s'
                    }}
                  >
                    <div style={{ fontWeight: '600', marginBottom: '2px' }}>{opt.label}</div>
                    <div style={{ fontSize: '13px', opacity: 0.7 }}>{opt.desc}</div>
                  </button>
                ))}
              </div>
            </>
          ) : (
            <div style={{ textAlign: 'center', paddingTop: '40px' }}>
              <div style={{ 
                width: '64px', 
                height: '64px', 
                background: '#10B981', 
                borderRadius: '50%', 
                display: 'flex', 
                alignItems: 'center', 
                justifyContent: 'center',
                margin: '0 auto 24px'
              }}>
                <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="3">
                  <polyline points="20 6 9 17 4 12"/>
                </svg>
              </div>
              
              <h2 style={{ fontSize: '24px', fontWeight: 'bold', color: '#1c1917', marginBottom: '8px' }}>
                You're all set!
              </h2>
              <p style={{ color: '#78716c', marginBottom: '32px' }}>
                Convex is configured for your investing style.
              </p>
              
              <button
                onClick={() => onComplete(prefs)}
                style={{
                  padding: '14px 32px',
                  background: '#5B6DC4',
                  color: 'white',
                  border: 'none',
                  borderRadius: '12px',
                  fontSize: '16px',
                  fontWeight: '600',
                  cursor: 'pointer'
                }}
              >
                Start Using Convex
              </button>
            </div>
          )}
        </div>
      </div>
    );
  }
  
  return null;
};

// Simple Login Page (standalone, no context needed)
const SimpleLoginPage = ({ onLogin }) => {
  const [loading, setLoading] = useState(null);
  
  const handleClick = async (provider) => {
    setLoading(provider);
    await new Promise(r => setTimeout(r, 1000));
    onLogin(provider);
  };
  
  return (
    <div style={{ minHeight: '100vh', background: 'linear-gradient(to bottom right, #fafaf9, #e7e5e4)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '16px' }}>
      <div style={{ width: '100%', maxWidth: '400px' }}>
        <div style={{ textAlign: 'center', marginBottom: '32px' }}>
          <div style={{ width: '64px', height: '64px', background: '#5B6DC4', borderRadius: '16px', display: 'flex', alignItems: 'center', justifyContent: 'center', margin: '0 auto 16px', boxShadow: '0 10px 15px -3px rgba(0,0,0,0.1)' }}>
            <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2">
              <path d="M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5"/>
            </svg>
          </div>
          <h1 style={{ fontSize: '24px', fontWeight: 'bold', color: '#1c1917', marginBottom: '8px' }}>Convex</h1>
          <p style={{ color: '#78716c' }}>Track your angel investments with clarity</p>
        </div>
        
        <div style={{ background: 'white', borderRadius: '16px', boxShadow: '0 25px 50px -12px rgba(0,0,0,0.25)', padding: '32px', border: '1px solid #e7e5e4' }}>
          <h2 style={{ fontSize: '18px', fontWeight: '600', color: '#1c1917', marginBottom: '24px', textAlign: 'center' }}>Sign in to continue</h2>
          
          <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
            {/* Google Button */}
            <button
              onClick={() => handleClick('google')}
              disabled={loading}
              style={{ 
                width: '100%', 
                display: 'flex', 
                alignItems: 'center', 
                justifyContent: 'center', 
                gap: '12px', 
                padding: '12px 16px', 
                borderRadius: '12px', 
                border: '1px solid #d1d5db', 
                background: 'white', 
                color: '#374151', 
                fontWeight: '500',
                cursor: loading ? 'not-allowed' : 'pointer',
                opacity: loading ? 0.5 : 1
              }}
            >
              {loading === 'google' ? (
                <div style={{ width: '20px', height: '20px', border: '2px solid #d1d5db', borderTopColor: '#374151', borderRadius: '50%', animation: 'spin 1s linear infinite' }}/>
              ) : (
                <svg width="20" height="20" viewBox="0 0 24 24">
                  <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"/>
                  <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"/>
                  <path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"/>
                  <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"/>
                </svg>
              )}
              Continue with Google
            </button>
            
            {/* AngelList Button */}
            <button
              onClick={() => handleClick('angellist')}
              disabled={loading}
              style={{ 
                width: '100%', 
                display: 'flex', 
                alignItems: 'center', 
                justifyContent: 'center', 
                gap: '12px', 
                padding: '12px 16px', 
                borderRadius: '12px', 
                border: '1px solid #000', 
                background: '#000', 
                color: 'white', 
                fontWeight: '500',
                cursor: loading ? 'not-allowed' : 'pointer',
                opacity: loading ? 0.5 : 1
              }}
            >
              {loading === 'angellist' ? (
                <div style={{ width: '20px', height: '20px', border: '2px solid #666', borderTopColor: 'white', borderRadius: '50%', animation: 'spin 1s linear infinite' }}/>
              ) : (
                <svg width="20" height="20" viewBox="0 0 24 24" fill="white">
                  <circle cx="12" cy="12" r="10"/>
                </svg>
              )}
              Continue with AngelList
            </button>
            
            {/* Carta Button */}
            <button
              onClick={() => handleClick('carta')}
              disabled={loading}
              style={{ 
                width: '100%', 
                display: 'flex', 
                alignItems: 'center', 
                justifyContent: 'center', 
                gap: '12px', 
                padding: '12px 16px', 
                borderRadius: '12px', 
                border: '1px solid #0066FF', 
                background: '#0066FF', 
                color: 'white', 
                fontWeight: '500',
                cursor: loading ? 'not-allowed' : 'pointer',
                opacity: loading ? 0.5 : 1
              }}
            >
              {loading === 'carta' ? (
                <div style={{ width: '20px', height: '20px', border: '2px solid #99c2ff', borderTopColor: 'white', borderRadius: '50%', animation: 'spin 1s linear infinite' }}/>
              ) : (
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2">
                  <path d="M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5"/>
                </svg>
              )}
              Continue with Carta
            </button>
          </div>
          
          <p style={{ fontSize: '12px', color: '#a8a29e', textAlign: 'center', marginTop: '24px' }}>
            By signing in, you agree to our Terms of Service and Privacy Policy
          </p>
        </div>
        
        {/* Spin animation */}
        <style>{`
          @keyframes spin {
            to { transform: rotate(360deg); }
          }
        `}</style>
      </div>
    </div>
  );
};

// Simple User Menu (standalone, no context needed)
const SimpleUserMenu = ({ user, onLogout }) => {
  const [isOpen, setIsOpen] = useState(false);
  
  if (!user) return null;
  
  return (
    <div className="relative">
      <button
        onClick={() => setIsOpen(!isOpen)}
        className="flex items-center gap-2 p-1.5 rounded-full hover:bg-stone-100 transition-colors"
      >
        <img
          src={user.avatar || `https://ui-avatars.com/api/?name=${encodeURIComponent(user.name || user.email)}&background=5B6DC4&color=fff`}
          alt={user.name || user.email}
          className="w-8 h-8 rounded-full"
        />
      </button>
      
      {isOpen && (
        <div className="absolute right-0 mt-2 w-64 bg-white rounded-xl shadow-xl border border-stone-200 py-2 z-50">
          <div className="px-4 py-3 border-b border-stone-200">
            <p className="font-medium text-stone-900 truncate">{user.name || 'User'}</p>
            <p className="text-sm text-stone-500 truncate">{user.email}</p>
            <span className="text-xs text-stone-400 capitalize">via {user.provider}</span>
          </div>
          <button
            onClick={() => { setIsOpen(false); onLogout(); }}
            className="w-full px-4 py-2 text-left text-sm text-red-600 hover:bg-red-50 flex items-center gap-2"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M9 21H5a2 2 0 01-2-2V5a2 2 0 012-2h4"/>
              <polyline points="16 17 21 12 16 7"/>
              <line x1="21" y1="12" x2="9" y2="12"/>
            </svg>
            Sign out
          </button>
        </div>
      )}
    </div>
  );
};

export default App;
