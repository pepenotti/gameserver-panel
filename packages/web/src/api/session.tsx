import { useQuery, useQueryClient } from '@tanstack/react-query';
import { createContext, useCallback, useContext, useEffect, useMemo, type ReactNode } from 'react';
import type { Permission } from '@gsp/shared';
import { setLang } from '../i18n';
import { api, ApiError, setCsrf, setUnauthenticatedHandler } from './http';
import type { SessionInfo } from './types';

export interface SessionCtx {
  session: SessionInfo | null;
  loading: boolean;
  /** Replace the session with a response from an auth endpoint. */
  apply(s: SessionInfo | null): void;
  refresh(): Promise<void>;
  logout(): Promise<void>;
  /**
   * Whether the user may do `p` here: on the host, or, inside a server's
   * pages (`ServerScope`), on that server too.
   */
  can(p: Permission): boolean;
  /** Whether the user may do `p` on the host (host routes such as the Discord webhook), wherever the page is. */
  canHost(p: Permission): boolean;
}

/** Exported so a server's pages can answer `can` for their server (api/server.tsx). */
export const SessionContext = createContext<SessionCtx | null>(null);
const KEY = ['session'];

export function SessionProvider({ children }: { children: ReactNode }) {
  const qc = useQueryClient();
  const q = useQuery({
    queryKey: KEY,
    queryFn: async () => {
      try {
        return await api<SessionInfo>('GET', '/api/session');
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

  const apply = useCallback(
    (s: SessionInfo | null) => {
      setCsrf(s?.csrf ?? null);
      qc.setQueryData(KEY, s);
      if (!s) qc.removeQueries({ predicate: (query) => query.queryKey[0] !== 'session' });
    },
    [qc],
  );

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
        await api('POST', '/api/auth/logout', {}).catch(() => undefined);
        apply(null);
      },
      can: (p) => !!session && !session.pending && session.permissions.includes(p),
      canHost: (p) => !!session && !session.pending && session.permissions.includes(p),
    }),
    [session, q.isLoading, apply, qc],
  );
  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession(): SessionCtx {
  const c = useContext(SessionContext);
  if (!c) throw new Error('useSession outside SessionProvider');
  return c;
}
