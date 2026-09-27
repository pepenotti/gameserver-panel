// The agent's RCON client (CON-01): one packet per write, the sentinel only
// once a reply has begun (or after a short fallback), replies that arrive
// coalesced or split across reads, and commands too long for one packet
// refused before anything is sent. The games' own fakes cover the rest
// (tools/fake-minecraft; tools/fake-pz through the agent's tests).
import net from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { RconDecoder, RCON_TYPE, type RconPacket } from '@gsp/formats';
import { RCON_MAX_PACKET_BYTES, RconClient } from '../src/rcon-client';
import { TIME_SCALE } from './helpers';

const PASSWORD = 'test-rcon-password';
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** A packet with a raw body, so a test can cut a UTF-8 character across packets. */
function frame(id: number, type: number, body: Buffer | string): Buffer {
  const b = typeof body === 'string' ? Buffer.from(body, 'utf8') : body;
  const buf = Buffer.alloc(14 + b.length);
  buf.writeInt32LE(10 + b.length, 0);
  buf.writeInt32LE(id, 4);
  buf.writeInt32LE(type, 8);
  b.copy(buf, 12);
  return buf;
}

interface Conn {
  write(...bufs: Buffer[]): void;
  /** Id of the last command packet (type 2) read. */
  lastCommand: number;
}

/**
 * Answers one packet after auth. Answers run one after another per
 * connection, as a game's RCON thread does: a sentinel read during a slow
 * answer is answered after it.
 */
type Answer = (p: RconPacket, c: Conn) => void | Promise<void>;

interface Server {
  port: number;
  /** Each read the server made, as the packets it held, and when. */
  reads: { packets: RconPacket[]; at: number }[];
  close(): Promise<void>;
}

/**
 * A scripted RCON server that reads like Minecraft 26.3: a read must hold
 * exactly one whole packet, or the connection ends. Auth is answered with
 * one type-2 packet.
 */
async function server(answer: Answer): Promise<Server> {
  const reads: Server['reads'] = [];
  const socks = new Set<net.Socket>();
  const srv = net.createServer((sock) => {
    socks.add(sock);
    sock.on('error', () => undefined);
    sock.on('close', () => socks.delete(sock));
    const conn: Conn = { write: (...bufs) => void (sock.destroyed || sock.write(Buffer.concat(bufs))), lastCommand: 0 };
    let chain = Promise.resolve();
    sock.on('data', (d) => {
      let packets: RconPacket[] = [];
      try {
        packets = new RconDecoder().push(d);
      } catch {
        // not even one packet
      }
      reads.push({ packets, at: Date.now() });
      if (packets.length !== 1 || packets[0]!.body.length + 14 !== d.length) {
        sock.destroy();
        return;
      }
      const p = packets[0]!;
      if (p.type === RCON_TYPE.AUTH) {
        conn.write(frame(p.body.toString() === PASSWORD ? p.id : -1, RCON_TYPE.AUTH_RESPONSE, ''));
        return;
      }
      if (p.type === RCON_TYPE.EXEC_COMMAND) conn.lastCommand = p.id;
      chain = chain.then(() => answer(p, conn));
    });
  });
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
  return {
    port: (srv.address() as net.AddressInfo).port,
    reads,
    close: () =>
      new Promise((r) => {
        for (const s of socks) s.destroy();
        srv.close(() => r());
      }),
  };
}

/** Minecraft's own answers: each command with `reply(cmd)` (one packet per part), each sentinel with `Unknown request 0`. */
const minecraftLike =
  (reply: (cmd: string) => string[]): Answer =>
  (p, c) => {
    if (p.type === RCON_TYPE.RESPONSE_VALUE) return c.write(frame(p.id, 0, 'Unknown request 0'));
    for (const part of reply(p.body.toString('utf8'))) c.write(frame(p.id, 0, part));
  };

const closers: (() => unknown)[] = [];
afterEach(async () => {
  for (const c of closers.splice(0).reverse()) await c();
});

async function start(answer: Answer): Promise<Server> {
  const s = await server(answer);
  closers.push(() => s.close());
  return s;
}

function client(port: number, o: { timeoutMs?: number; sentinelFallbackMs?: number } = {}): RconClient {
  const c = new RconClient('127.0.0.1', port, () => PASSWORD, { timeoutMs: 3_000 * TIME_SCALE, ...o });
  closers.push(() => c.close());
  return c;
}

