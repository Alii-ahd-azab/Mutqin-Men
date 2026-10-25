import React, { createContext, useContext, useState, useEffect } from 'react';
import { User } from '../types';
import { api, getAccessToken, clearLegacyToken } from '../api/client';
import { getSupabase } from '../lib/supabase';

interface AuthContextType {
  currentUser: User | null;
  loading: boolean;
  login: (phone: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
  refreshUser: () => Promise<void>;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

export const AuthProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [currentUser, setCurrentUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);

  const initAuth = async () => {
    clearLegacyToken();
    const token = await getAccessToken();
    if (!token) {
      setLoading(false);
      return;
    }
    try {
      const res = await api.getMe();
      setCurrentUser(res.user);
    } catch (err) {
      console.warn('Session expired or invalid:', err);
      await api.logout();
      setCurrentUser(null);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    initAuth();
    // A session ended elsewhere (expiry, revocation, another tab) returns this tab to the login screen.
    let unsubscribe: (() => void) | undefined;
    let cancelled = false;
    getSupabase()
      .then((supabase) => {
        if (cancelled) return;
        const { data } = supabase.auth.onAuthStateChange((event) => {
          if (event === 'SIGNED_OUT') setCurrentUser(null);
        });
        unsubscribe = () => data.subscription.unsubscribe();
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
      unsubscribe?.();
    };
  }, []);

  const login = async (phone: string, password: string) => {
    setLoading(true);
    try {
      const res = await api.login(phone, password);
      setCurrentUser(res.user);
    } finally {
      setLoading(false);
    }
  };

  const logout = async () => {
    try {
      await api.logout();
    } catch {
      // ignore
    }
    setCurrentUser(null);
  };

  const refreshUser = async () => {
    try {
      const res = await api.getMe();
      setCurrentUser(res.user);
    } catch {
      // ignore
    }
  };

  return (
    <AuthContext.Provider
      value={{
        currentUser,
        loading,
        login,
        logout,
        refreshUser,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
};

export function useAuth(): AuthContextType {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return context;
}
