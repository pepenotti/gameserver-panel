import type { PanelAdapter, PortDecl } from '@gsp/adapter-api';
import { AGENT_CONTAINER_PORT, type PortMapping, type PortProto, type PortRangeInfo, type ServerSpec } from '@gsp/shared';
import { HttpError } from '../http/context';
import type { ServerRow } from './store';

/** Where a server's agent token lives in its `servers.secrets` (next to the adapter's declared secrets). */
export const AGENT_TOKEN_SECRET = 'agentToken';

/** Stands in for the agent token in the spec the panel stores: the token lives only in `servers.secrets`. */
const REDACTED = '(in servers.secrets)';

/** The ports of an adapter that are published on the host (players connect to them). */
export function publishedPorts(adapter: PanelAdapter): PortDecl[] {
  return adapter.meta.ports.filter((p) => p.publish);
}

/**
 * The container a server runs in, as the orchestrator is asked for it
 * (D3, `ServerSpec`): its adapter's image family, the agent's token, the
 * adapter and flavour it loads, the time zone, and each published port
 * (`GAME_PORT_<ID>`: the number the game listens on — the host's, for
 * ports that must be the same inside and out). Everything that makes the
 * container safe is the orchestrator's to derive from `id`.
 */
export function buildSpec(row: ServerRow, adapter: PanelAdapter, o: { agentToken: string; tz: string; variant?: string | null }): ServerSpec {
  const ports: PortMapping[] = [];
  const env: ServerSpec['env'] = { AGENT_TOKEN: o.agentToken, GAME_ADAPTER: adapter.meta.id, TZ: o.tz };
  if (row.flavour !== null) env.GAME_FLAVOUR = row.flavour;
  for (const p of publishedPorts(adapter)) {
    const host = row.ports[p.id];
    if (host === undefined) throw new Error(`Server ${row.id} has no host port for ${p.id}`);
    const container = p.sameInsideOut ? host : p.default;
    ports.push({ container, host, proto: p.proto });
    env[`GAME_PORT_${p.id.toUpperCase().replace(/[^A-Z0-9]/g, '_')}`] = String(container);
  }
  const spec: ServerSpec = { id: row.id, runtime: adapter.meta.runtime, env, ports, memoryMb: row.memLimitMb };
  // The install's image variant (`SERVER_IMAGE_VARIANT`: the fake game images in dev and test slots).
  if (o.variant) spec.variant = o.variant;
  if (row.cpus !== null) spec.cpus = row.cpus;
  return spec;
}

/** The spec as the panel stores it (`servers.spec`): without the agent token. */
export function redactSpec(spec: ServerSpec): ServerSpec {
  return { ...spec, env: { ...spec.env, AGENT_TOKEN: REDACTED } };
}

/** A host port someone already has. */
export interface TakenPort {
  port: number;
  proto: PortProto;
  /** The server that publishes it, or `panel`. */
  by: string;
}

/**
 * The host ports taken before a new server gets its own: every other
 * server's published ports (by its adapter's protocols; both when its
 * adapter is unknown) and the panel's own TCP ports.
 */
export function takenPorts(rows: readonly ServerRow[], adapterOf: (id: string) => PanelAdapter | null, panelTcp: readonly number[]): TakenPort[] {
  const out: TakenPort[] = panelTcp.map((port) => ({ port, proto: 'tcp' as const, by: 'panel' }));
  for (const row of rows) {
    const decls = adapterOf(row.adapter)?.meta.ports ?? null;
    for (const [id, port] of Object.entries(row.ports)) {
      const proto = decls?.find((d) => d.id === id)?.proto;
      for (const p of proto ? [proto] : (['tcp', 'udp'] as const)) out.push({ port, proto: p, by: row.id });
    }
  }
  return out;
}

const MIN_PORT = 1024;
const MAX_PORT = 65535;

/** Ranges as `ORCH_HOST_PORTS` writes them: `30150-30199`, `2456-2499,16261-16299`. */
export function formatPortRanges(ranges: readonly PortRangeInfo[]): string {
  return ranges.map((r) => (r.from === r.to ? String(r.from) : `${r.from}-${r.to}`)).join(',');
}

const inRanges = (port: number, ranges: readonly PortRangeInfo[] | undefined) => !ranges || ranges.some((r) => port >= r.from && port <= r.to);

/**
 * Two of the server's ports on one number and protocol inside its container
 * (a port that must be the same inside and out takes its host number; every
 * other one listens on its default), or one on its agent's port. Published
 * same-inside-and-out ports without a host port yet are left out.
 */
