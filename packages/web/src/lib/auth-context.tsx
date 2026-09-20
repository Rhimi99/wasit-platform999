import { createContext, useContext, useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { api } from './api';
import type { User } from './types';
import { isDashboardRole, primaryRole, userHasFeature, type Feature } from './rbac';

interface AuthCtx {
  user: User | null;
  loading: boolean;
  refresh: () => Promise<void>;
  logout: () => Promise<void>;
  isAuthenticated: boolean;
  can: (feature: Feature) => boolean;
  hasDashboard: boolean;
  role: ReturnType<typeof primaryRole>;
  setUser: (u: User | null) => void;
}

const Ctx = createContext<AuthCtx | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api.me()
      .then((u) => setUser(u))
      .catch(() => setUser(null))
      .finally(() => setLoading(false));
  }, []);

  const refresh = async () => {
    try {
      const u = await api.me();
      setUser(u);
    } catch {
      setUser(null);
    }
  };

  const logout = async () => {
    try {
      await api.logout();
    } finally {
      setUser(null);
    }
  };

  const value: AuthCtx = {
    user,
    loading,
    refresh,
    logout,
    isAuthenticated: !!user,
    can: (feature) => (user ? userHasFeature(user.roles, feature) : false),
    hasDashboard: user ? isDashboardRole(user.roles) : false,
    role: user ? primaryRole(user.roles) : 'CUSTOMER',
    setUser,
  };

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useAuth(): AuthCtx {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
}