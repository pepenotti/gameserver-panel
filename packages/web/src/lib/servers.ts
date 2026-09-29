// Creating a server (SRV-01) as the web helps with it: a suggested id, the
// checks the API makes (so the form can say what's wrong before sending),
// suggested ports, and which field an API refusal is about. The API stays
// the authority: it checks all of this again. Pure: no React, so tests can
// import it.
import { SERVER_ID_PATTERN } from '@gsp/shared';
import type { PortDecl, PortRange } from '../api/meta';
import type { ContainerPendingReason } from '../api/server';

/** Ids the panel keeps for itself (`RESERVED_SERVER_IDS` in packages/panel/src/servers/registry.ts). */
export const RESERVED_IDS: readonly string[] = ['default', 'panel'];

const NAME_MAX = 64;
const ID_MAX = 24;
export const MIN_PORT = 1024;
export const MAX_PORT = 65535;

/** A server id from its name: "Mi Server Ñandú #2" → "mi-server-nandu-2" (may still need editing to be valid). */
export function slugify(name: string): string {
  return name
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^[^a-z]+/, '')
    .slice(0, ID_MAX)
    .replace(/-+$/, '');
}

export type IdProblem = 'invalid-server-id' | 'reserved-server-id' | 'server-exists';

/** What the API would say about this id, as an error code; null when it looks fine. */
export function idProblem(id: string, taken: readonly string[]): IdProblem | null {
  if (!SERVER_ID_PATTERN.test(id)) return 'invalid-server-id';
  if (RESERVED_IDS.includes(id)) return 'reserved-server-id';
  if (taken.includes(id)) return 'server-exists';
  return null;
}

export type NameProblem = 'invalid-server-name' | 'server-name-taken';

/** What the API would say about this name (it trims it and compares names without case). */
export function nameProblem(name: string, taken: readonly string[]): NameProblem | null {
  const n = name.trim();
  if (n.length === 0 || n.length > NAME_MAX || /[\u0000-\u001f\u007f]/.test(n)) return 'invalid-server-name';
  if (taken.some((x) => x.toLowerCase() === n.toLowerCase())) return 'server-name-taken';
  return null;
}

/** The ports a game publishes on the host (players connect to them); the others stay inside its container. */
export function publishedPorts(ports: readonly PortDecl[]): PortDecl[] {
  return ports.filter((p) => p.publish);
}

export interface TakenPort {
  port: number;
  proto: 'tcp' | 'udp';
}

/** Ranges the way the panel writes them: `30150-30199`, `2456-2499, 16261-16299`. */
export function formatRanges(ranges: readonly PortRange[]): string {
  return ranges.map((r) => (r.from === r.to ? String(r.from) : `${r.from}-${r.to}`)).join(', ');
}

/** Whether a port is one this install lets servers publish (no ranges: anywhere). */
export function inRanges(port: number, ranges: readonly PortRange[] | null | undefined): boolean {
  return !ranges?.length || ranges.some((r) => port >= r.from && port <= r.to);
}

/**
 * Ports for a new server, the way the panel picks them when none are given
 * (`planPorts` in packages/panel/src/servers/spec.ts): near the adapter's
 * defaults, shifted together past the ports other servers publish, while
 * the host allows them; else as low as they fit in the host's ranges. Null
 * when nothing fits. The panel's own ports and other programs' aren't known
 * here: the API still refuses a clash.
 */
export function suggestPorts(decls: readonly PortDecl[], taken: readonly TakenPort[], ranges?: readonly PortRange[] | null): Record<string, number> | null {
  const published = publishedPorts(decls);
  if (published.length === 0) return {};
  const allowed = ranges?.length ? [...ranges].sort((x, y) => x.from - y.from) : null;
  const lo = Math.min(...published.map((d) => d.default));
  const span = Math.max(...published.map((d) => d.default)) - lo + 1;
  const place = (base: number): Record<string, number> | null => {
    const mine: TakenPort[] = [];
    for (const d of published) {
      const port = base + d.default - lo;
      if (port < MIN_PORT || port > MAX_PORT || !inRanges(port, allowed) || [...taken, ...mine].some((t) => t.port === port && t.proto === d.proto)) return null;
      mine.push({ port, proto: d.proto });
    }
    return Object.fromEntries(published.map((d) => [d.id, base + d.default - lo]));
  };
  for (let base = lo; base + span - 1 <= MAX_PORT; base += span) {
    if (allowed && !published.every((d) => inRanges(base + d.default - lo, allowed))) break;
    const placed = place(base);
    if (placed) return placed;
  }
  for (const r of allowed ?? []) {
    for (let base = Math.max(r.from, MIN_PORT); base + span - 1 <= Math.min(r.to, MAX_PORT); base++) {
      const placed = place(base);
      if (placed) return placed;
    }
  }
  return null;
}

