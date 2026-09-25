// Which server a page is about (M2): pages of one server live under
// /s/<sid>/, get their server from the URL, call its routes through
// `useServerApi()`, and ask `can()` about their server.
import { useQuery } from '@tanstack/react-query';
import { createContext, useContext, useEffect, useMemo, type ReactNode } from 'react';
import { useParams } from 'react-router';
import type { Permission, Role } from '@gsp/shared';
import { api, serverApi, type ServerApi } from './http';
import type { I18n } from './meta';
import { SessionContext, useSession } from './session';

/** A server in `GET /api/servers` (mirrors packages/panel/src/routes/servers.ts). */
export interface ServerSummary {
  id: string;
  name: string;
  adapter: string;
  adapterName: I18n;
  flavour: string | null;
  /** Null while its agent hasn't answered. */
  state: string | null;
  agentConnected: boolean;
  /** Online players; null unless it runs. */
  players: number | null;
  version: string | null;
  nextRestart: string | null;
  /** Its published host ports. */
  ports: { id: string; port: number; proto: 'tcp' | 'udp' }[];
  /** Container memory limit, MiB. */
  memLimitMb: number;
  /** CPU limit in cores; null: none. */
  cpus: number | null;
  /** Its container waits to be recreated with changed limits at the game's next start. */
  containerPending: boolean;
  /** False for the server the install's environment describes: only the stack itself removes it. */
  managed: boolean;
  /** The signed-in user's role there, and what it lets them do. */
  role: Role;
  permissions: Permission[];
  /** The game's license the owner must accept (D6), and its acceptance; null for games without one. */
  eula: EulaSummary | null;
}

/** A game's license on a server (mirrors `EulaSummary` in packages/panel/src/routes/servers.ts). */
export interface EulaSummary {
  name: I18n;
  url: string;
  /** Null while it waits for the owner: the server can't start. */
  acceptedAt: string | null;
  acceptedBy: string | null;
}

/** The query key of `GET /api/servers` (the websocket's `servers` message refreshes it). */
export const SERVERS_KEY = ['servers'] as const;

/** The servers the signed-in user may see. */
export function useServers() {
  const { session } = useSession();
  return useQuery({
    queryKey: SERVERS_KEY,
    queryFn: () => api<ServerSummary[]>('GET', '/api/servers'),
    enabled: !!session && !session.pending,
    refetchInterval: 60_000,
  });
}

/** Puts a server's new summary (after a create or rename) into the list without waiting for a refetch. */
export function withServer(list: ServerSummary[] | undefined, s: ServerSummary): ServerSummary[] {
  const cur = list ?? [];
  return cur.some((x) => x.id === s.id) ? cur.map((x) => (x.id === s.id ? s : x)) : [...cur, s];
}

/**
 * Whether the user may do `p` somewhere: on the host, or on at least one
 * server (the audit log's page, which shows an admin of some servers those
 * servers).
 */
export function useCanSomewhere(): (p: Permission) => boolean {
  const { can } = useSession();
  const servers = useServers();
  return (p) => can(p) || !!servers.data?.some((s) => s.permissions.includes(p));
}

const LAST = 'gsp.lastServer';

/** The server last opened in this browser, for the server menu on pages that aren't about one server. */
export function lastServer(): string | null {
  try {
    return localStorage.getItem(LAST);
  } catch {
    return null;
  }
}

function remember(sid: string): void {
  try {
    localStorage.setItem(LAST, sid);
  } catch {
    // Private mode: nothing to remember.
  }
}

/** A page of a server: `/s/<sid>` plus the page's path (`/` is its dashboard). */
export function serverHref(sid: string, to: string): string {
  return `/s/${encodeURIComponent(sid)}${to}`;
}

interface ServerScopeValue {
  sid: string;
  /** Null until the list has loaded. */
  server: ServerSummary | null;
}

const Ctx = createContext<ServerScopeValue | null>(null);

/**
 * Wraps a server's pages: its id from the URL, its entry of the server list,
 * and `can()` answered for it (its permissions there, or the host's).
 */
export function ServerScope({ notFound, children }: { notFound: ReactNode; children: ReactNode }) {
  const { sid = '' } = useParams();
  const outer = useSession();
  const servers = useServers();
  const server = servers.data?.find((s) => s.id === sid) ?? null;
  useEffect(() => {
    if (server) remember(server.id);
  }, [server]);
  const scope = useMemo(() => ({ sid, server }), [sid, server]);
  const session = useMemo(() => ({ ...outer, can: (p: Permission) => outer.can(p) || (!!server && server.permissions.includes(p)) }), [outer, server]);
  if (servers.data && !server) return notFound;
  return (
    <Ctx.Provider value={scope}>
      <SessionContext.Provider value={session}>{children}</SessionContext.Provider>
    </Ctx.Provider>
  );
}

/** The server of the page, or null outside a server's pages. */
export function useServerScope(): ServerScopeValue | null {
  return useContext(Ctx);
}

/** The id of the page's server (inside `ServerScope` only). */
export function useServerId(): string {
  const s = useContext(Ctx);
  if (!s) throw new Error('useServerId outside a server page');
  return s.sid;
}

/** The page's server's routes. */
export function useServerApi(): ServerApi {
  const sid = useServerId();
  return useMemo(() => serverApi(sid), [sid]);
}
