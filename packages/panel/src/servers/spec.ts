import type { PanelAdapter, PortDecl } from '@gsp/adapter-api';
import type { PortMapping, PortProto, ServerSpec } from '@gsp/shared';
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

/**
 * The host ports of a new server (SRV-01): the ones asked for, checked, and
 * the rest picked near the adapter's defaults, shifted together (PZ's two
 * UDP ports stay a pair) past anything taken. Refusals name the port.
 */
export function planPorts(adapter: PanelAdapter, requested: Readonly<Record<string, number>> | undefined, taken: readonly TakenPort[]): Record<string, number> {
  const decls = publishedPorts(adapter);
  const asked = requested ?? {};
  for (const [id, port] of Object.entries(asked)) {
    if (!decls.some((d) => d.id === id)) throw new HttpError(400, 'unknown-port', undefined, { port: id });
    if (!Number.isInteger(port) || port < MIN_PORT || port > MAX_PORT) throw new HttpError(400, 'invalid-port', undefined, { port: id, min: MIN_PORT, max: MAX_PORT });
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
  const missing = decls.filter((d) => out[d.id] === undefined);
  if (missing.length === 0) return out;
  // Shift the missing ones together, by the width of the adapter's default block.
  const span = Math.max(...missing.map((d) => d.default)) - Math.min(...missing.map((d) => d.default)) + 1;
  for (let shift = 0; ; shift += span) {
    if (missing.some((d) => d.default + shift > MAX_PORT)) throw new HttpError(409, 'no-free-port');
    const trial = [...mine];
    const fits = missing.every((d) => {
      const port = d.default + shift;
      if (port < MIN_PORT || clash(port, d.proto, trial)) return false;
      trial.push({ port, proto: d.proto, by: 'self' });
      return true;
    });
    if (!fits) continue;
    for (const d of missing) out[d.id] = d.default + shift;
    return out;
  }
}