describe('RCON client: one packet per write (CON-01)', () => {
  it('writes the sentinel only once the reply has begun, so every read holds one packet', async () => {
    const s = await start(minecraftLike((cmd) => [`echo ${cmd}`]));
    // A fallback far beyond the test: only the reply may release the sentinel.
    const c = client(s.port, { sentinelFallbackMs: 60_000 });
    await expect(c.command('list')).resolves.toBe('echo list');
    await expect(c.command('save-all flush')).resolves.toBe('echo save-all flush');
    expect(c.connected).toBe(true);
    const E = RCON_TYPE.EXEC_COMMAND;
    const S = RCON_TYPE.RESPONSE_VALUE;
    expect(s.reads.map((r) => r.packets.map((p) => p.type))).toEqual([[RCON_TYPE.AUTH], [E], [S], [E], [S]]);
  });

  it('reads a reply of several packets that arrives in one read together with the echo', async () => {
    const s = await start((p, c) => {
      // Nothing until the sentinel (the fallback sends it), then the whole reply and the echo in one write.
      if (p.type === RCON_TYPE.RESPONSE_VALUE) c.write(frame(c.lastCommand, 0, 'first part, '), frame(c.lastCommand, 0, 'second part'), frame(p.id, 0, 'Unknown request 0'));
    });
    await expect(client(s.port, { sentinelFallbackMs: 30 }).command('x')).resolves.toBe('first part, second part');
  });

  it('reassembles packets cut anywhere across reads, with a UTF-8 character split between two packets', async () => {
    const text = 'ñandú '.repeat(400);
    const bytes = Buffer.from(text, 'utf8');
    // 1001 falls inside a two-byte character.
    expect(bytes.subarray(0, 1001).toString('utf8').endsWith('�')).toBe(true);
    const s = await start(async (p, c) => {
      if (p.type === RCON_TYPE.RESPONSE_VALUE) return c.write(frame(p.id, 0, 'Unknown request 0'));
      const all = Buffer.concat([frame(p.id, 0, bytes.subarray(0, 1001)), frame(p.id, 0, bytes.subarray(1001))]);
      for (const [a, b] of [
        [0, 7],
        [7, 1500],
        [1500, all.length],
      ] as const) {
        c.write(all.subarray(a, b));
        await sleep(5);
      }
    });
    await expect(client(s.port).command('long')).resolves.toBe(text);
  });

  it('writes the sentinel after the fallback delay when the game never answers the command, so the call ends', async () => {
    const fallbackMs = 200 * TIME_SCALE;
    const s = await start((p, c) => {
      if (p.type === RCON_TYPE.RESPONSE_VALUE) c.write(frame(p.id, 0, 'Unknown request 0'));
    });
    const c = client(s.port, { sentinelFallbackMs: fallbackMs });
    await expect(c.command('silent')).resolves.toBe('');
    const [, cmd, sentinel] = s.reads;
    expect(sentinel!.at - cmd!.at).toBeGreaterThanOrEqual(fallbackMs - 20);
    // The same connection carries the next command.
    await expect(c.command('again')).resolves.toBe('');
    expect(s.reads).toHaveLength(5);
  });

  it('keeps waiting for a slow reply that starts after the fallback sentinel, and returns all of it', async () => {
    const s = await start(async (p, c) => {
      // The game is busy with the command (a long flush) and reads the sentinel only afterwards.
      if (p.type === RCON_TYPE.EXEC_COMMAND) {
        await sleep(150);
        c.write(frame(p.id, 0, 'Saving the game (this may take a moment!)'), frame(p.id, 0, 'Saved the game'));
      } else c.write(frame(p.id, 0, 'Unknown request 0'));
    });
    await expect(client(s.port, { sentinelFallbackMs: 20 }).command('save-all flush')).resolves.toBe('Saving the game (this may take a moment!)Saved the game');
  });

  it(`refuses a command whose packet would exceed ${RCON_MAX_PACKET_BYTES} bytes, before writing anything; the connection carries on`, async () => {
    const s = await start(minecraftLike((cmd) => [String(Buffer.byteLength(cmd, 'utf8'))]));
    const c = client(s.port);
    const longest = 'x'.repeat(RCON_MAX_PACKET_BYTES - 14);
    await expect(c.command(longest)).resolves.toBe('1446');
    const reads = s.reads.length;
    await expect(c.command(`${longest}x`)).rejects.toThrow(/too long for RCON: 1461 bytes in one packet, at most 1460/);
    // Text is counted in UTF-8 bytes: 723 two-byte characters fit, 724 don't.
    await expect(c.command('ñ'.repeat(724))).rejects.toThrow(/too long/);
    expect(s.reads.length).toBe(reads);
    await expect(c.command('ñ'.repeat(723))).resolves.toBe('1446');
    expect(c.connected).toBe(true);
  });

  it('refuses multi-line commands, and fails a command whose connection closes', async () => {
    const s = await start(() => undefined);
    const c = client(s.port, { sentinelFallbackMs: 60_000 });
    await expect(c.command('a\nb')).rejects.toThrow(/single line/);
    const pending = c.command('never answered');
    await sleep(100);
    await s.close();
    await expect(pending).rejects.toThrow(/closed/);
  });
});
