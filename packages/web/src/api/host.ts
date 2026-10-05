// The host page and the host's traits as the API answers them (HST-03,
// HST-07, SRV-05): mirrors packages/panel/src/host/overview.ts,
// packages/panel/src/host/limitations.ts and packages/panel/src/routes/host.ts.
import { useQuery } from '@tanstack/react-query';
import { api } from './http';
import type { ServerInstallView } from './installs';
import type { I18n } from './meta';
import { useSession } from './session';

/**
 * Whether players' and visitors' addresses reach the games and the panel:
 * `hidden` (Docker Desktop's relay; measured), `visible` (measured, or the
 * owner says so), `expected` (Docker Engine, not yet measured), `unknown`
 * (the orchestrator doesn't say).
 */
export type AddressView = 'hidden' | 'visible' | 'expected' | 'unknown';

/** `GET /api/host/traits`. */
export interface HostTraitsView {
  addresses: AddressView;
  /** Its docs/limitations.md entry (`limitations.md#…`). */
  doc: string;
}

/** A limitation of this host (HST-07, UX-04). */
export interface HostLimitation {
  id: string;
  level: 'warning' | 'info';
  status: 'measured' | 'expected';
  title: I18n;
  text: I18n;
  doc: string;
}

export interface HostOverviewServer {
  id: string;
  name: string;
  adapter: string;
  adapterName: I18n | null;
  flavour: string | null;
  flavourName: I18n | null;
  state: string | null;
  container: 'created' | 'running' | 'paused' | 'restarting' | 'exited' | 'dead' | null;
  memLimitMb: number;
  cpus: number | null;
  memBytes: number | null;
  /** Percent of one core. */
  cpuPercent: number | null;
  dataBytes: number | null;
  install: ServerInstallView | null;
  installBytes: number | null;
  backups: { count: number; bytes: number };
}

export interface HostWarning {
  code: 'memory-over' | 'memory-over-running';
  limitsMb: number;
  hostMb: number;
}

export interface HostOverviewTotals {
  memory: { limitsMb: number; runningLimitsMb: number; usedBytes: number | null; hostBytes: number | null };
  cpu: { percent: number | null; hostCpus: number | null; limitsCpus: number; unlimited: number };
  disk: { serversBytes: number | null; installsBytes: number | null; backupsBytes: number | null; panelBytes: number | null; totalBytes: number | null };
  backupsDisk: { freeBytes: number; sizeBytes: number } | null;
}

/** `GET /api/host/overview`. */
export interface HostOverview {
  at: string;
  host: {
    arch: string;
    cpus: number;
    memBytes: number;
    dockerVersion: string;
    os: string;
    docker: 'desktop' | 'engine' | null;
    platform: 'windows' | 'macos' | 'linux' | null;
    maxMemMb: number | null;
  } | null;
  addresses: AddressView;
  servers: HostOverviewServer[];
  totals: HostOverviewTotals;
  warnings: HostWarning[];
  limitations: HostLimitation[];
  measured: { usage: string | null; disk: string | null; backups: string | null };
}

/** Whether addresses arrive here, for the notes where it matters (asked once a minute at most). */
export function useHostAddresses(): HostTraitsView | null {
  const { session } = useSession();
  const q = useQuery({
    queryKey: ['host-traits'],
    queryFn: () => api<HostTraitsView>('GET', '/api/host/traits'),
    enabled: !!session && !session.pending,
    staleTime: 60_000,
  });
  return q.data ?? null;
}
