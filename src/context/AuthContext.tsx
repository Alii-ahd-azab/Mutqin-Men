import React, { createContext, useContext, useState, useEffect } from 'react';
import { User } from '../types';
import { api } from '../api/client';
import { supabase } from '../lib/supabase';

interface AuthContextType {
  currentUser: User | null;
  loading: boolean;
  login: (phone: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
  refreshUser: () => Promise<void>;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

// Pre-Supabase session token of the old application; unused, removed on first load.
function clearLegacyToken() {
  try {
    localStorage.removeItem('motqin_auth_token');
  } catch {
    // ignore
  }
}

/*
 * Supabase Auth session handling (as in Mutqin for Sisters): the session persists in the browser and
 * refreshes automatically; the profile is loaded for the signed-in user and inactive accounts are
 * signed out.
 */
export const AuthProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [currentUser, setCurrentUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let mounted = true;
    clearLegacyToken();

    async function applySession(hasUser: boolean) {
      if (!hasUser) {
        if (mounted) setCurrentUser(null);
        return;
      }
      try {
        const { user } = await api.getMe();
        if (!user.is_active) {
          await supabase.auth.signOut();
          if (mounted) setCurrentUser(null);
          return;
        }
        // Keep the same object when nothing changed, so dashboards do not reload.
        if (mounted) setCurrentUser((prev) => (prev && JSON.stringify(prev) === JSON.stringify(user) ? prev : user));
      } catch (err) {
        console.warn('Session expired or invalid:', err);
        if (mounted) setCurrentUser(null);
      }
    }

    supabase.auth
      .getUser()
      .then(({ data }) => applySession(!!data.user))
      .finally(() => mounted && setLoading(false));

    const { data } = supabase.auth.onAuthStateChange((event, session) => {
      // Token refreshes keep the same account: no reload. Run outside the auth callback.
      if (event === 'SIGNED_OUT') setTimeout(() => mounted && setCurrentUser(null), 0);
      if (event === 'SIGNED_IN' || event === 'USER_UPDATED') setTimeout(() => void applySession(!!session?.user), 0);
    });

    return () => {
      mounted = false;
      data.subscription.unsubscribe();
    };
  }, []);

  // As in Sisters, login does not toggle the global loading state: LoginView shows its own spinner and
  // stays mounted, so a wrong-password message remains visible.
  const login = async (phone: string, password: string) => {
    const res = await api.login(phone, password);
    setCurrentUser(res.user);
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
    <AuthContext.Provider value={{ currentUser, loading, login, logout, refreshUser }}>
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
