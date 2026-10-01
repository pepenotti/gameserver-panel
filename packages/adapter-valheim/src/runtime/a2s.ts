/**
 * A small Steam server query client (A2S_INFO over UDP, Valve's "Server
 * queries" protocol): how many players a Valheim server listed publicly
 * has (PLY-01). Valheim answers on its query port (the game port + 1) only
 * with `-public 1`; the measured 1.0.16 answered at once, without the
 * challenge step (fixtures/valheim/1.0.16/a2s/public.json). Servers that
 * follow Valve's newer rule answer a first request with a challenge, which
 * the request then repeats; both are handled.
 */
import dgram from 'node:dgram';
import { isIP } from 'node:net';

/** What A2S_INFO says about a server (the fields this client reads). */
export interface A2sInfo {
  protocol: number;
  name: string;
  map: string;
  folder: string;
  game: string;
  appId: number;
  players: number;
  maxPlayers: number;
  bots: number;
  version: string;
  /** From the extra data, when the server sends it. */
  port?: number;
  keywords?: string;
  gameId?: string;
}

const SINGLE = 0xffffffff;
const INFO_REQUEST = 0x54;
const INFO_REPLY = 0x49;
const CHALLENGE_REPLY = 0x41;
/** A server may ask for a challenge, then (rarely) another: two are enough. */
const MAX_CHALLENGES = 2;

/** A reply that isn't an A2S_INFO answer this client can read. */
export class A2sError extends Error {}

/** The A2S_INFO request, with the challenge a server asked for. */
export function infoRequest(challenge?: Buffer): Buffer {
  const head = Buffer.alloc(5);
  head.writeUInt32LE(SINGLE, 0);
  head.writeUInt8(INFO_REQUEST, 4);
  return Buffer.concat([head, Buffer.from('Source Engine Query\0', 'latin1'), ...(challenge ? [challenge] : [])]);
}

/** Reads an A2S_INFO reply (after the 0xFFFFFFFF header and 0x49). Throws `A2sError` on a short or odd packet. */
export function parseInfo(buf: Buffer): A2sInfo {
  let at = 0;
  const need = (n: number) => {
    if (at + n > buf.length) throw new A2sError('The server query reply was cut short');
  };
  const u8 = () => (need(1), buf.readUInt8(at++));
  const u16 = () => {
    need(2);
    const v = buf.readUInt16LE(at);
    at += 2;
    return v;
  };
  const u64 = () => {
    need(8);
    const v = buf.readBigUInt64LE(at);
    at += 8;
    return v.toString();
  };
  const str = () => {
    const end = buf.indexOf(0, at);
    if (end < 0) throw new A2sError('The server query reply was cut short');
    const s = buf.toString('utf8', at, end);
    at = end + 1;
    return s;
  };
  need(5);
  if (buf.readUInt32LE(0) !== SINGLE || buf.readUInt8(4) !== INFO_REPLY) throw new A2sError('Not a server info reply');
  at = 5;
  const info: A2sInfo = { protocol: u8(), name: str(), map: str(), folder: str(), game: str(), appId: u16(), players: u8(), maxPlayers: u8(), bots: u8(), version: '' };
  // Server type, environment, visibility, VAC: one byte each.
  need(4);
  at += 4;
  info.version = str();
  if (at < buf.length) {
    const edf = u8();
    if (edf & 0x80) info.port = u16();
    if (edf & 0x10) u64();
    if (edf & 0x40) {
      u16();
      str();
    }
    if (edf & 0x20) info.keywords = str();
    if (edf & 0x01) info.gameId = u64();
  }
  return info;
}

/**
 * Asks `host:port` for its A2S_INFO, answering a challenge if the server
 * sends one; each reply has `timeoutMs` to come. Throws when none comes, or
 * when it can't be read.
 */
export function queryInfo(host: string, port: number, timeoutMs = 2_000): Promise<A2sInfo> {
  if (isIP(host) === 0) return Promise.reject(new Error(`Not an IP address: ${host}`));
  return new Promise((resolve, reject) => {
    const sock = dgram.createSocket(isIP(host) === 6 ? 'udp6' : 'udp4');
    let challenges = 0;
    let timer: NodeJS.Timeout | undefined;
    const finish = (e: Error | null, info?: A2sInfo) => {
      clearTimeout(timer);
      sock.close();
      if (e) reject(e);
      else resolve(info!);
    };
    const send = (challenge?: Buffer) => {
      clearTimeout(timer);
      timer = setTimeout(() => finish(new Error(`The server did not answer Steam's server query on port ${port}`)), timeoutMs);
      sock.send(infoRequest(challenge), port, host, (e) => e && finish(e));
    };
    sock.on('error', (e) => finish(e));
    sock.on('message', (msg, from) => {
      // Only the server asked: anything else on this socket is ignored.
      if (from.port !== port) return;
      if (msg.length >= 9 && msg.readUInt32LE(0) === SINGLE && msg.readUInt8(4) === CHALLENGE_REPLY) {
        if (++challenges > MAX_CHALLENGES) return finish(new A2sError('The server kept asking for a challenge'));
        return send(msg.subarray(5, 9));
      }
      try {
        finish(null, parseInfo(msg));
      } catch (e) {
        finish(e as Error);
      }
    });
    send();
  });
}