export type PortProblem = { kind: 'invalid' } | { kind: 'outside' } | { kind: 'twice' } | { kind: 'taken'; by: string };

/**
 * What's wrong with one port of the form: out of range, outside what the
 * host allows, used twice, or another server's. An empty port is fine: the
 * panel picks one.
 */
export function portProblem(
  id: string,
  ports: Readonly<Record<string, number | null>>,
  decls: readonly PortDecl[],
  taken: readonly (TakenPort & { by: string })[],
  ranges?: readonly PortRange[] | null,
): PortProblem | null {
  const published = publishedPorts(decls);
  const d = published.find((x) => x.id === id);
  const v = ports[id];
  if (!d || v === null || v === undefined) return null;
  if (!Number.isInteger(v) || v < MIN_PORT || v > MAX_PORT) return { kind: 'invalid' };
  if (!inRanges(v, ranges)) return { kind: 'outside' };
  if (published.some((o) => o.id !== id && o.proto === d.proto && ports[o.id] === v)) return { kind: 'twice' };
  const other = taken.find((x) => x.port === v && x.proto === d.proto);
  return other ? { kind: 'taken', by: other.by } : null;
}

/**
 * The most memory a game may be given on this host (its launch setting, MiB):
 * the host's limit per server less what the container needs on top, rounded
 * down to the setting's step. Null when the host doesn't say.
 */
export function maxGameMemory(maxMemMb: number | null | undefined, overheadMb: number, step?: number): number | null {
  if (maxMemMb === null || maxMemMb === undefined) return null;
  const room = maxMemMb - overheadMb;
  return step ? Math.floor(room / step) * step : room;
}

/** A field of the create form. */
export type CreateField = 'game' | 'name' | 'id' | 'memory' | 'launch' | `port:${string}`;

/**
 * Which field a refusal of `POST /api/servers` is about, and the port it
 * names (for the message), from its code and details: port refusals name the
 * port id (`unknown-port`, `invalid-port`), the port number (`port-conflict`
 * from the panel) or the spec field (`ports[<i>]…` from the orchestrator,
 * in the order the adapter publishes them).
 */
export function createErrorField(code: string, extra: Record<string, unknown>, decls: readonly PortDecl[], ports: Readonly<Record<string, number | null>>): { field: CreateField | null; port?: number } {
  const published = publishedPorts(decls);
  const byField = (field: unknown) => {
    const i = typeof field === 'string' ? /^ports\[(\d+)\]/.exec(field)?.[1] : undefined;
    const d = i === undefined ? undefined : published[Number(i)];
    return d ? { field: `port:${d.id}` as const, port: ports[d.id] ?? undefined } : null;
  };
  switch (code) {
    case 'invalid-server-id':
    case 'reserved-server-id':
    case 'server-exists':
      return { field: 'id' };
    case 'invalid-server-name':
    case 'server-name-taken':
      return { field: 'name' };
    case 'unknown-adapter':
    case 'unknown-flavour':
    case 'arch-unsupported':
    case 'eula-required':
      return { field: 'game' };
    case 'memory-too-low':
      return { field: 'memory' };
    case 'invalid-options':
      return { field: 'launch' };
    case 'unknown-port':
    case 'invalid-port':
      return typeof extra.port === 'string' ? { field: `port:${extra.port}` } : { field: null };
    case 'port-conflict': {
      if (typeof extra.port === 'number') {
        const d = published.find((x) => ports[x.id] === extra.port && (extra.proto === undefined || x.proto === extra.proto));
        return { field: d ? `port:${d.id}` : null, port: extra.port };
      }
      return byField(extra.field) ?? { field: null };
    }
    case 'orchestrator-refused':
      // Memory above what the host gives one server (the panel's check says `memLimitMb`, the orchestrator's `memoryMb`).
      if (typeof extra.maxMb === 'number' || extra.field === 'memLimitMb' || extra.field === 'memoryMb') return { field: 'memory' };
      return byField(extra.field) ?? { field: null };
    default:
      return { field: null };
  }
}

type PendingHelpKey = 'servers.pendingStartHelp' | 'servers.pendingImageHelp' | 'servers.pendingDerivationHelp';

/**
 * What a waiting container's "Applies at next start" says (SRV-05, SRV-06,
 * HST-01), one message per reason: new limits, a newer runtime image,
 * containers built another way, or several.
 */
export function pendingHelpKeys(reasons: readonly ContainerPendingReason[]): PendingHelpKey[] {
  const keys: PendingHelpKey[] = [];
  if (reasons.includes('settings') || reasons.length === 0) keys.push('servers.pendingStartHelp');
  if (reasons.includes('image')) keys.push('servers.pendingImageHelp');
  if (reasons.includes('derivation')) keys.push('servers.pendingDerivationHelp');
  return keys;
}
