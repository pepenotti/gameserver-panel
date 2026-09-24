import net from 'node:net';
import { encodePacket, RCON_TYPE, RconDecoder, type RconPacket } from '@pz/formats';

export class RconError extends Error {}

interface Pending {
  id: number;
  sentinelId: number;
  chunks: Buffer[];
  resolve: (text: string) => void;
  reject: (e: Error) => void;
  timer: NodeJS.Timeout;
}

/**
 * One persistent, authenticated RCON connection with a serial command queue.
 *
 * A reply is complete when the echo of an empty "sentinel" packet sent right
 * after the command arrives — measured on 42.20.4, the server answers it
 * (twice) only after the full, possibly split, reply.
 */
export class RconClient {
  private socket: net.Socket | null = null;
  private decoder = new RconDecoder();
  private nextId = 100;
  private queue: Promise<unknown> = Promise.resolve();
  private pending: Pending | null = null;
  private authWaiter: { id: number; resolve: () => void; reject: (e: Error) => void } | null = null;
  private connecting: Promise<void> | null = null;

  constructor(
    private readonly host: string,
    private readonly port: number,
    private readonly password: () => string,
    private readonly timeoutMs = 10_000,
  ) {}

  get connected(): boolean {
    return this.socket !== null && !this.socket.destroyed && this.connecting === null;
  }

  private id(): number {
    this.nextId = this.nextId >= 0x7ffffff0 ? 100 : this.nextId + 1;
    return this.nextId;
  }

  private connect(): Promise<void> {
    if (this.connected) return Promise.resolve();
    if (this.connecting) return this.connecting;
    this.connecting = new Promise<void>((resolve, reject) => {
      const sock = net.connect({ host: this.host, port: this.port });
      this.decoder = new RconDecoder();
      const fail = (e: Error) => {
        sock.destroy();
        if (this.socket === sock) this.socket = null;
        this.connecting = null;
        reject(e);
      };
      const timer = setTimeout(() => fail(new RconError('RCON connect/auth timed out')), this.timeoutMs);
      sock.once('connect', () => {
        this.socket = sock;
        const id = this.id();
        this.authWaiter = {
          id,
          resolve: () => {
            clearTimeout(timer);
            this.connecting = null;
            resolve();
          },
          reject: (e) => {
            clearTimeout(timer);
            fail(e);
          },
        };
        sock.write(encodePacket(id, RCON_TYPE.AUTH, this.password()));
      });
      sock.on('data', (d) => this.onData(d));
      sock.on('error', (e) => {
        clearTimeout(timer);
        this.teardown(new RconError(e.message));
        if (this.connecting) fail(new RconError(e.message));
      });
      sock.on('close', () => this.teardown(new RconError('RCON connection closed')));
    });
    return this.connecting;
  }

  private onData(d: Buffer): void {
    let packets: RconPacket[];
    try {
      packets = this.decoder.push(d);
    } catch (e) {
      this.teardown(e as Error);
      return;
    }
    for (const p of packets) {
      if (this.authWaiter) {
        if (p.type === RCON_TYPE.AUTH_RESPONSE) {
          const w = this.authWaiter;
          this.authWaiter = null;
          if (p.id === -1) w.reject(new RconError('RCON authentication failed'));
          else w.resolve();
        }
        continue;
      }
      const cur = this.pending;
      if (!cur) continue;
      if (p.id === cur.id) cur.chunks.push(p.body);
      else if (p.id === cur.sentinelId) {
        this.pending = null;
        clearTimeout(cur.timer);
        cur.resolve(Buffer.concat(cur.chunks).toString('utf8'));
      }
      // Anything else is the second sentinel echo or stale: ignore.
    }
  }

  private teardown(err: Error): void {
    const s = this.socket;
    this.socket = null;
    if (s && !s.destroyed) s.destroy();
    if (this.authWaiter) {
      const w = this.authWaiter;
      this.authWaiter = null;
      w.reject(err);
    }
    if (this.pending) {
      const p = this.pending;
      this.pending = null;
      clearTimeout(p.timer);
      p.reject(err);
    }
  }

  /** Run one command; queued behind any in-flight command. */
  command(cmd: string): Promise<string> {
    if (/[\r\n\0]/.test(cmd)) return Promise.reject(new RconError('Command must be a single line'));
    const run = async (): Promise<string> => {
      await this.connect();
      const sock = this.socket;
      if (!sock) throw new RconError('RCON not connected');
      return new Promise<string>((resolve, reject) => {
        const id = this.id();
        const sentinelId = this.id();
        const timer = setTimeout(() => {
          this.pending = null;
          // A reply we stopped waiting for would confuse the next command: reconnect.
          this.teardown(new RconError(`RCON command timed out: ${cmd.split(' ')[0]}`));
          reject(new RconError(`RCON command timed out: ${cmd.split(' ')[0]}`));
        }, this.timeoutMs);
        this.pending = { id, sentinelId, chunks: [], resolve, reject, timer };
        sock.write(Buffer.concat([encodePacket(id, RCON_TYPE.EXEC_COMMAND, cmd), encodePacket(sentinelId, RCON_TYPE.RESPONSE_VALUE, '')]));
      });
    };
    const p = this.queue.then(run, run);
    this.queue = p.catch(() => undefined);
    return p;
  }

  close(): void {
    this.teardown(new RconError('RCON client closed'));
  }
}
