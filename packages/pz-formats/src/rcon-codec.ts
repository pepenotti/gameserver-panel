/**
 * Source RCON framing as PZ 42.20.4 speaks it (fixtures/b42/rcon):
 *   int32le size | int32le id | int32le type | body | 0x00 0x00
 * Long replies arrive as several type-0 packets with the same id (size ≤ 4096),
 * so bodies are kept as bytes and joined before UTF-8 decoding — a split can
 * land inside a multi-byte character.
 */

export const RCON_TYPE = {
  RESPONSE_VALUE: 0,
  EXEC_COMMAND: 2,
  AUTH_RESPONSE: 2,
  AUTH: 3,
} as const;

/** PZ never sends more than 4096; anything far larger means we lost framing. */
const MAX_SIZE = 64 * 1024;

export interface RconPacket {
  id: number;
  type: number;
  body: Buffer;
}

export class RconProtocolError extends Error {}

export function encodePacket(id: number, type: number, body: string): Buffer {
  const b = Buffer.from(body, 'utf8');
  const buf = Buffer.alloc(14 + b.length);
  buf.writeInt32LE(10 + b.length, 0);
  buf.writeInt32LE(id, 4);
  buf.writeInt32LE(type, 8);
  b.copy(buf, 12);
  return buf;
}

export class RconDecoder {
  private pending: Buffer = Buffer.alloc(0);

  push(chunk: Buffer): RconPacket[] {
    this.pending = this.pending.length ? Buffer.concat([this.pending, chunk]) : chunk;
    const out: RconPacket[] = [];
    while (this.pending.length >= 4) {
      const size = this.pending.readInt32LE(0);
      if (size < 10 || size > MAX_SIZE) throw new RconProtocolError(`Bad packet size ${size}`);
      if (this.pending.length < size + 4) break;
      out.push({
        id: this.pending.readInt32LE(4),
        type: this.pending.readInt32LE(8),
        body: Buffer.from(this.pending.subarray(12, 4 + size - 2)),
      });
      this.pending = this.pending.subarray(size + 4);
    }
    return out;
  }

  get bufferedBytes(): number {
    return this.pending.length;
  }
}

/**
 * RCON arguments are space-separated and optionally double-quoted by PZ's
 * command parser, and there is no escape for `"`. Reject anything that could
 * split the command or inject a second one.
 */
export function assertSafeArg(value: string, what = 'argument'): void {
  if (value.length === 0) throw new RconProtocolError(`Empty ${what}`);
  if (value.length > 512) throw new RconProtocolError(`${what} is too long`);
  if (/["\r\n\0]|[\x00-\x1f\x7f]/.test(value)) throw new RconProtocolError(`${what} contains a quote or control character`);
}

/** Quote an argument for a PZ command line (`servermsg "hello"`). */
export function quoteArg(value: string, what?: string): string {
  assertSafeArg(value, what);
  return `"${value}"`;
}

const USERNAME = /^[\p{L}\p{N}_.\- ]{1,32}$/u;

export function assertUsername(name: string): void {
  if (!USERNAME.test(name)) throw new RconProtocolError('Invalid username');
}

export function assertSteamId(id: string): void {
  if (!/^\d{17}$/.test(id)) throw new RconProtocolError('Invalid SteamID64');
}
