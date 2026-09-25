/** Host ports below this need privileges on the host: never published for a game server. */
export const FIRST_UNPRIVILEGED_PORT = 1024;

/** An inclusive range of host ports. */
export type PortRange = readonly [first: number, last: number];

/**
 * What this install lets a spec ask for, from the orchestrator's own
 * environment (never from the caller): the host ports servers may publish,
 * the most memory one server may have, how many servers there may be, and
 * whether the `fake` image variants (tests, development) exist here.
 */
export interface Policy {
  hostPorts: readonly PortRange[];
  maxMemMb: number;
  maxServers: number;
  allowFake: boolean;
}

/**
 * `ORCH_HOST_PORTS`: comma-separated ports and inclusive ranges, e.g.
 * `30150-30199` or `2456-2499,16261-16299`. Every port must be 1024–65535.
 */
export function parsePortRanges(text: string): PortRange[] {
  const out: PortRange[] = [];
  for (const part of text.split(',').map((s) => s.trim())) {
    const m = /^(\d{1,5})(?:-(\d{1,5}))?$/.exec(part);
    if (!m) throw new Error(`ORCH_HOST_PORTS: "${part}" is not a port or a range (e.g. 30150-30199)`);
    const first = Number(m[1]);
    const last = m[2] === undefined ? first : Number(m[2]);
    if (first < FIRST_UNPRIVILEGED_PORT || last > 65535 || first > last) throw new Error(`ORCH_HOST_PORTS: ${part} must lie within ${FIRST_UNPRIVILEGED_PORT}-65535, low to high`);
    out.push([first, last]);
  }
  return out;
}

export function inRanges(port: number, ranges: readonly PortRange[]): boolean {
  return ranges.some(([a, b]) => port >= a && port <= b);
}

export const formatRanges = (ranges: readonly PortRange[]) => ranges.map(([a, b]) => (a === b ? String(a) : `${a}-${b}`)).join(',');
