import { describe, expect, it } from 'vitest';
import { assertSafeArg, assertSteamId, assertUsername, encodePacket, quoteArg, RCON_TYPE, RconDecoder, RconProtocolError } from '../src/rcon-codec';
import { fixtureJson } from './fixtures';

interface Event {
  dir: 'in' | 'out';
  id: number;
  type?: number;
  size?: number;
  body?: string;
}

/** Rebuild the exact bytes the server sent, from the recorded packets. */
function serverBytes(events: Event[]): Buffer {
  return Buffer.concat(events.filter((e) => e.dir === 'in').map((e) => encodePacket(e.id, e.type!, e.body!)));
}

describe('encodePacket', () => {
  it('matches the recorded sizes', () => {
    for (const e of fixtureJson<Event[]>('rcon/long.json').filter((x) => x.dir === 'in')) {
      expect(encodePacket(e.id, e.type!, e.body!).readInt32LE(0)).toBe(e.size);
    }
  });
});

describe('RconDecoder on the recorded `help` reply', () => {
  const events = fixtureJson<Event[]>('rcon/long.json');
  const bytes = serverBytes(events);

  it('reassembles packets from any chunking', () => {
    for (const chunkSize of [1, 3, 7, 100, 4099, bytes.length]) {
      const d = new RconDecoder();
      const packets = [];
      for (let i = 0; i < bytes.length; i += chunkSize) packets.push(...d.push(bytes.subarray(i, i + chunkSize)));
      expect(packets.map((p) => [p.id, p.type])).toEqual(events.filter((e) => e.dir === 'in').map((e) => [e.id, e.type]));
      expect(d.bufferedBytes).toBe(0);
    }
  });

  it('gives the full help text when the split bodies are joined', () => {
    const d = new RconDecoder();
    const reply = d.push(bytes).filter((p) => p.id === 10);
    expect(reply).toHaveLength(2);
    expect(reply[0]!.body.length).toBe(4086);
    const text = Buffer.concat(reply.map((p) => p.body)).toString('utf8');
    expect(text).toMatch(/^List of server commands : \n\* additem/);
    expect(text).toContain('* removemapsymbolsforuser : Elimina todos los símbolos');
  });

  it('echoes the sentinel twice after the reply', () => {
    const sentinel = new RconDecoder().push(bytes).filter((p) => p.id === 11);
    expect(sentinel.map((p) => [p.type, p.body.length])).toEqual([
      [RCON_TYPE.RESPONSE_VALUE, 0],
      [RCON_TYPE.RESPONSE_VALUE, 0],
    ]);
  });
});

describe('RconDecoder safety', () => {
  it('keeps multi-byte characters intact across packet splits', () => {
    const full = Buffer.from('ñandú', 'utf8');
    const a = Buffer.alloc(14 + 1);
    a.writeInt32LE(11, 0);
    a.writeInt32LE(5, 4);
    a.writeInt32LE(0, 8);
    full.copy(a, 12, 0, 1); // first byte of "ñ" only
    const b = encodePacket(5, 0, '');
    const rest = Buffer.alloc(14 + full.length - 1);
    rest.writeInt32LE(10 + full.length - 1, 0);
    rest.writeInt32LE(5, 4);
    full.copy(rest, 12, 1);
    const packets = new RconDecoder().push(Buffer.concat([a, rest, b]));
    expect(Buffer.concat(packets.filter((p) => p.body.length).map((p) => p.body)).toString('utf8')).toBe('ñandú');
  });

  it('rejects nonsense sizes instead of buffering forever', () => {
    const bad = Buffer.alloc(12);
    bad.writeInt32LE(10_000_000, 0);
    expect(() => new RconDecoder().push(bad)).toThrow(RconProtocolError);
  });
});

describe('argument safety', () => {
  it('rejects anything that could inject a second command', () => {
    expect(quoteArg('hola a todos')).toBe('"hola a todos"');
    for (const bad of ['a"b', 'line\nbreak', 'x\r', 'nul\0', '']) expect(() => assertSafeArg(bad)).toThrow(RconProtocolError);
    expect(() => assertSafeArg('x'.repeat(600))).toThrow(/too long/);
  });

  it('validates usernames and SteamIDs', () => {
    expect(() => assertUsername('Alice_01')).not.toThrow();
    expect(() => assertUsername('Ñandú')).not.toThrow();
    expect(() => assertUsername('a"; quit')).toThrow();
    expect(() => assertSteamId('76561198000000000')).not.toThrow();
    expect(() => assertSteamId('7656')).toThrow();
  });
});
