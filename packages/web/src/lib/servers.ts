// Creating a server (SRV-01) as the web helps with it: a suggested id, the
// checks the API makes (so the form can say what's wrong before sending),
// suggested ports, and which field an API refusal is about. The API stays
// the authority: it checks all of this again. Pure: no React, so tests can
// import it.
import { SERVER_ID_PATTERN } from '@gsp/shared';
import type { PortDecl } from '../api/meta';

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

/**
 * Ports for a new server, the way the panel picks them when none are given
 * (`planPorts` in packages/panel/src/servers/spec.ts): the adapter's
 * defaults, shifted together past the ports other servers publish. Null
 * when nothing fits. The panel's own ports and other programs' aren't known
 * here: the API still refuses a clash.
 */
export function suggestPorts(decls: readonly PortDecl[], taken: readonly TakenPort[]): Record<string, number> | null {
  const published = publishedPorts(decls);
  if (published.length === 0) return {};
  const lo = Math.min(...published.map((d) => d.default));
  const span = Math.max(...published.map((d) => d.default)) - lo + 1;
  for (let shift = 0; published.every((d) => d.default + shift <= MAX_PORT); shift += span) {
    const mine: TakenPort[] = [];
    const fits = published.every((d) => {
      const port = d.default + shift;
      if (port < MIN_PORT || [...taken, ...mine].some((t) => t.port === port && t.proto === d.proto)) return false;
      mine.push({ port, proto: d.proto });
      return true;
    });
    if (fits) return Object.fromEntries(published.map((d) => [d.id, d.default + shift]));
  }
  return null;
}

export type PortProblem = { kind: 'required' } | { kind: 'invalid' } | { kind: 'twice' } | { kind: 'taken'; by: string };

/** What's wrong with one port of the form: missing, out of range, used twice, or another server's. */
export function portProblem(id: string, ports: Readonly<Record<string, number | null>>, decls: readonly PortDecl[], taken: readonly (TakenPort & { by: string })[]): PortProblem | null {
  const published = publishedPorts(decls);
  const d = published.find((x) => x.id === id);
  const v = ports[id];
  if (!d || v === null || v === undefined) return { kind: 'required' };
  if (!Number.isInteger(v) || v < MIN_PORT || v > MAX_PORT) return { kind: 'invalid' };
  if (published.some((o) => o.id !== id && o.proto === d.proto && ports[o.id] === v)) return { kind: 'twice' };
  const other = taken.find((x) => x.port === v && x.proto === d.proto);
  return other ? { kind: 'taken', by: other.by } : null;
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
      return byField(extra.field) ?? { field: null };
    default:
      return { field: null };
  }
}
