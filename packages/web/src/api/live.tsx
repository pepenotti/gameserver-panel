import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import type { AgentEvent, AgentStatus, JobInfo, JobResult, SeqEvent } from '@gsp/shared';
import { useServerScope } from './server';

export interface LogLine {
  seq: number;
  at: string;
  stream: 'out' | 'err' | 'agent';
  line: string;
}

export interface Alert {
  seq: number;
  at: string;
  kind: string;
  message: string;
}

/** Panel operation (mirrors the server's OpState). */
export interface Op {
  id: string;
  kind: string;
  startedAt: string;
  startedBy: string | null;
  step: string;
  countdownEndsAt: string | null;
  cancellable: boolean;
  progress: number | null;
  done: boolean;
  ok: boolean | null;
  error: string | null;
}

export interface Notice {
  at: string;
  kind: string;
  message: string;
}

/** One server as the websocket keeps it. */
export interface LiveServer {
  /** Panel <-> agent stream. */
  agentConnected: boolean;
  status: AgentStatus | null;
  logs: LogLine[];
  players: { count: number; names: string[] } | null;
  job: (JobInfo & { result?: JobResult }) | null;
  alerts: Alert[];
  op: Op | null;
  notices: Notice[];
}

/** What a page sees: its server's live state, and the socket's. */
export interface LiveState extends LiveServer {
  /** Browser <-> panel websocket. */
  socket: 'connecting' | 'open' | 'closed';
}

interface Store {
  socket: LiveState['socket'];
  servers: Record<string, LiveServer>;
  /** Notices about the host (no server). */
  hostNotices: Notice[];
}

const MAX_LOGS = 3000;
const emptyServer: LiveServer = { agentConnected: false, status: null, logs: [], players: null, job: null, alerts: [], op: null, notices: [] };
const Ctx = createContext<Store>({ socket: 'connecting', servers: {}, hostNotices: [] });

/** What `/api/ws` sends (mirrors `WsMessage` in packages/panel/src/routes/ws.ts). */
type ServerMsg =
  | { type: 'hello'; servers: { serverId: string; agentConnected: boolean; status: AgentStatus | null; logs: SeqEvent[]; op: Op | null }[] }
  | { type: 'gone'; serverId: string }
  | { type: 'op'; serverId: string; op: Op }
  | { type: 'notice'; serverId: string | null; kind: string; message: string }
  | ({ type: 'event'; serverId: string } & SeqEvent)
  | { type: 'pong' };

function toLog(e: SeqEvent): LogLine | null {
  const ev = e.event as AgentEvent;
  return ev.type === 'log' ? { seq: e.seq, at: e.at, stream: ev.stream, line: ev.line } : null;
}

/**
 * One websocket per tab for every server the user may see; reconnects with
 * backoff and batches log lines per frame. `useLive()` picks the page's server.
 */
export function LiveProvider({ enabled, children }: { enabled: boolean; children: ReactNode }) {
  const [store, setStore] = useState<Store>({ socket: 'connecting', servers: {}, hostNotices: [] });
  const pending = useRef<Record<string, LogLine[]>>({});

  useEffect(() => {
    if (!enabled) return;
    let ws: WebSocket | null = null;
    let stopped = false;
    let delay = 1000;
    let retry: number | undefined;
    let raf: number | undefined;

    const patch = (sid: string, f: (s: LiveServer) => Partial<LiveServer>) =>
      setStore((st) => {
        const cur = st.servers[sid] ?? emptyServer;
        return { ...st, servers: { ...st.servers, [sid]: { ...cur, ...f(cur) } } };
      });

    const flush = () => {
      raf = undefined;
      const add = pending.current;
      pending.current = {};
      for (const [sid, lines] of Object.entries(add)) if (lines.length) patch(sid, (s) => ({ logs: [...s.logs, ...lines].slice(-MAX_LOGS) }));
    };

    const connect = () => {
      setStore((st) => ({ ...st, socket: 'connecting' }));
      ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/api/ws`);
      ws.onopen = () => {
        delay = 1000;
        setStore((st) => ({ ...st, socket: 'open' }));
      };
      ws.onmessage = (m) => {
        const msg = JSON.parse(String(m.data)) as ServerMsg;
        switch (msg.type) {
          case 'hello':
            for (const h of msg.servers) {
              patch(h.serverId, () => ({
                agentConnected: h.agentConnected,
                status: h.status,
                players: h.status?.players ? { count: h.status.players.count, names: h.status.players.names } : null,
                logs: h.logs.map(toLog).filter((l): l is LogLine => l !== null),
                op: h.op,
              }));
            }
            return;
          case 'gone':
            setStore((st) => {
              const { [msg.serverId]: _gone, ...rest } = st.servers;
              return { ...st, servers: rest };
            });
            return;
          case 'op':
            patch(msg.serverId, () => ({ op: msg.op }));
            return;
          case 'notice': {
            const n = { at: new Date().toISOString(), kind: msg.kind, message: msg.message };
            if (msg.serverId === null) setStore((st) => ({ ...st, hostNotices: [...st.hostNotices, n].slice(-20) }));
            else patch(msg.serverId, (s) => ({ notices: [...s.notices, n].slice(-20) }));
            return;
          }
          case 'event':
            break;
          default:
            return;
        }
        const sid = msg.serverId;
        const ev = msg.event;
        switch (ev.type) {
          case 'log':
            (pending.current[sid] ??= []).push({ seq: msg.seq, at: msg.at, stream: ev.stream, line: ev.line });
            raf ??= requestAnimationFrame(flush);
            break;
          case 'state':
            patch(sid, (s) => ({
              agentConnected: true,
              status: ev.status,
              players: ev.status.players ? { count: ev.status.players.count, names: ev.status.players.names } : ev.status.state === 'running' ? s.players : null,
            }));
            break;
          case 'players':
            patch(sid, () => ({ players: { count: ev.count, names: ev.names } }));
            break;
          case 'job':
            patch(sid, () => ({ job: { ...ev.job, result: ev.result } }));
            break;
          case 'alert':
            patch(sid, (s) => ({ alerts: [...s.alerts, { seq: msg.seq, at: msg.at, kind: ev.kind, message: ev.message }].slice(-20) }));
            break;
        }
      };
      ws.onclose = (e) => {
        setStore((st) => ({ ...st, socket: 'closed' }));
        // 4001: the session ended server-side; the next API call shows the login.
        if (stopped || e.code === 4001) return;
        retry = window.setTimeout(connect, delay);
        delay = Math.min(delay * 2, 15_000);
      };
    };
    connect();
    const ping = window.setInterval(() => ws?.readyState === WebSocket.OPEN && ws.send('ping'), 25_000);
    return () => {
      stopped = true;
      window.clearTimeout(retry);
      window.clearInterval(ping);
      if (raf) cancelAnimationFrame(raf);
      ws?.close();
    };
  }, [enabled]);

  return <Ctx.Provider value={store}>{children}</Ctx.Provider>;
}

/** The page's server's live state (empty outside a server's pages), with the socket's. */
export function useLive(): LiveState {
  const store = useContext(Ctx);
  const sid = useServerScope()?.sid ?? null;
  const server = (sid && store.servers[sid]) || emptyServer;
  return { ...server, socket: store.socket, notices: sid ? server.notices : store.hostNotices };
}
