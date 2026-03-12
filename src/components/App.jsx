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

// Portfolio statuses: Invested = active portfolio. Deferred = watching. Passed = archived.
const STATUS_CONFIG = {
  'invested': { label: 'Invested', color: 'bg-emerald-500', light: 'bg-emerald-50 text-emerald-600 border border-emerald-200', question: 'Capital deployed' },
};

// Demo Data
const createDemoDeals = () => [
  // PORTFOLIO - Invested companies
  {
    id: '1', companyName: 'Form Energy', logoUrl: 'https://ui-avatars.com/api/?name=FE&background=10b981&color=fff&size=64&bold=true',
    status: 'invested', engagement: 'active', industry: 'Long-Duration Storage', stage: 'series-e',
    website: 'https://formenergy.com',
    source: { type: 'syndicate', name: 'CladoVC' },
    lastAssessedAt: new Date(Date.now() - 5*86400000).toISOString(),
    statusEnteredAt: new Date(Date.now() - 365*86400000).toISOString(),
    lastActivity: new Date(Date.now() - 5*86400000).toISOString(),
    lastUpdateReceived: new Date(Date.now() - 14*86400000).toISOString(),
    createdAt: new Date(Date.now() - 400*86400000).toISOString(),
    overview: 'Iron-air battery technology enabling multi-day energy storage at 1/10th the cost of lithium-ion. Critical infrastructure for a fully renewable grid.',
    founders: [
      { name: 'Mateo Jaramillo', role: 'CEO', background: 'Ex-Tesla VP of Energy Products, Tesla Powerwall & Megapack creator', yearsExperience: 20 },
      { name: 'Yet-Ming Chiang', role: 'Co-Founder', background: 'MIT Materials Science professor, battery chemistry pioneer', yearsExperience: 30 }
    ],
    terms: { instrument: 'Equity', proRata: false, notes: 'Series E participation' },
    documents: [
      { id: 'd1', label: 'Stock Purchase Agreement', url: 'https://drive.google.com', type: 'equity', addedAt: new Date(Date.now() - 365*86400000).toISOString() },
      { id: 'd2', label: 'K-1 2023', url: 'https://drive.google.com', type: 'tax', addedAt: new Date(Date.now() - 90*86400000).toISOString() },
    ],
    attachments: [],
    investment: {
      amount: 25000, vehicle: 'Equity', date: new Date(Date.now() - 365*86400000).toISOString(),
      ownershipPercent: 0.01,
      whyYes: 'Multi-day storage is the missing piece of the renewable grid puzzle. Iron-air chemistry is the only credible path to sub-$20/kWh at scale. Mateo built Powerwall — he knows how to ship hardware.',
      updateFrequency: 'quarterly', metricsToWatch: ['GWh capacity installed', 'Cost per kWh', 'Utility offtake contracts'],
      nextUpdateExpected: new Date(Date.now() + 20*86400000).toISOString()
    },
    monitoring: { healthStatus: 'thriving', fundraisingStatus: 'not-raising', runwayMonths: 24, wouldInvestAgain: true, wouldIntro: true, followOns: [] },
    milestones: [
      { id: 'm1', type: 'fundraising', title: 'Series E — $450M', description: 'Led by ArcelorMittal and GIC. Total raised over $1B.', date: new Date(Date.now() - 300*86400000).toISOString() },
      { id: 'm2', type: 'partnership', title: 'Georgia Power offtake', description: 'First utility-scale deployment agreement for multi-day storage', date: new Date(Date.now() - 180*86400000).toISOString() },
      { id: 'm3', type: 'product', title: 'Weirton factory groundbreaking', description: 'Manufacturing facility in West Virginia, 750 jobs', date: new Date(Date.now() - 90*86400000).toISOString() },
      { id: 'm4', type: 'update', title: 'Founder update', description: 'First battery systems rolling off the line. On track for utility delivery Q3.', date: new Date(Date.now() - 14*86400000).toISOString() }
    ]
  },
  {
    id: '2', companyName: 'Exowatt', logoUrl: 'https://ui-avatars.com/api/?name=EW&background=f59e0b&color=fff&size=64&bold=true',
    status: 'invested', engagement: 'active', industry: 'AI Energy Infrastructure', stage: 'seed',
    website: 'https://exowatt.com',
    source: { type: 'syndicate', name: 'CladoVC' },
    lastAssessedAt: new Date(Date.now() - 3*86400000).toISOString(),
    statusEnteredAt: new Date(Date.now() - 200*86400000).toISOString(),
    lastActivity: new Date(Date.now() - 3*86400000).toISOString(),
    lastUpdateReceived: new Date(Date.now() - 45*86400000).toISOString(),
    createdAt: new Date(Date.now() - 220*86400000).toISOString(),
    overview: 'Modular solar thermal energy storage systems purpose-built for AI data centers. Delivers firm, low-cost power without grid dependency.',
    founders: [
      { name: 'Joey Kline', role: 'CEO', background: 'Ex-SpaceX, energy infrastructure focus', yearsExperience: 10 },
    ],
    terms: { instrument: 'SAFE', cap: 85000000, proRata: true, mfn: false },
    documents: [
      { id: 'd1', label: 'SAFE Agreement', url: 'https://drive.google.com', type: 'safe', addedAt: new Date(Date.now() - 200*86400000).toISOString() },
    ],
    attachments: [],
    investment: {
      amount: 10000, vehicle: 'SAFE', date: new Date(Date.now() - 200*86400000).toISOString(),
      ownershipPercent: 0.02,
      whyYes: 'AI data centers are the fastest-growing power load on the planet and the grid cannot keep up. Exowatt\'s modular solar thermal sidesteps interconnection queues entirely. SpaceX-trained hardware team gives real credibility on delivery.',
      updateFrequency: 'quarterly', metricsToWatch: ['MW contracted', 'Data center pilots', 'Cost per MWh firm'],
      nextUpdateExpected: new Date(Date.now() - 10*86400000).toISOString() // overdue - shows nudge
    },
    monitoring: { healthStatus: 'stable', fundraisingStatus: 'exploring', runwayMonths: 18, wouldInvestAgain: true, wouldIntro: true, followOns: [] },
    milestones: [
      { id: 'm1', type: 'fundraising', title: 'Seed — $20M', description: 'Led by a16z with participation from Sam Altman', date: new Date(Date.now() - 190*86400000).toISOString() },
      { id: 'm2', type: 'partnership', title: 'Meta pilot announced', description: 'First hyperscaler agreement for off-grid AI compute power', date: new Date(Date.now() - 100*86400000).toISOString() },
    ]
  },
  {
    id: '3', companyName: 'Ammobia', logoUrl: 'https://ui-avatars.com/api/?name=AM&background=6366f1&color=fff&size=64&bold=true',
    status: 'invested', engagement: 'active', industry: 'Green Ammonia', stage: 'seed',
    website: 'https://ammobia.com',
    source: { type: 'syndicate', name: 'CladoVC' },
    lastAssessedAt: new Date(Date.now() - 10*86400000).toISOString(),
    statusEnteredAt: new Date(Date.now() - 150*86400000).toISOString(),
    lastActivity: new Date(Date.now() - 10*86400000).toISOString(),
    lastUpdateReceived: new Date(Date.now() - 30*86400000).toISOString(),
    createdAt: new Date(Date.now() - 170*86400000).toISOString(),
    overview: 'Electrochemical green ammonia production at the point of use. Eliminates Haber-Bosch entirely — no pipeline, no shipping, fertilizer made on-farm from air, water, and renewable electricity.',
    founders: [
      { name: 'Travis Sherck', role: 'CEO', background: 'Chemical engineering, electrosynthesis R&D', yearsExperience: 12 },
    ],
    terms: { instrument: 'SAFE', cap: 20000000, proRata: true, mfn: true },
    documents: [
      { id: 'd1', label: 'SAFE Agreement', url: 'https://drive.google.com', type: 'safe', addedAt: new Date(Date.now() - 150*86400000).toISOString() },
    ],
    attachments: [],
    investment: {
      amount: 10000, vehicle: 'SAFE', date: new Date(Date.now() - 150*86400000).toISOString(),
      ownershipPercent: 0.05,
      whyYes: 'Ammonia is the world\'s second most-produced chemical and agriculture\'s largest emissions source. Distributed electrochemical production breaks the Haber-Bosch stranglehold. Massive TAM, hard science moat, and early traction with co-ops.',
      updateFrequency: 'quarterly', metricsToWatch: ['kg NH3 per kWh', 'Pilot farm deployments', 'Cost vs. conventional'],
      nextUpdateExpected: new Date(Date.now() + 45*86400000).toISOString()
    },
    monitoring: { healthStatus: 'stable', fundraisingStatus: 'not-raising', runwayMonths: 20, wouldInvestAgain: true, wouldIntro: true, followOns: [] },
    milestones: [
      { id: 'm1', type: 'product', title: 'Bench-scale demo', description: 'Achieved target energy efficiency at lab scale — 8.5 MWh/tonne NH3', date: new Date(Date.now() - 120*86400000).toISOString() },
      { id: 'm2', type: 'partnership', title: 'Iowa co-op pilot', description: 'First on-farm deployment with 300-acre corn operation', date: new Date(Date.now() - 45*86400000).toISOString() },
      { id: 'm3', type: 'update', title: 'Founder update', description: 'Pilot running well. Yield 12% above projection. Starting conversations with two more co-ops.', date: new Date(Date.now() - 30*86400000).toISOString() }
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
    companyStatus: 'invested',
    engagement: 'active',
    // Investment fields
    investmentAmount: '',
    investmentDate: '',
    vehicle: 'SAFE',
    // Common fields
    founderName: '',
    founderRole: 'CEO',
    founderEmail: '',
    source: ''
  });

  const statusOptions = [
    { value: 'invested', label: 'Invested', description: 'Portfolio company', color: '#10b981' }
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

    // Add investment fields
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

// Document Links Section
const DOC_TYPES = [
  { value: 'safe', label: 'SAFE', icon: '📄', color: 'bg-amber-50 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400' },
  { value: 'equity', label: 'Equity Doc', icon: '📋', color: 'bg-blue-50 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400' },
  { value: 'tax', label: 'Tax Form', icon: '🧾', color: 'bg-red-50 text-red-700 dark:bg-red-900/30 dark:text-red-400' },
  { value: 'cap-table', label: 'Cap Table', icon: '📊', color: 'bg-purple-50 text-purple-700 dark:bg-purple-900/30 dark:text-purple-400' },
  { value: 'update', label: 'Investor Update', icon: '📬', color: 'bg-emerald-50 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400' },
  { value: 'other', label: 'Other', icon: '🔗', color: 'bg-stone-100 text-stone-600 dark:bg-stone-700 dark:text-stone-400' },
];

const DocumentLinksSection = ({ docs = [], onUpdate }) => {
  const [showAdd, setShowAdd] = useState(false);
  const [form, setForm] = useState({ label: '', url: '', type: 'safe' });
  const [error, setError] = useState('');

  const handleAdd = () => {
    if (!form.label.trim()) { setError('Name is required'); return; }
    if (!form.url.trim()) { setError('URL is required'); return; }
    const url = form.url.trim().startsWith('http') ? form.url.trim() : `https://${form.url.trim()}`;
    const newDoc = { id: Date.now().toString(), label: form.label.trim(), url, type: form.type, addedAt: new Date().toISOString() };
    onUpdate([...docs, newDoc]);
    setForm({ label: '', url: '', type: 'safe' });
    setError('');
    setShowAdd(false);
  };

  const handleRemove = (id) => onUpdate(docs.filter(d => d.id !== id));

  return (
    <div className="bg-white dark:bg-stone-800 rounded-2xl overflow-hidden">
      <div className="px-5 py-4 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#5B6DC4" strokeWidth="2">
            <path d="M13 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/><polyline points="13 2 13 9 20 9"/>
          </svg>
          <h3 className="text-sm font-medium text-stone-900 dark:text-white">Documents</h3>
          {docs.length > 0 && <span className="text-xs text-stone-400">({docs.length})</span>}
        </div>
        <button
          onClick={() => { setShowAdd(!showAdd); setError(''); }}
          className="text-xs font-medium text-[#5B6DC4] hover:text-[#4a5ba8] transition-colors"
        >
          {showAdd ? 'Cancel' : '+ Add link'}
        </button>
      </div>

      {/* Add form */}
      {showAdd && (
        <div className="mx-5 mb-4 p-4 bg-stone-50 dark:bg-stone-700/50 rounded-xl space-y-3">
          <div className="grid grid-cols-2 gap-2">
            {DOC_TYPES.map(t => (
              <button
                key={t.value}
                onClick={() => setForm(f => ({ ...f, type: t.value }))}
                className={`flex items-center gap-2 px-3 py-2 rounded-lg text-xs font-medium transition-all border ${
                  form.type === t.value
                    ? 'border-[#5B6DC4] bg-[#5B6DC4]/10 text-[#5B6DC4]'
                    : 'border-stone-200 dark:border-stone-600 text-stone-500 dark:text-stone-400 hover:border-stone-300'
                }`}
              >
                <span>{t.icon}</span> {t.label}
              </button>
            ))}
          </div>
          <input
            type="text"
            placeholder="Label (e.g. SAFE Agreement, K-1 2023)"
            value={form.label}
            onChange={e => { setForm(f => ({ ...f, label: e.target.value })); setError(''); }}
            className="w-full p-2.5 text-sm border border-stone-200 dark:border-stone-600 rounded-lg bg-white dark:bg-stone-800 text-stone-900 dark:text-stone-100 placeholder-stone-400 focus:outline-none focus:border-[#5B6DC4]"
          />
          <input
            type="url"
            placeholder="https://drive.google.com/..."
            value={form.url}
            onChange={e => { setForm(f => ({ ...f, url: e.target.value })); setError(''); }}
            className="w-full p-2.5 text-sm border border-stone-200 dark:border-stone-600 rounded-lg bg-white dark:bg-stone-800 text-stone-900 dark:text-stone-100 placeholder-stone-400 focus:outline-none focus:border-[#5B6DC4]"
          />
          {error && <p className="text-xs text-red-500">{error}</p>}
          <button
            onClick={handleAdd}
            className="w-full py-2 text-sm font-medium text-white rounded-lg transition-colors"
            style={{ backgroundColor: '#5B6DC4' }}
          >
            Add document
          </button>
        </div>
      )}

      {/* Document list */}
      {docs.length === 0 && !showAdd ? (
        <div className="px-5 pb-5 text-center">
          <p className="text-sm text-stone-400 dark:text-stone-500">No documents yet</p>
          <p className="text-xs text-stone-300 dark:text-stone-600 mt-1">Add links to your SAFE, tax forms, cap table, and updates</p>
        </div>
      ) : (
        <div className="px-5 pb-5 space-y-2">
          {docs.map(doc => {
            const docType = DOC_TYPES.find(t => t.value === doc.type) || DOC_TYPES[5];
            return (
              <div key={doc.id} className="flex items-center gap-3 p-3 bg-stone-50 dark:bg-stone-700/50 rounded-xl group">
                <span className={`w-8 h-8 rounded-lg flex items-center justify-center text-sm flex-shrink-0 ${docType.color}`}>
                  {docType.icon}
                </span>
                <div className="flex-1 min-w-0">
                  <a
                    href={doc.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-sm font-medium text-stone-900 dark:text-stone-100 hover:text-[#5B6DC4] dark:hover:text-[#8b9ff4] transition-colors truncate block"
                  >
                    {doc.label}
                    <svg className="inline ml-1 mb-0.5 opacity-50" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                      <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/>
                    </svg>
                  </a>
                  <p className="text-xs text-stone-400 dark:text-stone-500">{docType.label}</p>
                </div>
                <button
                  onClick={() => handleRemove(doc.id)}
                  className="opacity-0 group-hover:opacity-100 p-1 text-stone-300 hover:text-red-400 transition-all"
                >
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <path d="M3 6h18M19 6l-1 14H6L5 6M10 11v6M14 11v6M9 6V4h6v2"/>
                  </svg>
                </button>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
};

// Invested View - Clean confirmation design
const InvestedView = ({ deal, onUpdate, setToast }) => {
  const inv = deal.investment || {};
  const [showUpdateLog, setShowUpdateLog] = useState(false);
  const [showAddUpdate, setShowAddUpdate] = useState(false);
  const [newUpdateNote, setNewUpdateNote] = useState('');

  // Update log nudge logic
  const lastUpdate = inv.lastUpdateReceived || deal.lastUpdateReceived;
  const nextExpected = inv.nextUpdateExpected || deal.nextUpdateExpected;
  const daysSinceUpdate = lastUpdate ? Math.floor((Date.now() - new Date(lastUpdate).getTime()) / 86400000) : null;
  const daysUntilNext = nextExpected ? Math.floor((new Date(nextExpected).getTime() - Date.now()) / 86400000) : null;
  const updateOverdue = daysUntilNext !== null && daysUntilNext < -7;
  const updateDueSoon = daysUntilNext !== null && daysUntilNext >= -7 && daysUntilNext <= 14;

  // Update log entries from milestones typed as 'update'
  const updateEntries = (deal.milestones || [])
    .filter(m => m.type === 'update' || m.type === 'investor-update')
    .sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());

  const handleAddUpdate = () => {
    if (!newUpdateNote.trim()) return;
    const updated = {
      ...deal,
      milestones: [...(deal.milestones || []), {
        id: `u-${Date.now()}`,
        type: 'update',
        title: 'Founder update',
        description: newUpdateNote.trim(),
        date: new Date().toISOString()
      }],
      lastUpdateReceived: new Date().toISOString()
    };
    onUpdate(updated);
    setNewUpdateNote('');
    setShowAddUpdate(false);
    if (setToast) setToast({ message: 'Update logged', type: 'success' });
  };

  const handleUpdateDocs = (newDocs) => {
    onUpdate({ ...deal, documents: newDocs });
  };

  return (
    <div className="space-y-4">
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
              {deal.website && (
                <a href={deal.website} target="_blank" rel="noopener noreferrer" className="text-stone-400 hover:text-stone-600">
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/>
                  </svg>
                </a>
              )}
            </div>
            <p className="text-sm text-stone-500 dark:text-stone-400">{deal.stage} · {deal.industry}</p>
          </div>
        </div>

        {deal.overview && (
          <p className="mt-4 text-stone-600 dark:text-stone-300 text-sm leading-relaxed">{deal.overview}</p>
        )}

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

      {/* Investment Summary */}
      <div className="bg-white dark:bg-stone-800 rounded-2xl p-5">
        <div className="flex items-center gap-2 mb-4">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#10b981" strokeWidth="2">
            <circle cx="12" cy="12" r="10"/><line x1="12" y1="6" x2="12" y2="18"/>
            <path d="M15 9.5c0-1.5-1.5-2.5-3-2.5s-3 .5-3 2.5c0 1.5 1.5 2 3 2.5s3 1 3 2.5c0 1.5-1.5 2.5-3 2.5s-3-1-3-2.5"/>
          </svg>
          <h3 className="font-medium text-stone-900 dark:text-white">Investment</h3>
        </div>
        <div className="grid grid-cols-2 gap-4">
          {inv.amount && (
            <div>
              <p className="text-xs text-stone-400 uppercase tracking-wide mb-1">Amount</p>
              <p className="text-lg font-semibold text-stone-900 dark:text-stone-100">${(inv.amount / 1000).toFixed(0)}K</p>
            </div>
          )}
          {inv.vehicle && (
            <div>
              <p className="text-xs text-stone-400 uppercase tracking-wide mb-1">Vehicle</p>
              <p className="text-sm font-medium text-stone-900 dark:text-stone-100">{inv.vehicle}</p>
            </div>
          )}
          {inv.ownershipPercent && (
            <div>
              <p className="text-xs text-stone-400 uppercase tracking-wide mb-1">Ownership</p>
              <p className="text-sm font-medium text-stone-900 dark:text-stone-100">{inv.ownershipPercent}%</p>
            </div>
          )}
          {inv.date && (
            <div>
              <p className="text-xs text-stone-400 uppercase tracking-wide mb-1">Date</p>
              <p className="text-sm font-medium text-stone-900 dark:text-stone-100">
                {new Date(inv.date).toLocaleDateString('en-US', { month: 'short', year: 'numeric' })}
              </p>
            </div>
          )}
        </div>
        {(inv.whyYes || deal.investReasoning) && (
          <div className="mt-4 pt-4 border-t border-stone-100 dark:border-stone-700">
            <p className="text-xs text-stone-400 uppercase tracking-wide mb-2">Your thesis</p>
            <p className="text-sm text-stone-600 dark:text-stone-400 italic">"{inv.whyYes || deal.investReasoning}"</p>
          </div>
        )}
      </div>

      {/* Update Log */}
      <div className="bg-white dark:bg-stone-800 rounded-2xl overflow-hidden">
        {/* Nudge banner */}
        {updateOverdue && (
          <div className="px-5 py-3 flex items-center gap-3" style={{ backgroundColor: '#FEF3C7', borderBottom: '1px solid #FDE68A' }}>
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="#D97706" strokeWidth="2">
              <circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/>
            </svg>
            <p className="text-sm text-amber-800">
              Update overdue by {Math.abs(daysUntilNext)} days — worth nudging the founder?
            </p>
          </div>
        )}
        {updateDueSoon && !updateOverdue && (
          <div className="px-5 py-3 flex items-center gap-3" style={{ backgroundColor: '#F0FDF4', borderBottom: '1px solid #BBF7D0' }}>
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="#16A34A" strokeWidth="2">
              <circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>
            </svg>
            <p className="text-sm text-emerald-800">
              {daysUntilNext > 0 ? `Update expected in ${daysUntilNext} days` : 'Update expected today'}
            </p>
          </div>
        )}

        <button
          onClick={() => setShowUpdateLog(!showUpdateLog)}
          className="w-full px-5 py-4 flex items-center justify-between hover:bg-stone-50 dark:hover:bg-stone-700/50 transition-colors"
        >
          <div className="flex items-center gap-2">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#78716c" strokeWidth="2">
              <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>
            </svg>
            <span className="text-sm font-medium text-stone-700 dark:text-stone-300">Update log</span>
            {updateEntries.length > 0 && (
              <span className="text-xs text-stone-400">({updateEntries.length})</span>
            )}
            {daysSinceUpdate !== null && (
              <span className={`text-xs px-2 py-0.5 rounded-full ${updateOverdue ? 'bg-amber-100 text-amber-700' : 'bg-stone-100 dark:bg-stone-700 text-stone-500 dark:text-stone-400'}`}>
                Last {daysSinceUpdate}d ago
              </span>
            )}
          </div>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#a8a29e" strokeWidth="2"
            className={`transition-transform ${showUpdateLog ? 'rotate-180' : ''}`}>
            <polyline points="6 9 12 15 18 9"/>
          </svg>
        </button>

        {showUpdateLog && (
          <div className="px-5 pb-5 border-t border-stone-100 dark:border-stone-700">
            <div className="pt-4 space-y-3">
              {updateEntries.length === 0 && !showAddUpdate && (
                <p className="text-sm text-stone-400 dark:text-stone-500 text-center py-2">No updates logged yet</p>
              )}
              {updateEntries.map(entry => (
                <div key={entry.id} className="flex gap-3">
                  <div className="w-1.5 h-1.5 rounded-full bg-stone-300 dark:bg-stone-600 mt-2 flex-shrink-0" />
                  <div>
                    <p className="text-sm text-stone-700 dark:text-stone-300">{entry.description}</p>
                    <p className="text-xs text-stone-400 mt-0.5">
                      {new Date(entry.date).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}
                    </p>
                  </div>
                </div>
              ))}

              {showAddUpdate ? (
                <div className="space-y-2 pt-1">
                  <textarea
                    value={newUpdateNote}
                    onChange={e => setNewUpdateNote(e.target.value)}
                    placeholder="What did you hear from the founder? Revenue milestone, new hire, next round timing..."
                    rows={3}
                    className="w-full p-3 text-sm border border-stone-200 dark:border-stone-600 rounded-xl bg-white dark:bg-stone-800 text-stone-900 dark:text-stone-100 placeholder-stone-400 focus:outline-none focus:border-[#5B6DC4] resize-none"
                    autoFocus
                  />
                  <div className="flex gap-2">
                    <button
                      onClick={handleAddUpdate}
                      className="flex-1 py-2 text-sm font-medium text-white rounded-lg"
                      style={{ backgroundColor: '#5B6DC4' }}
                    >
                      Log update
                    </button>
                    <button
                      onClick={() => { setShowAddUpdate(false); setNewUpdateNote(''); }}
                      className="px-4 py-2 text-sm text-stone-500 hover:text-stone-700 transition-colors"
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              ) : (
                <button
                  onClick={() => setShowAddUpdate(true)}
                  className="text-sm text-[#5B6DC4] hover:text-[#4a5ba8] transition-colors"
                >
                  + Log update
                </button>
              )}
            </div>
          </div>
        )}
      </div>

      {/* Document Links */}
      <DocumentLinksSection
        docs={deal.documents || []}
        onUpdate={handleUpdateDocs}
      />

    </div>
  );
};

// Monitoring View
// Passed View

// Portfolio Monitor Page - Health tracking and news feed for invested companies
const PortfolioMonitorPage = ({ deals, onBack, onSelectCompany, selectedDeal }) => {
  const [selectedFilter, setSelectedFilter] = useState(selectedDeal?.id || 'all');
  const [expandedTimeline, setExpandedTimeline] = useState({});
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [lastRefreshed, setLastRefreshed] = useState(null);
  const [shareModalSignal, setShareModalSignal] = useState(null);
  const [copiedLink, setCopiedLink] = useState(false);
  
  // Get only invested companies
  const portfolioDeals = deals.filter(d => d.status === 'invested').sort((a, b) => 
    new Date(b.investment?.date || b.statusEnteredAt).getTime() - new Date(a.investment?.date || a.statusEnteredAt).getTime()
  );
  
  // Generate activity feed from all portfolio companies
  const [fetchedSignals, setFetchedSignals] = useState({});
  const [signalError, setSignalError] = useState(null);

  // Fetch real signals via Claude API with web search
  const fetchSignalsForCompany = async (deal) => {
    try {
      const response = await fetch("/api/signals", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          companyName: deal.companyName,
          industry: deal.industry,
          website: deal.website || null
        })
      });

      const data = await response.json();
      const signals = Array.isArray(data.signals) ? data.signals : [];
      return signals;
    } catch (e) {
      console.error(`Signal fetch failed for ${deal.companyName}:`, e);
      return [];
    }
  };

  const fetchAllSignals = async () => {
    setIsRefreshing(true);
    setSignalError(null);
    try {
      const results = [];
      for (let i = 0; i < portfolioDeals.length; i++) {
        if (i > 0) await new Promise(r => setTimeout(r, 4000)); // 4s between requests
        const deal = portfolioDeals[i];
        const signals = await fetchSignalsForCompany(deal);
        results.push({ dealId: deal.id, signals });
      }
      const byDeal = {};
      results.forEach(r => { byDeal[r.dealId] = r.signals; });
      setFetchedSignals(byDeal);
      setLastRefreshed(new Date());
    } catch (e) {
      setSignalError('Could not fetch signals. Showing milestones only.');
    } finally {
      setIsRefreshing(false);
    }
  };

  // Fetch on mount
  useEffect(() => { fetchAllSignals(); }, []);

  const generateActivityFeed = () => {
    const activities = [];
    
    portfolioDeals.forEach(deal => {
      // Only add fetched live signals - no hardcoded milestones
      const signals = fetchedSignals[deal.id] || [];
      signals.forEach((s, i) => {
        activities.push({
          id: `${deal.id}-fetched-${i}`,
          companyId: deal.id,
          companyName: deal.companyName,
          type: s.type || 'press',
          title: s.title,
          description: s.description,
          date: s.date || new Date().toISOString(),
          source: s.source || 'Web',
          sourceUrl: s.sourceUrl || null,
          verified: true,
          sentiment: s.sentiment || 'neutral',
          isLive: true
        });
      });
    });
    
    return activities.sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());
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
      icon: <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>
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
            <div className="flex items-center gap-3">
              <button 
                onClick={fetchAllSignals}
                disabled={isRefreshing}
                className="flex items-center gap-2 px-3 py-1.5 rounded-lg text-sm font-medium bg-stone-100 dark:bg-stone-700 text-stone-600 dark:text-stone-300 hover:bg-stone-200 dark:hover:bg-stone-600 transition-colors disabled:opacity-50"
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className={isRefreshing ? 'animate-spin' : ''}>
                  <path d="M23 4v6h-6"/><path d="M1 20v-6h6"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/>
                </svg>
                {isRefreshing ? 'Searching...' : 'Pull Updates'}
              </button>
              <span className="text-xs text-stone-400">{portfolioDeals.length} companies</span>
            </div>
          </div>
          <p className="text-sm text-stone-500 mt-1">
            Signals and interpretation · not predictions
            {lastRefreshed && <span className="ml-2 text-stone-400">· Last checked {formatRelativeDate(lastRefreshed)}</span>}
          </p>
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
                  <line x1="12" y1="16" x2="12" y2="12"/>
                  <line x1="12" y1="8" x2="12.01" y2="8"/>
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
                        <line x1="12" y1="16" x2="12" y2="12"/>
                        <line x1="12" y1="8" x2="12.01" y2="8"/>
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
                    <path d="M22 12h-4l-3 9L9 3l-3 9H2"/>
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

          {/* Error banner */}
          {signalError && (
            <div className="mx-4 mt-3 px-4 py-3 bg-amber-50 border border-amber-200 rounded-xl flex items-center gap-2">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#d97706" strokeWidth="2"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
              <p className="text-xs text-amber-800">{signalError}</p>
            </div>
          )}
          
          <div className="divide-y divide-stone-100 dark:divide-stone-700">
            {/* Loading skeleton */}
            {isRefreshing && filteredActivities.length === 0 && (
              <div className="p-4 space-y-4">
                {[1,2,3].map(i => (
                  <div key={i} className="flex gap-4 animate-pulse">
                    <div className="w-2 h-2 rounded-full bg-stone-200 mt-1.5 flex-shrink-0"/>
                    <div className="flex-1 space-y-2">
                      <div className="flex gap-2">
                        <div className="h-4 w-16 bg-stone-200 rounded-full"/>
                        <div className="h-4 w-12 bg-stone-200 rounded-full"/>
                      </div>
                      <div className="h-4 w-3/4 bg-stone-200 rounded"/>
                      <div className="h-3 w-1/2 bg-stone-100 rounded"/>
                    </div>
                  </div>
                ))}
                <p className="text-xs text-stone-400 text-center pt-2">Searching web for latest signals…</p>
              </div>
            )}
            {!isRefreshing && filteredActivities.length === 0 ? (
              <div className="p-8 text-center">
                <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="#d6d3d1" strokeWidth="1.5" className="mx-auto mb-3">
                  <path d="M22 12h-4l-3 9L9 3l-3 9H2"/>
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
                          {activity.isLive && (
                            <span className="text-xs px-2 py-0.5 rounded-full bg-blue-50 text-blue-600 flex items-center gap-1">
                              <svg width="8" height="8" viewBox="0 0 10 10"><circle cx="5" cy="5" r="5" fill="#3b82f6"/></svg>
                              Live
                            </span>
                          )}
                          {activity.verified && !activity.isLive && (
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
                        
                        {/* Source + Share */}
                        <div className="flex items-center justify-between">
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
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              setShareModalSignal(activity);
                            }}
                            className="flex items-center gap-1.5 text-xs text-stone-400 hover:text-[#5B6DC4] transition-colors px-2 py-1 rounded hover:bg-stone-100 dark:hover:bg-stone-700"
                          >
                            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                              <circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/>
                              <line x1="8.59" y1="13.51" x2="15.42" y2="17.49"/><line x1="15.41" y1="6.51" x2="8.59" y2="10.49"/>
                            </svg>
                            Share
                          </button>
                        </div>
                      </div>
                    </div>
                  </div>
                );
              })
            )}
          </div>
        </div>
      </div>
      
      {/* Share Signal Modal */}
      {shareModalSignal && (
        <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4" onClick={() => setShareModalSignal(null)}>
          <div className="bg-white dark:bg-stone-800 rounded-2xl shadow-xl max-w-md w-full" onClick={e => e.stopPropagation()}>
            <div className="p-6 border-b border-stone-200 dark:border-stone-700">
              <h2 className="text-lg font-semibold text-stone-900 dark:text-white">Share Signal</h2>
              <p className="text-sm text-stone-500 mt-1">Share this update with co-investors or advisors</p>
            </div>
            
            <div className="p-6">
              {/* Signal Preview */}
              <div className="bg-stone-50 dark:bg-stone-700/50 rounded-xl p-4 mb-4">
                <div className="flex items-center gap-2 mb-2">
                  <span className="text-xs font-medium text-stone-600 dark:text-stone-300">{shareModalSignal.companyName}</span>
                  <span className="text-xs text-stone-400">·</span>
                  <span className="text-xs text-stone-400">{shareModalSignal.type}</span>
                </div>
                <p className="font-medium text-stone-900 dark:text-white text-sm">{shareModalSignal.title}</p>
                <p className="text-xs text-stone-500 mt-1">{shareModalSignal.description}</p>
              </div>
              
              {/* Share Options */}
              <div className="space-y-3">
                <button
                  onClick={() => {
                    const text = `${shareModalSignal.companyName} update: ${shareModalSignal.title}\n\n${shareModalSignal.description}\n\nSource: ${shareModalSignal.source}`;
                    navigator.clipboard.writeText(text);
                    setCopiedLink(true);
                    setTimeout(() => setCopiedLink(false), 2000);
                  }}
                  className="w-full flex items-center gap-3 p-3 rounded-xl bg-stone-100 dark:bg-stone-700 hover:bg-stone-200 dark:hover:bg-stone-600 transition-colors"
                >
                  <div className="w-10 h-10 rounded-full bg-stone-200 dark:bg-stone-600 flex items-center justify-center">
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#78716c" strokeWidth="2">
                      <rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>
                    </svg>
                  </div>
                  <div className="flex-1 text-left">
                    <p className="font-medium text-stone-900 dark:text-white text-sm">{copiedLink ? 'Copied!' : 'Copy to Clipboard'}</p>
                    <p className="text-xs text-stone-500">Share via email, Slack, or text</p>
                  </div>
                </button>
                
                <button
                  onClick={() => {
                    const text = encodeURIComponent(`${shareModalSignal.companyName}: ${shareModalSignal.title}`);
                    const url = encodeURIComponent(shareModalSignal.sourceUrl || '');
                    window.open(`mailto:?subject=${text}&body=${encodeURIComponent(shareModalSignal.description)}%0A%0ASource: ${url}`, '_blank');
                  }}
                  className="w-full flex items-center gap-3 p-3 rounded-xl bg-stone-100 dark:bg-stone-700 hover:bg-stone-200 dark:hover:bg-stone-600 transition-colors"
                >
                  <div className="w-10 h-10 rounded-full bg-stone-200 dark:bg-stone-600 flex items-center justify-center">
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#78716c" strokeWidth="2">
                      <path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z"/>
                      <polyline points="22,6 12,13 2,6"/>
                    </svg>
                  </div>
                  <div className="flex-1 text-left">
                    <p className="font-medium text-stone-900 dark:text-white text-sm">Email</p>
                    <p className="text-xs text-stone-500">Open in your email client</p>
                  </div>
                </button>
              </div>
            </div>
            
            <div className="p-4 border-t border-stone-200 dark:border-stone-700 flex justify-end">
              <button
                onClick={() => setShareModalSignal(null)}
                className="px-4 py-2 rounded-lg text-sm font-medium text-stone-600 hover:bg-stone-100 dark:text-stone-300 dark:hover:bg-stone-700 transition-colors"
              >
                Done
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

// Main App (internal, wrapped by auth)
function ConvexApp({ userMenu, syncStatus }) {
  const [page, setPage] = useState('list');
  const [deals, setDeals] = useState([]);
  const [selected, setSelected] = useState(null);
  const [toast, setToast] = useState(null);
  const [search, setSearch] = useState('');
  const [sortBy, setSortBy] = useState('newest');
  const [showSortDropdown, setShowSortDropdown] = useState(false);
  const [userPrefs, setUserPrefs] = useState(null);
  const [showAddPortfolio, setShowAddPortfolio] = useState(false);
  const [settings, setSettings] = useState(DEFAULT_SETTINGS);
  

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

  // Portfolio deals
  const portfolioDeals = deals.filter(d => d.status === 'invested');

  // Filter and sort portfolio deals
  const getFilteredDeals = () => {
    let base = portfolioDeals;
    
    if (search) base = base.filter(d => d.companyName.toLowerCase().includes(search.toLowerCase()));
    
    return base.sort((a, b) => {
      if (sortBy === 'newest') return new Date(b.statusEnteredAt || b.createdAt).getTime() - new Date(a.statusEnteredAt || a.createdAt).getTime();
      if (sortBy === 'oldest') return new Date(a.statusEnteredAt || a.createdAt).getTime() - new Date(b.statusEnteredAt || b.createdAt).getTime();
      if (sortBy === 'alphabetical') return a.companyName.localeCompare(b.companyName);
      if (sortBy === 'industry') return (a.industry || 'zzz').localeCompare(b.industry || 'zzz');
      if (sortBy === 'stage') {
        const stageOrder = { 'pre-seed': 1, 'seed': 2, 'series-a': 3, 'series-b': 4, 'series-c': 5, 'growth': 6 };
        return (stageOrder[a.stage] || 99) - (stageOrder[b.stage] || 99);
      }
      if (sortBy === 'source') {
        return (a.source?.channel || 'zzz').localeCompare(b.source?.channel || 'zzz');
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
    const config = STATUS_CONFIG[selected.status] || STATUS_CONFIG['invested'];

    return (
      <div className="min-h-screen bg-stone-100 dark:bg-stone-900">
        {/* Header */}
        <header className="sticky top-0 z-30 bg-white dark:bg-stone-800 border-b border-stone-200 dark:border-stone-700">
          <div className="flex items-center justify-between px-6 py-4">
            <button onClick={() => setPage('list')} className="flex items-center gap-1 text-stone-500 dark:text-stone-400 hover:text-stone-700 dark:hover:text-stone-200 transition-colors">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="15 18 9 12 15 6"/></svg>
              <span className="text-sm font-medium">Portfolio</span>
            </button>
            <div className="flex items-center gap-2">
              <button
                onClick={() => setPage('portfolio-monitor')}
                className="px-3 py-1 rounded-lg text-sm font-medium transition-colors"
                style={{ backgroundColor: '#5B6DC4', color: 'white' }}
                title="Portfolio Monitor"
              >
                <svg className="inline mr-1 mb-0.5" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <polyline points="23 6 13.5 15.5 8.5 10.5 1 18"/><polyline points="17 6 23 6 23 12"/>
                </svg>
                Monitor
              </button>
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
            </div>
          </div>
        </header>
        <main className="px-6 py-6">
          <InvestedView deal={selected} onUpdate={updateDeal} setToast={setToast} />
        </main>
        {toast && <Toast message={toast.message} type={toast.type} onClose={() => setToast(null)} />}
      </div>
    );
  }

  const emptyState = { title: 'No investments yet', subtitle: 'When you invest, your portfolio builds here.' };

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

        {/* Tab Navigation - removed, portfolio only */}
      </header>

      {/* Content */}
      <div className="px-6 py-6">

        {/* Portfolio summary */}
        {portfolioDeals.length > 0 && (() => {
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

        {/* Portfolio Monitor button */}
        <div className="flex items-center justify-between mb-4">
          <p className="text-sm text-stone-500 dark:text-stone-400">Companies</p>
          {portfolioDeals.length > 0 && (
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
            
            {/* Sort dropdown */}
            <div className="relative">
              <button
                onClick={() => setShowSortDropdown(!showSortDropdown)}
                className="flex items-center gap-2 px-3 py-2 rounded-xl text-sm font-medium text-stone-600 dark:text-stone-300 hover:bg-stone-100 dark:hover:bg-stone-700 transition-colors"
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <line x1="4" y1="6" x2="20" y2="6"/><line x1="4" y1="12" x2="16" y2="12"/><line x1="4" y1="18" x2="12" y2="18"/>
                </svg>
                Sort: {sortBy === 'newest' ? 'Newest' : sortBy === 'oldest' ? 'Oldest' : sortBy === 'alphabetical' ? 'A-Z' : sortBy === 'industry' ? 'Industry' : sortBy === 'stage' ? 'Stage' : sortBy === 'source' ? 'Source' : 'Newest'}
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <polyline points="6 9 12 15 18 9"/>
                </svg>
              </button>
              
              {showSortDropdown && (
                <>
                  <div className="fixed inset-0 z-10" onClick={() => setShowSortDropdown(false)} />
                  <div className="absolute right-0 top-full mt-1 bg-white dark:bg-stone-800 rounded-xl shadow-lg border border-stone-200 dark:border-stone-700 py-1 z-20 min-w-[160px]">
                    {[
                      { key: 'newest', label: 'Newest First', icon: <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg> },
                      { key: 'oldest', label: 'Oldest First', icon: <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 8 14"/></svg> },
                      { key: 'alphabetical', label: 'Name (A-Z)', icon: <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M3 3h7v7H3zM14 3h7v7h-7zM14 14h7v7h-7zM3 14h7v7H3z"/></svg> },
                      { key: 'industry', label: 'Industry', icon: <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="5" r="3"/><line x1="12" y1="22" x2="12" y2="8"/><path d="M5 12H2a10 10 0 0 0 20 0h-3"/></svg> },
                      { key: 'stage', label: 'Stage', icon: <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="23 6 13.5 15.5 8.5 10.5 1 18"/></svg> },
                      { key: 'source', label: 'Source / Channel', icon: <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg> },
                    ].map(option => (
                      <button
                        key={option.key}
                        onClick={() => { setSortBy(option.key); setShowSortDropdown(false); }}
                        className={`w-full flex items-center gap-2 px-3 py-2 text-sm text-left transition-colors ${
                          sortBy === option.key 
                            ? 'bg-stone-100 dark:bg-stone-700 text-stone-900 dark:text-white font-medium' 
                            : 'text-stone-600 dark:text-stone-300 hover:bg-stone-50 dark:hover:bg-stone-700/50'
                        }`}
                      >
                        {option.icon}
                        {option.label}
                        {sortBy === option.key && (
                          <svg className="ml-auto" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="20 6 9 17 4 12"/></svg>
                        )}
                      </button>
                    ))}
                  </div>
                </>
              )}
            </div>
            
            {/* Filter pills - removed (portfolio only) */}
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
              const isInactive = deal.engagement === 'inactive';
              
              return (
                <div 
                  key={deal.id} 
                  onClick={() => { setSelected(deal); setPage('detail'); }}
                  className={`bg-white dark:bg-stone-800 rounded-2xl border cursor-pointer transition-all hover:shadow-sm border-stone-200 dark:border-stone-700 hover:border-stone-300 dark:hover:border-stone-600 ${isInactive ? 'opacity-50' : ''}`}
                >
                  {/* Inactive indicator banner */}
                  {isInactive && (
                    <div className="px-5 py-2 bg-stone-100 dark:bg-stone-700/50 border-b border-stone-200 dark:border-stone-600 rounded-t-2xl">
                      <div className="flex items-center gap-2">
                        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#a8a29e" strokeWidth="2">
                          <circle cx="12" cy="12" r="10"/><line x1="4.93" y1="4.93" x2="19.07" y2="19.07"/>
                        </svg>
                        <span className="text-xs text-stone-400">Inactive{deal.inactiveReason ? ` · ${deal.inactiveReason}` : ''}</span>
                      </div>
                    </div>
                  )}

                  <div className="p-5 flex items-center">
                    {/* Company initial */}
                    <div className="relative mr-4 flex-shrink-0">
                      <div className="w-12 h-12 rounded-xl flex items-center justify-center bg-emerald-50 dark:bg-emerald-900/30">
                        <span className="text-lg font-semibold text-emerald-600 dark:text-emerald-400">{deal.companyName?.charAt(0)?.toUpperCase()}</span>
                      </div>
                    </div>
                    
                    {/* Company Info */}
                    <div className="flex-1 min-w-0">
                      <h3 className="font-semibold mb-0.5 text-stone-900 dark:text-stone-100">{deal.companyName}</h3>
                      <p className="text-sm text-stone-500 dark:text-stone-400">{deal.industry} · {deal.stage}</p>
                      <p className="text-sm text-stone-400 dark:text-stone-500">{founderName}</p>
                      
                      {/* Investment thesis */}
                      {deal.investment?.whyYes && (
                        <div className="mt-3 p-3 bg-stone-50 dark:bg-stone-700/50 rounded-xl">
                          <p className="text-xs text-stone-400 dark:text-stone-500 uppercase tracking-wide mb-1">Your thesis</p>
                          <p className="text-sm text-stone-600 dark:text-stone-300 line-clamp-2">"{deal.investment.whyYes}"</p>
                        </div>
                      )}
                    </div>
                  
                    {/* Right side - amount and date */}
                    <div className="flex flex-col items-end gap-1.5 ml-4">
                      <span className="text-sm font-medium text-stone-900 dark:text-stone-100">
                        {deal.investment?.amount ? `$${(deal.investment.amount / 1000).toFixed(0)}K` : ''}
                      </span>
                      {deal.investment?.date && (
                        <span className="text-xs text-stone-400 dark:text-stone-500">
                          {formatRelativeTime(deal.investment.date)}
                        </span>
                      )}
                    </div>
                  
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#a8a29e" strokeWidth="2" className="ml-3 flex-shrink-0">
                      <polyline points="9 18 15 12 9 6"/>
                    </svg>
                  </div>
                </div>
              );
            })
          )}
        </div>
        
        {/* Footer */}
        {filtered.length > 0 && (
          <div className="mt-8 text-center space-y-1">
            <p className="text-sm text-stone-400 dark:text-stone-500">
              {portfolioDeals.length} {portfolioDeals.length === 1 ? 'investment' : 'investments'}. Each one a deliberate choice.
            </p>
            <p className="text-xs text-stone-300 dark:text-stone-600">
              The best investors stay curious about their own patterns
            </p>
          </div>
        )}
      </div>

      {/* Modals */}
      {showAddPortfolio && <AddPortfolioModal onClose={() => setShowAddPortfolio(false)} onAdd={addDeal} />}
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
