// Steam's server query (A2S_INFO), the player count of a Valheim server in
// the game's public list (PLY-01): the reply measured from the dedicated
// server 1.0.16 (fixtures/valheim/1.0.16/a2s/public.json, answered at once,
// no challenge), the challenge step of Valve's protocol for servers that ask
// for one, broken replies, and tools/fake-valheim, which answers as measured.
import { type ChildProcess, spawn } from 'node:child_process';
import dgram from 'node:dgram';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { RuntimeCtx } from '@gsp/adapter-api';
import { A2sError, infoRequest, parseInfo, queryInfo, steamPlayers } from '../src/runtime';
import { FAKE_SERVER, fixture } from './helpers';

const SCALE = Number(process.env.TEST_TIME_SCALE) || 1;

/** The measured A2S_INFO answer, as decoded by the fact-finding's client. */
const MEASURED = (JSON.parse(fixture('a2s', 'public.json')) as { info: Record<string, string | number> }).info;

/** That answer as bytes, laid out as Valve's protocol says (header, fields, then the extra data its `edf` names). */
function measuredReply(players = MEASURED.players as number): Buffer {
  const parts: Buffer[] = [Buffer.from([0xff, 0xff, 0xff, 0xff, 0x49, MEASURED.protocol as number])];
  const str = (s: string | number) => parts.push(Buffer.from(`${s}\0`, 'utf8'));
  str(MEASURED.name!);
  str(MEASURED.map!);
  str(MEASURED.folder!);
  str(MEASURED.game!);
  const fixed = Buffer.alloc(9);
  fixed.writeUInt16LE(MEASURED.appId as number, 0);
  fixed.writeUInt8(players, 2);
  fixed.writeUInt8(MEASURED.maxPlayers as number, 3);
  fixed.writeUInt8(MEASURED.bots as number, 4);
  fixed.write(`${MEASURED.serverType}${MEASURED.environment}`, 5, 'latin1');
  fixed.writeUInt8(MEASURED.visibility as number, 7);
  fixed.writeUInt8(MEASURED.vac as number, 8);
  parts.push(fixed);
  str(MEASURED.version!);
  const edf = MEASURED.edf as number;
  parts.push(Buffer.from([edf]));
  if (edf & 0x80) parts.push(Buffer.from([(MEASURED.port as number) & 0xff, (MEASURED.port as number) >> 8]));
  if (edf & 0x10) {
    const b = Buffer.alloc(8);
    b.writeBigUInt64LE(BigInt(MEASURED.steamId!));
    parts.push(b);
  }
  if (edf & 0x20) str(MEASURED.keywords!);
  if (edf & 0x01) {
    const b = Buffer.alloc(8);
    b.writeBigUInt64LE(BigInt(MEASURED.gameId!));
    parts.push(b);
  }
  return Buffer.concat(parts);
}

