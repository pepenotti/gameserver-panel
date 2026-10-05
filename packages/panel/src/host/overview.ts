import { lstatSync, readdirSync, statfsSync, type Dirent } from 'node:fs';
import path from 'node:path';
import type { I18n, PanelAdapter } from '@gsp/adapter-api';
import type { ContainerState, CpuArch, DockerKind, HostPlatform, HostUsage, VolumeUsage } from '@gsp/shared';
import type { Deps } from '../http/deps';
import { serverInstallView, type ServerInstallView } from '../routes/installs';
import type { ServerContext } from '../servers/context';
import { hostLimitations, type HostLimitation } from './limitations';
import { addressesOf, type AddressView, type HostTraitsCache } from './traits';

const MIB = 1024 * 1024;

/** A server as the host overview shows it (HST-03). */
export interface HostOverviewServer {
  id: string;
  name: string;
  adapter: string;
  /** The game's and flavour's names, from its adapter (the web is game-neutral). */
  adapterName: I18n | null;
  flavour: string | null;
  flavourName: I18n | null;
  /** Its game's state as its agent says; null while the agent doesn't answer. */
  state: string | null;
  /** Its container's state as Docker says; null when it has none, or the orchestrator can't say. */
  container: Exclude<ContainerState, 'missing'> | null;
  /** Its limits (SRV-05): memory, MiB; CPU in cores (null: none). */
  memLimitMb: number;
  cpus: number | null;
  /** Now, while it runs: memory in use (page cache left out), and CPU in percent of one core. */
  memBytes: number | null;
  cpuPercent: number | null;
  /** Its own files besides its game's: its world and settings, and its home folder where the game has one. Null: not measured. */
  dataBytes: number | null;
  /** What it runs from (HST-09), with its progress while being made; null for a server the orchestrator doesn't run. */
  install: ServerInstallView | null;
  /** The size of the install it runs from (shared or its own), as Docker measured it, else as its install job counted it. */
  installBytes: number | null;
  /** Its backups in the panel's backups folder. */
  backups: { count: number; bytes: number };
}

/** A limit to look at (SRV-05): the servers' memory limits add up to more than Docker has (`running`: those running now already do). */
export interface HostWarning {
  code: 'memory-over' | 'memory-over-running';
  limitsMb: number;
  hostMb: number;
}

export interface HostOverviewTotals {
  memory: {
    /** Every server's memory limit, added up: what they may take when all run at full use. */
    limitsMb: number;
    /** The limits of the servers running now. */
    runningLimitsMb: number;
    /** What the running servers use now; null when it couldn't be measured. */
    usedBytes: number | null;
    /** The memory Docker has; null when the orchestrator doesn't say. */
    hostBytes: number | null;
  };
  cpu: {
    /** The running servers' CPU now, added up, in percent of one core; null when it couldn't be measured. */
    percent: number | null;
    hostCpus: number | null;
    /** CPU limits of the servers that have one, added up (cores), and how many servers have none. */
    limitsCpus: number;
    unlimited: number;
  };
  /** Disk, bytes: the servers' own files, game files (shared installs, servers' own and old copies, install jobs' homes), backups, the panel's own; null: not measured. */
  disk: { serversBytes: number | null; installsBytes: number | null; backupsBytes: number | null; panelBytes: number | null; totalBytes: number | null };
  /** The disk the backups folder is on; null when it can't be read. */
  backupsDisk: { freeBytes: number; sizeBytes: number } | null;
}

/** `GET /api/host/overview` (HST-03, HST-07, SRV-05). */
export interface HostOverview {
  at: string;
  /** What the host is; null when the orchestrator can't be asked. */
  host: {
    arch: CpuArch;
    cpus: number;
    memBytes: number;
    dockerVersion: string;
    os: string;
    docker: DockerKind | null;
    platform: HostPlatform | null;
    /** The most memory one server may have, MiB (`ORCH_MAX_MEM_MB`); null when the orchestrator doesn't say. */
    maxMemMb: number | null;
  } | null;
  /** Whether players' and visitors' addresses arrive (HST-07). */
  addresses: AddressView;
  servers: HostOverviewServer[];
  totals: HostOverviewTotals;
  warnings: HostWarning[];
  /** The limitations that apply to this host (HST-07, UX-04). */
  limitations: HostLimitation[];
  /** When each part was measured; null: it couldn't be (the orchestrator is older or unreachable, Docker was busy). */
  measured: { usage: string | null; disk: string | null; backups: string | null };
}

