import { isInstallId, isServerId, type HostPlatform, type HostTraits, type VolumeUsage } from '@gsp/shared';
import { installNames, LABEL, names, VOLUME_KINDS, type VolumeKind } from './derive';
import type { DockerInfo, Labels } from './docker';
import { installGameOf } from './installs';

// What the host is and what this stack takes of it (HST-03, HST-07), read
// from Docker alone and reported in the contract's own words: never one of
// Docker's values as it came (its labels may name the owner's account),
// never another stack's volume.

/** Docker Desktop's engine label: where its CLI reaches it (a Windows pipe, or a socket in the owner's home). */
const DESKTOP_LABEL = 'com.docker.desktop.address=';
/** Compose's labels on the volumes it makes for a project: `<project>_<volume>`. */
const COMPOSE_PROJECT = 'com.docker.compose.project';
const COMPOSE_VOLUME = 'com.docker.compose.volume';

/**
 * The host's traits from `/info` (HST-07):
 * - Docker Desktop says so in its operating system ("Docker Desktop") and
 *   labels its engine with its CLI's address; anything else is Docker Engine.
 * - A WSL 2 kernel names Microsoft (Docker Desktop's backend on Windows, or
 *   Docker Engine inside WSL), and Docker Desktop on Windows is reached by a
 *   named pipe: Windows. Docker Desktop's CLI socket lives under
 *   `~/Library/Containers/com.docker.docker/` on macOS and `~/.docker/desktop/`
 *   on Linux. Docker Engine elsewhere runs on Linux.
 * - Behind Docker Desktop every player arrives from its relay's address
 *   (measured on Windows, docs/limitations.md); Docker Engine's port
 *   forwarding is expected to keep players' addresses, not measured yet.
 * Measured on Windows with Docker Desktop; the macOS and Linux Desktop
 * sockets are as Docker documents them, not measured here.
 */
export function traitsOf(info: Pick<DockerInfo, 'OperatingSystem' | 'KernelVersion' | 'Labels'>): HostTraits {
  const label = (info.Labels ?? []).find((l) => typeof l === 'string' && l.startsWith(DESKTOP_LABEL));
  const address = label?.slice(DESKTOP_LABEL.length);
  const desktop = info.OperatingSystem === 'Docker Desktop' || address !== undefined;
  const wsl = /microsoft/i.test(info.KernelVersion ?? '');
  let platform: HostPlatform | null;
  if (wsl || address?.startsWith('npipe:')) platform = 'windows';
  else if (!desktop) platform = 'linux';
  else if (address !== undefined && address.includes('/Library/Containers/com.docker.docker/')) platform = 'macos';
  else if (address !== undefined && address.includes('/.docker/desktop/')) platform = 'linux';
  else platform = null;
  return { docker: desktop ? 'desktop' : 'engine', platform, addressesVisible: desktop ? false : 'expected' };
}

/**
 * What a volume of this stack holds, or null when it isn't one: its labels
 * and its name must both be what this stack's orchestrator (or Compose, for
 * the stack's own volumes) gave it.
 */
export function volumeUseOf(v: { Name: string; Labels: Labels }, stack: string): Pick<VolumeUsage, 'use' | 'server' | 'install'> | null {
  const l = v.Labels ?? {};
  if (l[LABEL.stack] === stack) {
    const sid = l[LABEL.server];
    const kind = l[LABEL.volume] ?? '';
    if (isServerId(sid) && (VOLUME_KINDS as readonly string[]).includes(kind) && v.Name === names(stack, sid).volume(kind as VolumeKind)) return { use: kind as VolumeKind, server: sid, install: null };
    const iid = l[LABEL.install];
    if (isInstallId(iid)) {
      const n = installNames(stack, iid);
      if (v.Name === n.volume && installGameOf(l, stack, iid)) return { use: 'shared-install', server: null, install: iid };
      if (v.Name === n.home && kind === 'job-home') return { use: 'job-home', server: null, install: iid };
    }
    return null;
  }
  const own = l[COMPOSE_VOLUME];
  if (l[COMPOSE_PROJECT] === stack && own && v.Name === `${stack}_${own}`) return { use: 'stack', server: null, install: null };
  return null;
}