function insideClash(all: readonly PortDecl[], hosts: Readonly<Record<string, number>>): { port: number; proto: PortProto; with: string } | null {
  const seen = new Map<string, string>([[`${AGENT_CONTAINER_PORT}/tcp`, 'agent']]);
  for (const d of all) {
    const host = hosts[d.id];
    const fixedByHost = d.publish && d.sameInsideOut;
    if (fixedByHost && host === undefined) continue;
    const inside = fixedByHost ? host! : d.default;
    const key = `${inside}/${d.proto}`;
    const other = seen.get(key);
    if (other !== undefined) return { port: inside, proto: d.proto, with: other === 'agent' ? 'agent' : 'self' };
    seen.set(key, d.id);
  }
  return null;
}

/**
 * The host ports of a new server (SRV-01): the ones asked for, checked, and
 * the rest picked together (PZ's two UDP ports stay a pair, in the order
 * of their defaults) past anything taken. `allowed` is where this install
 * lets servers publish (`HostInfo.hostPorts`, from `ORCH_HOST_PORTS`;
 * undefined: an orchestrator that doesn't say, so anywhere from 1024 up).
 * Picked ports sit near the adapter's defaults when those are allowed,
 * shifted by the width of the block, else as low as they fit in the
 * allowed ranges. Ports that must be the same inside and out never land on
 * another of the server's ports or its agent's. Refusals name the port.
 */
export function planPorts(adapter: PanelAdapter, requested: Readonly<Record<string, number>> | undefined, taken: readonly TakenPort[], allowed?: readonly PortRangeInfo[]): Record<string, number> {
  const decls = publishedPorts(adapter);
  const asked = requested ?? {};
  const ranges = allowed?.length ? [...allowed].sort((a, b) => a.from - b.from) : undefined;
  for (const [id, port] of Object.entries(asked)) {
    if (!decls.some((d) => d.id === id)) throw new HttpError(400, 'unknown-port', undefined, { port: id });
    if (!Number.isInteger(port) || port < MIN_PORT || port > MAX_PORT) throw new HttpError(400, 'invalid-port', undefined, { port: id, min: MIN_PORT, max: MAX_PORT });
    if (ranges && !inRanges(port, ranges)) {
      throw new HttpError(400, 'invalid-port', undefined, { port: id, min: ranges[0]!.from, max: Math.max(...ranges.map((r) => r.to)), ranges: formatPortRanges(ranges) });
    }
  }
  const clash = (port: number, proto: PortProto, mine: TakenPort[]) => [...taken, ...mine].find((t) => t.port === port && t.proto === proto);
  const out: Record<string, number> = {};
  const mine: TakenPort[] = [];
  for (const d of decls) {
    const port = asked[d.id];
    if (port === undefined) continue;
    const t = clash(port, d.proto, mine);
    if (t) throw new HttpError(409, 'port-conflict', undefined, { port, proto: d.proto, with: t.by });
    out[d.id] = port;
    mine.push({ port, proto: d.proto, by: 'self' });
  }
  const inside = insideClash(adapter.meta.ports, out);
  if (inside) throw new HttpError(409, 'port-conflict', undefined, inside);
  const missing = decls.filter((d) => out[d.id] === undefined);
  if (missing.length === 0) return out;

  const low = Math.min(...missing.map((d) => d.default));
  const span = Math.max(...missing.map((d) => d.default)) - low + 1;
  /** The missing ports placed from `base` on, as their defaults are placed from `low`; null when that doesn't fit. */
  const place = (base: number): Record<string, number> | null => {
    const trial = [...mine];
    const placed = { ...out };
    for (const d of missing) {
      const port = base + d.default - low;
      if (port < MIN_PORT || port > MAX_PORT || !inRanges(port, ranges) || clash(port, d.proto, trial)) return null;
      trial.push({ port, proto: d.proto, by: 'self' });
      placed[d.id] = port;
    }
    return insideClash(adapter.meta.ports, placed) ? null : placed;
  };
  // Near the defaults (the ports players and guides know), while this install allows them…
  for (let base = low; base + span - 1 <= MAX_PORT; base += span) {
    if (ranges && !missing.every((d) => inRanges(base + d.default - low, ranges))) break;
    const placed = place(base);
    if (placed) return placed;
  }
  // …else as low as they fit where it lets servers publish.
  for (const r of ranges ?? []) {
    for (let base = Math.max(r.from, MIN_PORT); base + span - 1 <= Math.min(r.to, MAX_PORT); base++) {
      const placed = place(base);
      if (placed) return placed;
    }
  }
  throw new HttpError(409, 'no-free-port');
}
