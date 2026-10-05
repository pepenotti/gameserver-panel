// What the host page and the notes about addresses decide (HST-03, HST-07,
// SRV-05), apart from how they are drawn: shares of what the host has, the
// memory warning, the disk's parts, and which settings of a server's game
// act per address.
import type { AddressView, HostOverview, HostOverviewServer, HostOverviewTotals } from '../api/host';
import type { Meta, PerAddressSetting } from '../api/meta';

const MIB = 1024 * 1024;

/** A part of a whole in percent (0–100, rounded); null when either is unknown or the whole is nothing. */
export function percent(part: number | null | undefined, whole: number | null | undefined): number | null {
  if (part === null || part === undefined || whole === null || whole === undefined || !(whole > 0)) return null;
  return Math.round((part / whole) * 100);
}

/**
 * A percentage as the page writes it in the UI language: "150%" and "2.5%"
 * in English, "150 %" and "2,5 %" in Spanish (written out here, not left to
 * the browser's locale data, which differs between browsers).
 */
export function formatPercent(n: number | null | undefined, lang: string): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return '—';
  const v = Math.abs(n) < 10 ? Math.round(n * 10) / 10 : Math.round(n);
  return lang.startsWith('es') ? `${String(v).replace('.', ',')} %` : `${v}%`;
}

/** The memory warning to show (SRV-05): the louder one when the running servers' limits already exceed the host's memory. */
export function memoryWarning(o: Pick<HostOverview, 'warnings'>): { key: 'host.memory.over' | 'host.memory.overRunning'; limitsBytes: number; hostBytes: number } | null {
  const w = o.warnings.find((x) => x.code === 'memory-over-running') ?? o.warnings.find((x) => x.code === 'memory-over');
  if (!w) return null;
  return { key: w.code === 'memory-over-running' ? 'host.memory.overRunning' : 'host.memory.over', limitsBytes: w.limitsMb * MIB, hostBytes: w.hostMb * MIB };
}

/** How full a bar is: what running servers use of what Docker has, and the limits' share (both capped at 100 for drawing). */
export function memoryBar(m: HostOverviewTotals['memory']): { used: number | null; limits: number | null } {
  const cap = (n: number | null) => (n === null ? null : Math.min(100, n));
  return { used: cap(percent(m.usedBytes, m.hostBytes)), limits: cap(percent(m.limitsMb * MIB, m.hostBytes)) };
}

/** The running servers' CPU as a share of every core of the host (percent of one core over cores × 100). */
export function cpuShare(c: HostOverviewTotals['cpu']): number | null {
  return c.percent === null || !c.hostCpus ? null : percent(c.percent, c.hostCpus * 100);
}

/** A server's memory now against its limit (null while it doesn't run, or wasn't measured). */
export function memShare(s: Pick<HostOverviewServer, 'memBytes' | 'memLimitMb'>): number | null {
  return percent(s.memBytes, s.memLimitMb * MIB);
}

/** The disk's parts as the page lists them, each with its label key (null bytes: not measured). */
export function diskParts(d: HostOverviewTotals['disk']): { key: string; bytes: number | null }[] {
  return [
    { key: 'host.disk.servers', bytes: d.serversBytes },
    { key: 'host.disk.installs', bytes: d.installsBytes },
    { key: 'host.disk.backups', bytes: d.backupsBytes },
    { key: 'host.disk.panel', bytes: d.panelBytes },
  ];
}

/**
 * Whether a note about addresses is needed, and which (HST-07): `hidden`
 * where every visitor and player shares one address (Docker Desktop),
 * `unknown` where the panel can't tell; none where they arrive (or are
 * expected to).
 */
export function addressNote(a: AddressView | null | undefined): 'hidden' | 'unknown' | null {
  return a === 'hidden' || a === 'unknown' ? a : null;
}

/** The translation key of a CPU architecture's plain name (x86-64, ARM); null for one the page doesn't know (shown as it is). */
export function archKey(arch: string): string | null {
  return arch === 'amd64' || arch === 'arm64' ? `host.facts.archValue.${arch}` : null;
}

/** The settings of a server's game in a file that act per player address (HST-07): those its flavour has. */
export function perAddressIn(meta: Pick<Meta, 'adapter' | 'server'> | null | undefined, fileId: string): PerAddressSetting[] {
  if (!meta) return [];
  const flavour = meta.server.flavour;
  return (meta.adapter.perAddress ?? []).filter((s) => s.file === fileId && (s.flavours === undefined || (flavour !== null && s.flavours.includes(flavour))));
}
