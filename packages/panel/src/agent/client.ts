import type {
  AgentError as AgentErrorBody,
  AgentEvent,
  AgentStatus,
  AppInfoResponse,
  CommandResponse,
  JobResult,
  LaunchParams,
  SeqEvent,
} from '@pz/shared';

export class AgentCallError extends Error {
  constructor(
    readonly status: number,
    readonly code: AgentErrorBody['code'] | 'unreachable',
    message: string,
  ) {
    super(message);
  }
}

type Listener = (e: SeqEvent) => void;

export interface AgentApi {
  status(): Promise<AgentStatus>;
  setLaunch(l: LaunchParams): Promise<AgentStatus>;
  start(l?: LaunchParams, lockId?: string): Promise<AgentStatus>;
  stop(opts?: { timeoutMs?: number; reason?: string }, lockId?: string): Promise<AgentStatus>;
  restart(lockId?: string): Promise<AgentStatus>;
  kill(lockId?: string): Promise<AgentStatus>;
  command(command: string, via?: 'rcon' | 'stdin'): Promise<CommandResponse>;
  install(opts: { branch?: string; validate: boolean }, lockId?: string): Promise<JobResult>;
  appInfo(): Promise<AppInfoResponse>;
  downloadWorkshop(ids: string[]): Promise<JobResult>;
  lock(holder: string, ttlMs: number): Promise<{ id: string; expiresAt: string }>;
  renewLock(id: string, ttlMs: number): Promise<void>;
  unlock(id: string): Promise<void>;
}

/**
 * HTTP client for the agent plus a live mirror of its event stream: the
 * latest status and a bounded backlog of log lines for newly opened UIs.
 */
export class AgentClient implements AgentApi {
  private lastSeq = 0;
  private bootId: string | null = null;
  private latest: AgentStatus | null = null;
  private readonly logs: SeqEvent[] = [];
  private readonly listeners = new Set<Listener>();
  private abort: AbortController | null = null;
  private stopped = false;
  private connectedFlag = false;

  constructor(
    private readonly baseUrl: string,
    private readonly token: string,
    private readonly logBacklog = 1000,
  ) {}

  get connected(): boolean {
    return this.connectedFlag;
  }

  get status_(): AgentStatus | null {
    return this.latest;
  }

  recentLogs(): SeqEvent[] {
    return [...this.logs];
  }

  onEvent(l: Listener): () => void {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }

  private async call<T>(method: string, path: string, body?: unknown, lockId?: string, timeoutMs = 30_000): Promise<T> {
    const headers: Record<string, string> = { authorization: `Bearer ${this.token}` };
    if (body !== undefined) headers['content-type'] = 'application/json';
    if (lockId) headers['x-lock-id'] = lockId;
    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs) });
    } catch (e) {
      throw new AgentCallError(503, 'unreachable', `Game server agent unreachable: ${(e as Error).message}`);
    }
    const text = await res.text();
    const data = text ? (JSON.parse(text) as unknown) : {};
    if (!res.ok) {
      const err = data as Partial<AgentErrorBody>;
      throw new AgentCallError(res.status, err.code ?? 'internal', err.error ?? `Agent error ${res.status}`);
    }
    return data as T;
  }

  async status(): Promise<AgentStatus> {
    const s = await this.call<AgentStatus>('GET', '/v1/status');
    this.latest = s;
    return s;
  }

  setLaunch(l: LaunchParams) {
    return this.call<AgentStatus>('PUT', '/v1/launch', l);
  }
  start(l?: LaunchParams, lockId?: string) {
    return this.call<AgentStatus>('POST', '/v1/start', l ? { launch: l } : {}, lockId, 45 * 60_000);
  }
  stop(opts: { timeoutMs?: number; reason?: string } = {}, lockId?: string) {
    return this.call<AgentStatus>('POST', '/v1/stop', opts, lockId, 15 * 60_000);
  }
  restart(lockId?: string) {
    return this.call<AgentStatus>('POST', '/v1/restart', {}, lockId, 45 * 60_000);
  }
  kill(lockId?: string) {
    return this.call<AgentStatus>('POST', '/v1/kill', {}, lockId);
  }
  command(command: string, via?: 'rcon' | 'stdin') {
    return this.call<CommandResponse>('POST', '/v1/command', { command, via });
  }
  install(opts: { branch?: string; validate: boolean }, lockId?: string) {
    return this.call<JobResult>('POST', '/v1/steamcmd/install', opts, lockId, 60 * 60_000);
  }
  appInfo() {
    return this.call<AppInfoResponse>('POST', '/v1/steamcmd/appinfo', {}, undefined, 5 * 60_000);
  }
  downloadWorkshop(ids: string[]) {
    return this.call<JobResult>('POST', '/v1/steamcmd/workshop', { ids }, undefined, 60 * 60_000);
  }
  lock(holder: string, ttlMs: number) {
    return this.call<{ id: string; expiresAt: string }>('POST', '/v1/lock', { holder, ttlMs });
  }
  async renewLock(id: string, ttlMs: number) {
    await this.call('PUT', '/v1/lock', { ttlMs }, id);
  }
  async unlock(id: string) {
    await this.call('DELETE', '/v1/lock', undefined, id);
  }

  // ------------------------------------------------------------ event stream

  private dispatch(e: SeqEvent): void {
    if (e.seq <= this.lastSeq) return; // replayed after a reconnect
    this.lastSeq = e.seq;
    const ev: AgentEvent = e.event;
    if (ev.type === 'state') this.latest = ev.status;
    if (ev.type === 'log') {
      this.logs.push(e);
      if (this.logs.length > this.logBacklog) this.logs.splice(0, this.logs.length - this.logBacklog);
    }
    for (const l of this.listeners) {
      try {
        l(e);
      } catch {
        // listener bugs must not kill the stream
      }
    }
  }

  /** Keep an SSE subscription open forever, resuming from the last seq. */
  startStream(): void {
    this.stopped = false;
    void this.streamLoop();
  }

  stopStream(): void {
    this.stopped = true;
    this.abort?.abort();
  }

  private async streamLoop(): Promise<void> {
    let delay = 1000;
    while (!this.stopped) {
      try {
        const s = await this.status();
        if (s.bootId !== this.bootId) {
          // A new agent process numbers its events from 1 again.
          this.bootId = s.bootId;
          this.lastSeq = 0;
          this.logs.length = 0;
        }
        this.abort = new AbortController();
        const res = await fetch(`${this.baseUrl}/v1/events?since=${this.lastSeq}`, {
          headers: { authorization: `Bearer ${this.token}` },
          signal: this.abort.signal,
        });
        if (!res.ok || !res.body) throw new Error(`events ${res.status}`);
        this.connectedFlag = true;
        delay = 1000;
        const decoder = new TextDecoder();
        let buf = '';
        for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
          buf += decoder.decode(chunk, { stream: true });
          let i: number;
          while ((i = buf.indexOf('\n\n')) >= 0) {
            const block = buf.slice(0, i);
            buf = buf.slice(i + 2);
            if (block.startsWith('event: truncated')) {
              // We missed events while away; the next state event resyncs us.
              continue;
            }
            const data = block.split('\n').find((l) => l.startsWith('data: '));
            if (data) this.dispatch(JSON.parse(data.slice(6)) as SeqEvent);
          }
        }
      } catch {
        // fall through to reconnect
      }
      this.connectedFlag = false;
      if (this.stopped) return;
      await new Promise((r) => setTimeout(r, delay));
      delay = Math.min(delay * 2, 15_000);
    }
  }
}
