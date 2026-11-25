import React, { createContext, useCallback, useContext, useEffect, useState } from 'react';
import type { AuthUser } from '../../shared/types/index.ts';
import {
  apiFetch,
  readStoredToken,
  setApiToken,
  setUnauthorizedHandler,
} from './api-client.ts';

interface AuthContextValue {
  user: AuthUser | null;
  token: string | null;
  loading: boolean;
  login: (email: string, password: string) => Promise<{ ok: boolean; error?: string }>;
  logout: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [token, setToken] = useState<string | null>(() => readStoredToken());
  const [loading, setLoading] = useState<boolean>(true);

  useEffect(() => {
    setUnauthorizedHandler(() => {
      setApiToken(null);
      setToken(null);
      setUser(null);
    });
    return () => {
      setUnauthorizedHandler(null);
    };
  }, []);

  useEffect(() => {
    let cancelled = false;

    const verifyExistingSession = async () => {
      try {
        const res = await apiFetch('/api/auth/session', {
          method: 'GET',
        });
        if (!res.ok) {
          if (!cancelled) {
            setApiToken(null);
            setToken(null);
            setUser(null);
          }
          return;
        }
        const data = (await res.json()) as {
          authenticated?: boolean;
          user?: AuthUser | null;
        };
        if (!cancelled) {
          if (data.authenticated && data.user) {
            setUser(data.user);
          } else {
            setApiToken(null);
            setToken(null);
            setUser(null);
          }
        }
      } catch {
        if (!cancelled) {
          setUser(null);
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    };

    void verifyExistingSession();
    return () => {
      cancelled = true;
    };
  }, []);

  const login = useCallback(async (email: string, password: string) => {
    try {
      const res = await apiFetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: email.trim(), password }),
      });

      const data = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        user?: AuthUser;
        token?: string;
        error?: string;
      };

      if (!res.ok || !data.ok || !data.user || !data.token) {
        return {
          ok: false,
          error: data.error || 'Authentication failed. Check your credentials.',
        };
      }

      setApiToken(data.token);
      setToken(data.token);
      setUser(data.user);
      return { ok: true };
    } catch {
      return {
        ok: false,
        error: 'Unable to reach authentication server.',
      };
    }
  }, []);

  const logout = useCallback(async () => {
    try {
      await apiFetch('/api/auth/logout', {
        method: 'POST',
      });
    } catch {
      // Clear local session regardless of network errors
    } finally {
      setApiToken(null);
      setToken(null);
      setUser(null);
    }
  }, []);

  return (
    <AuthContext.Provider value={{ user, token, loading, login, logout }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside AuthProvider');
  return ctx;
}
