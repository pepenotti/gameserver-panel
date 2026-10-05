// Free ports for the tests' games, on the protocols the games use them with.
import dgram from 'node:dgram';
import net from 'node:net';
import type { PortDecl } from '@gsp/adapter-api';

type Proto = PortDecl['proto'];

/** A port the system says is free on `proto` (TCP unless named): it picks one, which is closed again at once. */
export function freePort(proto: Proto = 'tcp'): Promise<number> {
  return new Promise((resolve, reject) => {
    if (proto === 'udp') {
      const s = dgram.createSocket('udp4');
      s.once('error', reject);
      s.bind(0, '127.0.0.1', () => {
        const port = s.address().port;
        s.close(() => resolve(port));
      });
      return;
    }
    const s = net.createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const port = (s.address() as net.AddressInfo).port;
      s.close(() => resolve(port));
    });
  });
}

/** Whether `port` can be bound on 127.0.0.1 over `proto` right now. */
export function bindable(proto: Proto, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    if (proto === 'udp') {
      const s = dgram.createSocket('udp4');
      s.once('error', () => {
        s.close();
        resolve(false);
      });
      s.bind({ port, address: '127.0.0.1', exclusive: true }, () => s.close(() => resolve(true)));
      return;
    }
    const s = net.createServer();
    s.once('error', () => resolve(false));
    s.listen({ port, host: '127.0.0.1', exclusive: true }, () => s.close(() => resolve(true)));
  });
}

/**
 * Ports for every port an adapter declares, as the panel gives them: one that
 * follows another gets its base's number plus its offset (SRV-01). Each number
 * is checked free on each protocol it is used with: one free on TCP may not be
 * on UDP (another process holds it, or the system keeps it out of reach:
 * Windows reserves port ranges for one protocol only, e.g. for Hyper-V), and a
 * game whose port can't be bound fails to start. `pick` proposes numbers (the
 * system's free ones by default; a test can propose its own).
 */
export async function freePortsFor(decls: readonly PortDecl[], pick: (proto: Proto) => Promise<number> = freePort): Promise<Record<string, number>> {
  const base = new Map<string, number>();
  const taken = new Set<number>();
  for (const d of decls) {
    if (d.follows) continue;
    const uses = [{ proto: d.proto, offset: 0 }, ...decls.filter((f) => f.follows?.id === d.id).map((f) => ({ proto: f.proto, offset: f.follows!.offset }))];
    // Proposals come from each protocol in turn: a system that hands out a port reserved on the other one keeps doing so.
    const protos = [...new Set(uses.map((u) => u.proto))];
    let port: number | null = null;
    for (let i = 0; i < 100 && port === null; i++) {
      const p = await pick(protos[i % protos.length]!);
      if (uses.some((u) => taken.has(p + u.offset) || p + u.offset > 65_535)) continue;
      if ((await Promise.all(uses.map((u) => bindable(u.proto, p + u.offset)))).every(Boolean)) port = p;
    }
    if (port === null) throw new Error(`No port free for ${d.id} on ${uses.map((u) => `+${u.offset}/${u.proto}`).join(', ')}`);
    base.set(d.id, port);
    for (const u of uses) taken.add(port + u.offset);
  }
  return Object.fromEntries(decls.map((d) => [d.id, d.follows ? base.get(d.follows.id)! + d.follows.offset : base.get(d.id)!]));
}
