import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import type { AgentEvent, AgentStatus, JobInfo, JobResult, SeqEvent } from '@pz/shared';

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

export interface LiveState {
  /** Browser <-> panel websocket. */
  socket: 'connecting' | 'open' | 'closed';
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

const MAX_LOGS = 3000;
const initial: LiveState = { socket: 'connecting', agentConnected: false, status: null, logs: [], players: null, job: null, alerts: [], op: null, notices: [] };
const Ctx = createContext<LiveState>(initial);

type ServerMsg =
  | { type: 'hello'; agentConnected: boolean; status: AgentStatus | null; logs: SeqEvent[]; op: Op | null }
  | { type: 'op'; op: Op }
  | { type: 'notice'; kind: string; message: string }
  | ({ type: 'event' } & SeqEvent)
  | { type: 'pong' };

function toLog(e: SeqEvent): LogLine | null {
  const ev = e.event as AgentEvent;
  return ev.type === 'log' ? { seq: e.seq, at: e.at, stream: ev.stream, line: ev.line } : null;
}

/** One websocket per tab; reconnects with backoff and batches log lines per frame. */
export function LiveProvider({ enabled, children }: { enabled: boolean; children: ReactNode }) {
  const [state, setState] = useState<LiveState>(initial);
  const pending = useRef<LogLine[]>([]);

  useEffect(() => {
    if (!enabled) return;
    let ws: WebSocket | null = null;
    let stopped = false;
    let delay = 1000;
    let retry: number | undefined;
    let raf: number | undefined;

    const flush = () => {
      raf = undefined;
      const add = pending.current;
      pending.current = [];
      if (add.length) setState((s) => ({ ...s, logs: [...s.logs, ...add].slice(-MAX_LOGS) }));
    };

    const connect = () => {
      setState((s) => ({ ...s, socket: 'connecting' }));
      ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/api/ws`);
      ws.onopen = () => {
        delay = 1000;
        setState((s) => ({ ...s, socket: 'open' }));
      };
      ws.onmessage = (m) => {
        const msg = JSON.parse(String(m.data)) as ServerMsg;
        if (msg.type === 'hello') {
          setState((s) => ({
            ...s,
            agentConnected: msg.agentConnected,
            status: msg.status,
            players: msg.status?.players ? { count: msg.status.players.count, names: msg.status.players.names } : null,
            logs: msg.logs.map(toLog).filter((l): l is LogLine => l !== null),
            op: msg.op,
          }));
          return;
        }
        if (msg.type === 'op') {
          setState((s) => ({ ...s, op: msg.op }));
          return;
        }
        if (msg.type === 'notice') {
          setState((s) => ({ ...s, notices: [...s.notices, { at: new Date().toISOString(), kind: msg.kind, message: msg.message }].slice(-20) }));
          return;
        }
        if (msg.type !== 'event') return;
        const ev = msg.event;
        switch (ev.type) {
          case 'log':
            pending.current.push({ seq: msg.seq, at: msg.at, stream: ev.stream, line: ev.line });
            raf ??= requestAnimationFrame(flush);
            break;
          case 'state':
            setState((s) => ({ ...s, agentConnected: true, status: ev.status, players: ev.status.players ? { count: ev.status.players.count, names: ev.status.players.names } : ev.status.state === 'running' ? s.players : null }));
            break;
          case 'players':
            setState((s) => ({ ...s, players: { count: ev.count, names: ev.names } }));
            break;
          case 'job':
            setState((s) => ({ ...s, job: { ...ev.job, result: ev.result } }));
            break;
          case 'alert':
            setState((s) => ({ ...s, alerts: [...s.alerts, { seq: msg.seq, at: msg.at, kind: ev.kind, message: ev.message }].slice(-20) }));
            break;
        }
      };
      ws.onclose = (e) => {
        setState((s) => ({ ...s, socket: 'closed' }));
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

  return <Ctx.Provider value={state}>{children}</Ctx.Provider>;
}

export function useLive(): LiveState {
  return useContext(Ctx);
}