const sockets: dgram.Socket[] = [];
const children: ChildProcess[] = [];
const dirs: string[] = [];
afterEach(async () => {
  for (const s of sockets.splice(0)) s.close();
  for (const c of children.splice(0)) {
    if (c.exitCode === null) c.kill('SIGKILL');
    await new Promise((r) => (c.exitCode === null ? c.once('exit', r) : r(null)));
  }
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

/** A UDP server on a free port that answers each request with what `answer` gives (nothing for null). */
async function responder(answer: (req: Buffer, n: number) => Buffer | null): Promise<{ port: number; requests: Buffer[] }> {
  const s = dgram.createSocket('udp4');
  sockets.push(s);
  const requests: Buffer[] = [];
  s.on('message', (m, from) => {
    requests.push(m);
    const reply = answer(m, requests.length);
    if (reply) s.send(reply, from.port, from.address);
  });
  await new Promise<void>((r) => s.bind(0, '127.0.0.1', () => r()));
  return { port: s.address().port, requests };
}

describe('A2S_INFO (PLY-01)', () => {
  it('reads the measured reply: name, folder, players, slots, version, port, keywords, app', () => {
    expect(parseInfo(measuredReply())).toEqual({
      protocol: 17,
      name: 'gspff test',
      map: 'gspff test',
      folder: 'valheim',
      game: '',
      appId: 0,
      players: 0,
      maxPlayers: 10,
      bots: 0,
      version: '1.0.0.0',
      port: 2456,
      keywords: 'g=1.0.16,n=40,m=',
      gameId: '892970',
    });
  });

  it('refuses what isn\'t an info reply, or is cut short', () => {
    expect(() => parseInfo(Buffer.from([0xff, 0xff, 0xff, 0xff, 0x44, 0]))).toThrow(A2sError);
    expect(() => parseInfo(measuredReply().subarray(0, 20))).toThrow(/cut short/);
    expect(() => parseInfo(Buffer.from([0xfe, 0xff, 0xff, 0xff, 0x49]))).toThrow(A2sError);
  });

  it('asks as Valve\'s protocol says, and gets the answer at once, as Valheim gave it', async () => {
    const r = await responder(() => measuredReply(3));
    expect((await queryInfo('127.0.0.1', r.port)).players).toBe(3);
    expect(r.requests).toEqual([Buffer.concat([Buffer.from([0xff, 0xff, 0xff, 0xff, 0x54]), Buffer.from('Source Engine Query\0', 'latin1')])]);
  });

  it("repeats the request with the challenge a server asks for (Valve's rule for newer servers; Valheim 1.0.16 didn't ask)", async () => {
    const challenge = Buffer.from([0x0a, 0x0b, 0x0c, 0x0d]);
    const r = await responder((req) => (req.length === 29 && req.subarray(25).equals(challenge) ? measuredReply(2) : Buffer.concat([Buffer.from([0xff, 0xff, 0xff, 0xff, 0x41]), challenge])));
    expect((await queryInfo('127.0.0.1', r.port)).players).toBe(2);
    expect(r.requests).toEqual([infoRequest(), infoRequest(challenge)]);
    // A server that never stops asking is given up on.
    const pest = await responder(() => Buffer.from([0xff, 0xff, 0xff, 0xff, 0x41, 1, 2, 3, 4]));
    await expect(queryInfo('127.0.0.1', pest.port)).rejects.toThrow(/kept asking for a challenge/);
  });

  it('fails when nobody answers in time, or the answer is junk', async () => {
    const silent = await responder(() => null);
    await expect(queryInfo('127.0.0.1', silent.port, 200)).rejects.toThrow(/did not answer Steam's server query/);
    const junk = await responder(() => Buffer.from('hello'));
    await expect(queryInfo('127.0.0.1', junk.port)).rejects.toThrow(A2sError);
    await expect(queryInfo('localhost', silent.port)).rejects.toThrow(/Not an IP address/);
  });
});

describe('players of a server in the public list, from tools/fake-valheim (PLY-01)', () => {
  /** A free UDP port whose next one is free too (Valheim's query port is the game port + 1). */
  async function freePair(): Promise<number> {
    for (let i = 0; i < 20; i++) {
      const s = dgram.createSocket('udp4');
      const p = await new Promise<number>((r) => s.bind(0, '127.0.0.1', () => r(s.address().port)));
      const t = dgram.createSocket('udp4');
      const ok = await new Promise<boolean>((r) => {
        t.once('error', () => r(false));
        t.bind(p + 1, '127.0.0.1', () => r(true));
      });
      s.close();
      t.close();
      if (ok) return p;
    }
    throw new Error('no free pair of ports');
  }

  function fake(args: string[]) {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'gsp-valheim-a2s-'));
    dirs.push(dir);
    const child = spawn(process.execPath, [FAKE_SERVER, ...args, '-savedir', dir], { env: { ...process.env, HOME: dir, FAKE_VALHEIM_BOOT_MS: '30', FAKE_VALHEIM_GEN_MS: '20', FAKE_VALHEIM_STOP_MS: '20' }, stdio: ['pipe', 'pipe', 'pipe'] });
    children.push(child);
    let out = '';
    child.stdout!.on('data', (d: Buffer) => (out += d.toString('utf8')));
    const waitFor = async (re: RegExp) => {
      const end = Date.now() + 10_000 * SCALE;
      while (!re.test(out)) {
        if (Date.now() > end) throw new Error(`timed out waiting for ${re}`);
        await new Promise((r) => setTimeout(r, 20));
      }
    };
    return { child, waitFor, send: (l: string) => child.stdin!.write(`${l}\n`) };
  }

  const ctx = {} as RuntimeCtx;

  it('counts them from the query port, as the agent asks', async () => {
    const port = await freePair();
    const f = fake(['-name', 'gspff test', '-port', String(port), '-world', 'vh', '-password', 'secret12', '-public', '1']);
    await f.waitFor(/Opened Steam server/);
    expect(await steamPlayers(ctx, port + 1)).toEqual({ count: 0, names: [] });
    f.send('fake-join 76561198000000001');
    await f.waitFor(/Got handshake from client 76561198000000001/);
    expect(await steamPlayers(ctx, port + 1)).toEqual({ count: 1, names: [] });
  });

  it('gets no answer from a private server (measured): the query fails', async () => {
    const port = await freePair();
    const f = fake(['-name', 'gspff test', '-port', String(port), '-world', 'vh', '-public', '0']);
    await f.waitFor(/Opened Steam server/);
    await expect(queryInfo('127.0.0.1', port + 1, 300)).rejects.toThrow(/did not answer/);
  });
});
