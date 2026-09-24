import { useQuery, useQueryClient } from '@tanstack/react-query';
import { createContext, useCallback, useContext, useEffect, useMemo, type ReactNode } from 'react';
import type { Permission } from '@pz/shared';
import { setLang } from '../i18n';
import { ApiError, get, post, setCsrf, setUnauthenticatedHandler } from './http';
import type { SessionInfo } from './types';

interface SessionCtx {
  session: SessionInfo | null;
  loading: boolean;
  /** Replace the session with a response from an auth endpoint. */
  apply(s: SessionInfo | null): void;
  refresh(): Promise<void>;
  logout(): Promise<void>;
  can(p: Permission): boolean;
}

const Ctx = createContext<SessionCtx | null>(null);
const KEY = ['session'];

export function SessionProvider({ children }: { children: ReactNode }) {
  const qc = useQueryClient();
  const q = useQuery({
    queryKey: KEY,
    queryFn: async () => {
      try {
        return await get<SessionInfo>('/api/session');
      } catch (e) {
        if (e instanceof ApiError && e.status === 401) return null;
        throw e;
      }
    },
    staleTime: 60_000,
    retry: 1,
  });
  const session = q.data ?? null;

  useEffect(() => {
    setCsrf(session?.csrf ?? null);
    if (session) setLang(session.user.lang);
  }, [session]);

  const apply = useCallback((s: SessionInfo | null) => {
    setCsrf(s?.csrf ?? null);
    qc.setQueryData(KEY, s);
    if (!s) qc.removeQueries({ predicate: (query) => query.queryKey[0] !== 'session' });
  }, [qc]);

  useEffect(() => setUnauthenticatedHandler(() => apply(null)), [apply]);

  const value = useMemo<SessionCtx>(
    () => ({
      session,
      loading: q.isLoading,
      apply,
      refresh: async () => {
        await qc.invalidateQueries({ queryKey: KEY });
      },
      logout: async () => {
        await post('/api/auth/logout').catch(() => undefined);
        apply(null);
      },
      can: (p) => !!session && !session.pending && session.permissions.includes(p),
    }),
    [session, q.isLoading, apply, qc],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useSession(): SessionCtx {
  const c = useContext(Ctx);
  if (!c) throw new Error('useSession outside SessionProvider');
  return c;
}
