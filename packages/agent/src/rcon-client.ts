import net from 'node:net';
import { encodePacket, RCON_TYPE, RconDecoder, type RconPacket } from '@gsp/formats';

export class RconError extends Error {}

/**
 * The longest packet sent: Minecraft 26.3 takes a 1460-byte packet (a
 * 1446-byte body) and closes the connection on 1461 (CON-01,
 * docs/verification/minecraft-26.3.md). Nothing longer is ever written.
 */
export const RCON_MAX_PACKET_BYTES = 1460;

/** Packet header and trailer around a command's UTF-8 body: size, id, type, two NULs. */
const PACKET_OVERHEAD = 14;

/**
 * How long a command waits for the first packet of its reply before its
 * sentinel goes out anyway, so a game that never answers a command can't
 * stall the call until its timeout.
 */
export const SENTINEL_FALLBACK_MS = 250;

export interface RconClientOptions {
  /** A whole command, from its write to the sentinel's echo. */
  timeoutMs?: number;
  /** See `SENTINEL_FALLBACK_MS`. */
  sentinelFallbackMs?: number;
}

interface Pending {
  id: number;
  sentinelId: number;
  sentinelSent: boolean;
  chunks: Buffer[];
  resolve: (text: string) => void;
  reject: (e: Error) => void;
  timer: NodeJS.Timeout;
  fallback: NodeJS.Timeout | null;
}

/**
 * One persistent, authenticated RCON connection with a serial command queue.
 *
 * A reply is complete when the echo of an empty "sentinel" packet arrives:
 * a server answers packets in order, so the echo comes after the whole,
 * possibly split, reply (PZ 42.20.4 echoes it twice; Minecraft answers
 * `Unknown request 0`).
 *
 * Every packet goes out in a write of its own, and the sentinel only once
 * the reply has begun (or after `sentinelFallbackMs` without one): Minecraft
 * reads one packet per read and drops the connection when a read holds two
 * (CON-01, measured on 26.3), which a command and its sentinel written
 * together would make it do.
 */
export class RconClient {
  private socket: net.Socket | null = null;
  private decoder = new RconDecoder();
  private nextId = 100;
  private queue: Promise<unknown> = Promise.resolve();
  private pending: Pending | null = null;
  private authWaiter: { id: number; resolve: () => void; reject: (e: Error) => void } | null = null;
  private connecting: Promise<void> | null = null;
  private readonly timeoutMs: number;
  private readonly sentinelFallbackMs: number;

  constructor(
    private readonly host: string,
    private readonly port: number,
    private readonly password: () => string,
    o: RconClientOptions = {},
  ) {
    this.timeoutMs = o.timeoutMs ?? 10_000;
    this.sentinelFallbackMs = o.sentinelFallbackMs ?? SENTINEL_FALLBACK_MS;
  }

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

  /** Writes the sentinel of `cur`, once, on its own. */
  private sendSentinel(cur: Pending): void {
    if (cur.sentinelSent) return;
    cur.sentinelSent = true;
    if (cur.fallback) clearTimeout(cur.fallback);
    cur.fallback = null;
    const sock = this.socket;
    if (this.pending === cur && sock && !sock.destroyed) sock.write(encodePacket(cur.sentinelId, RCON_TYPE.RESPONSE_VALUE, ''));
  }

  private onData(d: Buffer): void {
    let packets: RconPacket[];
    try {
      packets = this.decoder.push(d);
    } catch (e) {
      this.teardown(e as Error);
      return;
    }
    // One read may hold several packets (a split reply and the echo): each is handled in order.
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
      if (p.id === cur.id) {
        cur.chunks.push(p.body);
        // The server has read the command: the sentinel now arrives in a read of its own.
        this.sendSentinel(cur);
      } else if (p.id === cur.sentinelId && cur.sentinelSent) {
        this.pending = null;
        clearTimeout(cur.timer);
        cur.resolve(Buffer.concat(cur.chunks).toString('utf8'));
      }
      // Anything else is a second sentinel echo (PZ) or stale: ignore.
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
      if (p.fallback) clearTimeout(p.fallback);
      p.reject(err);
    }
  }

  /** Run one command; queued behind any in-flight command. */
  command(cmd: string): Promise<string> {
    if (/[\r\n\0]/.test(cmd)) return Promise.reject(new RconError('Command must be a single line'));
    const size = PACKET_OVERHEAD + Buffer.byteLength(cmd, 'utf8');
    if (size > RCON_MAX_PACKET_BYTES) {
      // Refused here, so the connection (and the queue) carry on.
      return Promise.reject(new RconError(`Command too long for RCON: ${size} bytes in one packet, at most ${RCON_MAX_PACKET_BYTES} (${RCON_MAX_PACKET_BYTES - PACKET_OVERHEAD} bytes of UTF-8 text)`));
    }
    const run = async (): Promise<string> => {
      await this.connect();
      const sock = this.socket;
      if (!sock) throw new RconError('RCON not connected');
      return new Promise<string>((resolve, reject) => {
        const id = this.id();
        const sentinelId = this.id();
        const timer = setTimeout(() => {
          // A reply we stopped waiting for would confuse the next command: reconnect.
          this.teardown(new RconError(`RCON command timed out: ${cmd.split(' ')[0]}`));
        }, this.timeoutMs);
        const cur: Pending = { id, sentinelId, sentinelSent: false, chunks: [], resolve, reject, timer, fallback: null };
        this.pending = cur;
        sock.write(encodePacket(id, RCON_TYPE.EXEC_COMMAND, cmd));
        cur.fallback = setTimeout(() => this.sendSentinel(cur), this.sentinelFallbackMs);
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