export interface HostOverviewOptions {
  deps: Pick<Deps, 'servers' | 'serverRows' | 'orchestrator' | 'adapters' | 'env'>;
  traits: HostTraitsCache;
  /** How long an overview is kept (default 5 s: a page that refreshes doesn't ask Docker each time). */
  ttlMs?: number;
  /** How long the backups folder's size is kept (default 60 s: it is a walk of the folder). */
  backupsTtlMs?: number;
  now?: () => number;
}

/** Most files counted in the backups folder: a folder with more is reported as unmeasured rather than walked for long. */
const MAX_BACKUP_ENTRIES = 200_000;

/** The size of the files under a folder (links not followed), or null when it has more than `MAX_BACKUP_ENTRIES` entries. */
export function folderSize(dir: string): number | null {
  let total = 0;
  let seen = 0;
  const stack = [dir];
  while (stack.length) {
    const d = stack.pop()!;
    let entries: Dirent[];
    try {
      entries = readdirSync(d, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (++seen > MAX_BACKUP_ENTRIES) return null;
      const p = path.join(d, e.name);
      if (e.isDirectory()) stack.push(p);
      else if (e.isFile()) {
        try {
          total += lstatSync(p).size;
        } catch {
          // Gone since it was listed (a backup's temporary file).
        }
      }
    }
  }
  return total;
}

const sum = (xs: (number | null)[]): number | null => (xs.length && xs.every((x) => x !== null) ? xs.reduce<number>((n, x) => n + x!, 0) : xs.length ? null : 0);

/**
 * The host overview (HST-03): every server's state, limits, use and files,
 * the totals against what the host has with a warning when the memory
 * limits add up to more (SRV-05), the host's traits and the limitations
 * that apply (HST-07). Built from the orchestrator (`/v1/host`,
 * `/v1/host/usage`), the panel's own rows and installs, and the backups
 * folder; kept a few seconds so a page that refreshes doesn't ask Docker
 * each time, and built once at a time.
 */
export class HostOverviewService {
  private cached: { at: number; value: HostOverview } | null = null;
  private building: Promise<HostOverview> | null = null;
  private backupsCache: { at: number; bytes: number | null; disk: HostOverviewTotals['backupsDisk'] } | null = null;

  constructor(private readonly o: HostOverviewOptions) {}

  private now(): number {
    return this.o.now?.() ?? Date.now();
  }

  async get(): Promise<HostOverview> {
    if (this.cached && this.now() - this.cached.at < (this.o.ttlMs ?? 5000)) return this.cached.value;
    this.building ??= this.build()
      .then((value) => {
        this.cached = { at: this.now(), value };
        return value;
      })
      .finally(() => {
        this.building = null;
      });
    return this.building;
  }

  /** The backups folder's size and its disk, kept `backupsTtlMs`. */
  private backups(): { at: number; bytes: number | null; disk: HostOverviewTotals['backupsDisk'] } {
    if (this.backupsCache && this.now() - this.backupsCache.at < (this.o.backupsTtlMs ?? 60_000)) return this.backupsCache;
    const dir = this.o.deps.env.backupDir;
    let disk: HostOverviewTotals['backupsDisk'] = null;
    try {
      const s = statfsSync(dir);
      disk = { freeBytes: s.bavail * s.bsize, sizeBytes: s.blocks * s.bsize };
    } catch {
      // No such folder yet, or a filesystem that can't say: unknown.
    }
    this.backupsCache = { at: this.now(), bytes: folderSize(dir), disk };
    return this.backupsCache;
  }

  private async build(): Promise<HostOverview> {
    const { deps } = this.o;
    const [info, usage] = await Promise.all([this.o.traits.host(), deps.orchestrator.usage().catch((): HostUsage | null => null)]);
    const addresses = addressesOf(info?.traits, deps.env.clientIpTrustworthy);
    const volumes: VolumeUsage[] | null = usage?.volumes ?? null;
    const sizeOf = (pick: (v: VolumeUsage) => boolean): number | null => (volumes ? sum(volumes.filter(pick).map((v) => v.bytes)) : null);
    const byServer = new Map((usage?.servers ?? []).map((s) => [s.id, s]));
    const backups = this.backups();

    const servers = deps.servers.list().map((s): HostOverviewServer => this.row(s, byServer.get(s.id) ?? null, volumes));

    const running = servers.filter((s) => s.container === 'running');
    const limitsMb = servers.reduce((n, s) => n + s.memLimitMb, 0);
    const runningLimitsMb = running.reduce((n, s) => n + s.memLimitMb, 0);
    const hostBytes = info?.memBytes ?? null;
    const warnings: HostWarning[] = [];
    if (hostBytes !== null) {
      const hostMb = Math.floor(hostBytes / MIB);
      if (runningLimitsMb * MIB > hostBytes) warnings.push({ code: 'memory-over-running', limitsMb: runningLimitsMb, hostMb });
      else if (limitsMb * MIB > hostBytes) warnings.push({ code: 'memory-over', limitsMb, hostMb });
    }
    const measuredUse = usage !== null;
    const disk = {
      serversBytes: sizeOf((v) => v.use === 'data' || v.use === 'steam'),
      installsBytes: sizeOf((v) => v.use === 'install' || v.use === 'shared-install' || v.use === 'job-home'),
      backupsBytes: backups.bytes,
      panelBytes: sizeOf((v) => v.use === 'stack'),
    };
    return {
      at: new Date(this.now()).toISOString(),
      host: info && {
        arch: info.arch,
        cpus: info.cpus,
        memBytes: info.memBytes,
        dockerVersion: info.dockerVersion,
        os: info.os,
        docker: info.traits?.docker ?? null,
        platform: info.traits?.platform ?? null,
        maxMemMb: info.maxMemMb ?? null,
      },
      addresses,
      servers,
      totals: {
        memory: { limitsMb, runningLimitsMb, usedBytes: measuredUse ? sum(running.map((s) => s.memBytes)) : null, hostBytes },
        cpu: {
          percent: measuredUse ? sum(running.map((s) => s.cpuPercent)) : null,
          hostCpus: info?.cpus ?? null,
          limitsCpus: servers.reduce((n, s) => n + (s.cpus ?? 0), 0),
          unlimited: servers.filter((s) => s.cpus === null).length,
        },
        disk: { ...disk, totalBytes: sum([disk.serversBytes, disk.installsBytes, disk.backupsBytes, disk.panelBytes]) },
        backupsDisk: backups.disk,
      },
      warnings,
      limitations: hostLimitations({ arch: info?.arch ?? null, traits: info?.traits ?? null, addresses }),
      measured: { usage: usage?.at ?? null, disk: usage?.volumesAt ?? null, backups: new Date(backups.at).toISOString() },
    };
  }

  private row(s: ServerContext, u: HostUsage['servers'][number] | null, volumes: VolumeUsage[] | null): HostOverviewServer {
    const { deps } = this.o;
    const adapter: PanelAdapter | undefined = deps.adapters.find((a) => a.meta.id === s.row.adapter);
    // What it runs from now: the shared install its container mounts, else its own install volume.
    const shared = s.row.spec?.install ?? null;
    const installVolume = volumes?.find((v) => (shared ? v.use === 'shared-install' && v.install === shared : v.use === 'install' && v.server === s.id)) ?? null;
    const installBytes = installVolume?.bytes ?? (shared ? (deps.servers.installs.get(shared)?.bytes ?? null) : null);
    const own = volumes?.filter((v) => v.server === s.id && (v.use === 'data' || v.use === 'steam')) ?? [];
    const list = s.backups.list();
    return {
      id: s.id,
      name: s.row.name,
      adapter: s.row.adapter,
      adapterName: adapter?.meta.name ?? null,
      flavour: s.row.flavour,
      flavourName: (s.row.flavour !== null ? adapter?.meta.flavours.find((f) => f.id === s.row.flavour)?.name : null) ?? null,
      state: s.feed.connected ? (s.feed.status_?.state ?? null) : null,
      container: u?.state ?? null,
      memLimitMb: s.row.memLimitMb,
      cpus: s.row.cpus,
      memBytes: u?.stats?.memBytes ?? null,
      cpuPercent: u?.stats?.cpuPercent ?? null,
      dataBytes: own.length ? sum(own.map((v) => v.bytes)) : null,
      install: serverInstallView(deps, s),
      installBytes,
      backups: { count: list.length, bytes: list.reduce((n, b) => n + (b.size ?? 0), 0) },
    };
  }
}
