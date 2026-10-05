// The tests' free ports for a game's declared ports (NFR-07): each free on the
// protocol the game binds it with. A port free on TCP but not on UDP (another
// process holds it, or Windows reserves it for UDP only, as Hyper-V does) once
// went to Avorion's UDP query port in the live contract suite: the fake, like
// the game, failed its start, and the suite failed now and then.
import dgram from 'node:dgram';
import net from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import type { PortDecl } from '@gsp/adapter-api';
import { runtimeAdapter } from '@gsp/adapters/runtime';
import { bindable, freePort, freePortsFor } from './ports';

const label = { en: 'Port', es: 'Puerto' };
const decl = (id: string, proto: PortDecl['proto'], follows?: PortDecl['follows']): PortDecl => ({ id, proto, default: 27000, publish: true, sameInsideOut: true, label, ...(follows ? { follows } : {}) });

const held: (dgram.Socket | net.Server)[] = [];
afterEach(() => {
  for (const h of held.splice(0)) h.close();
});

/** A port held on `proto` (by this process) whose number is free on the other protocol. */
async function holdOn(proto: PortDecl['proto']): Promise<number> {
  for (;;) {
    const port = await freePort(proto === 'udp' ? 'tcp' : 'udp');
    if (proto === 'udp') {
      const s = dgram.createSocket('udp4');
      const ok = await new Promise<boolean>((r) => {
        s.once('error', () => r(false));
        s.bind(port, '127.0.0.1', () => r(true));
      });
      if (!ok) continue;
      held.push(s);
    } else {
      const s = net.createServer();
      const ok = await new Promise<boolean>((r) => {
        s.once('error', () => r(false));
        s.listen(port, '127.0.0.1', () => r(true));
      });
      if (!ok) continue;
      held.push(s);
    }
    return port;
  }
}

/** Proposes `first` numbers, then the system's. */
const proposing = (...first: number[]) => (proto: PortDecl['proto']) => Promise.resolve(first.shift() ?? freePort(proto));

describe('free ports for a game (freePortsFor)', () => {
  it('gives a UDP port only when UDP can bind it, though TCP can', async () => {
    const taken = await holdOn('udp');
    expect(await bindable('tcp', taken), 'free on TCP').toBe(true);
    expect(await bindable('udp', taken), 'taken on UDP').toBe(false);
    const ports = await freePortsFor([decl('query', 'udp')], proposing(taken));
    expect(ports.query).not.toBe(taken);
    expect(await bindable('udp', ports.query!)).toBe(true);
  });

  it('gives a port that another follows on the other protocol only when both can bind it (SRV-01)', async () => {
    const taken = await holdOn('tcp');
    const ports = await freePortsFor([decl('game', 'udp'), decl('gametcp', 'tcp', { id: 'game', offset: 0 }), decl('query', 'udp', { id: 'game', offset: 1 })], proposing(taken));
    expect(ports.game).not.toBe(taken);
    expect(ports.gametcp).toBe(ports.game);
    expect(ports.query).toBe(ports.game! + 1);
    for (const [proto, port] of [['udp', ports.game], ['tcp', ports.gametcp], ['udp', ports.query]] as const) expect(await bindable(proto, port!), `${port}/${proto}`).toBe(true);
  });

  it('never gives two ports one number', async () => {
    const p = await freePort('udp');
    const ports = await freePortsFor([decl('a', 'udp'), decl('b', 'udp')], proposing(p, p));
    expect(ports.a).toBe(p);
    expect(ports.b).not.toBe(p);
  });

  it("gives every port Avorion declares, free on its own protocol", async () => {
    const decls = runtimeAdapter('avorion').meta.ports;
    const ports = await freePortsFor(decls);
    expect(Object.keys(ports)).toEqual(decls.map((d) => d.id));
    for (const d of decls) {
      if (d.follows) expect(ports[d.id], d.id).toBe(ports[d.follows.id]! + d.follows.offset);
      expect(await bindable(d.proto, ports[d.id]!), `${d.id}: ${ports[d.id]}/${d.proto}`).toBe(true);
    }
  });
});
