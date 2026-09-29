import { isServerId, type ApplyOptions, type ContainerState, type CpuArch, type DeleteResponse, type HostInfo, type ServerContainer, type ServerSpec, type ServerStats } from '@gsp/shared';
import { IdLocks, Mutex, type Backend } from './backend';
import { agentUrl, DEFAULT_STOP_TIMEOUT_SEC, LABEL, names, planContainer, VOLUME_KINDS, type ContainerPlan, type StackContext } from './derive';
import { DockerError, labelFilter, type DockerClient, type DockerContainer, type DockerContainerSummary, type DockerImage, type DockerInfo, type DockerNetwork, type DockerStats, type DockerVolume, type Labels } from './docker';
import { conflict, notFound, OrchError, refused, unavailable } from './errors';
import type { Policy } from './policy';

/** Compose labels that find the panel container of this stack (it joins every server's network). */
const COMPOSE_PROJECT = 'com.docker.compose.project';
const COMPOSE_SERVICE = 'com.docker.compose.service';
const PANEL_SERVICE = 'panel';

const STATES: ReadonlySet<string> = new Set(['created', 'running', 'paused', 'restarting', 'exited', 'dead']);
const NO_TIME = '0001-01-01T00:00:00Z';
/** The runtime image names `planContainer` derives (`gsp/<repository>:<tag>`): the only ones it looks up. */
const RUNTIME_IMAGE = /^gsp\/[a-z0-9][a-z0-9-]{0,63}:[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/;

/** An image name's content id now, '' when it names none; one lookup per name. */
type ImageIds = (name: string) => Promise<string>;

export interface DockerBackendOptions {
  docker: DockerClient;
  ctx: StackContext;
  policy: Policy;
}

function archOf(a: string): CpuArch {
  if (a === 'x86_64' || a === 'amd64') return 'amd64';
  if (a === 'aarch64' || a === 'arm64') return 'arm64';
  throw unavailable(`This host's CPU architecture (${a}) is not supported: amd64 or arm64 only`);
}

const time = (t: string | undefined) => (!t || t.startsWith(NO_TIME.slice(0, 10)) ? null : t);
const round2 = (n: number) => Math.round(n * 100) / 100;

/** A Docker failure as the API reports it. */
function fromDocker(e: DockerError): OrchError {
  if (/port is already allocated|address already in use/i.test(e.message)) return conflict(`Docker: ${e.message}`);
  if (e.status === 404) return notFound(`Docker: ${e.message}`);
  if (e.status === 409) return conflict(`Docker: ${e.message}`);
  return new OrchError('internal', `Docker: ${e.message}`);
}

/**
 * The orchestrator's Docker side (D3, NFR-02, NFR-03): each server is one
 * container built from `planContainer`, on its own bridge network that only
 * it and the panel join, with its own named volumes. It only ever touches
 * containers, networks and volumes that carry this stack's labels and names.
 * Images are only inspected (never pulled, built or removed): a runtime image
 * rebuilt under its tag is a new content id, and a container on the old one
 * is recreated at the next PUT that doesn't keep it (HST-01, SRV-05).
 */
export class DockerBackend implements Backend {
  private readonly busy = new IdLocks();
  private readonly creating = new Mutex();
  private readonly docker: DockerClient;
  private readonly stack: string;

  constructor(private readonly o: DockerBackendOptions) {
    this.docker = o.docker;
    this.stack = o.ctx.stack;
  }

  private async guard<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (e) {
      if (e instanceof DockerError) throw fromDocker(e);
      throw e;
    }
  }

  async ping(): Promise<void> {
    await this.guard(() => this.docker.call('GET', '/_ping'));
  }

  host(): Promise<HostInfo> {
    return this.guard(async () => {
      const info = await this.docker.call<DockerInfo>('GET', '/info');
      return { arch: archOf(info.Architecture), cpus: info.NCPU, memBytes: info.MemTotal, dockerVersion: info.ServerVersion, os: info.OperatingSystem };
    });
  }

  list(): Promise<ServerContainer[]> {
    return this.guard(async () => {
      const out = new Map<string, ServerContainer>();
      const latest = this.imageIds();
      for (const s of await this.stackContainers()) {
        const id = this.serverIdOf(s);
        if (!id) continue;
        const c = await this.docker.find<DockerContainer>(`/containers/${s.Id}/json`);
        if (c && this.isOurs(c, id)) out.set(id, await this.describe(c, id, latest));
      }
      for (const id of await this.networkIds()) if (!out.has(id)) out.set(id, this.missing(id));
      return [...out.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    });
  }

  apply(spec: ServerSpec, o: ApplyOptions = {}): Promise<ServerContainer> {
    const plan = planContainer(spec, this.o.ctx);
    return this.guard(() =>
      this.busy.run(spec.id, async () => {
        const existing = await this.container(spec.id);
        // The image its tag names now (never pulled): a rebuild under the same tag, as every product upgrade
        // makes, is a new id, and the container moves to it like it would to a new spec (HST-01, SRV-05).
        const latest = await this.latestImageId(plan.image);
        const sameConfig = existing?.Config.Labels?.[LABEL.configHash] === plan.configHash;
        // Kept: the same image; or asked to keep it (its game runs); or its image is gone (nothing to move to).
        if (existing && sameConfig && (existing.Image === latest || o.keepImage === true || latest === '')) {
          // Same container: only make sure the panel (maybe recreated since) still reaches it.
          await this.attachPanel(plan.network);
          return this.describe(existing, spec.id, () => Promise.resolve(latest));
        }
        // Refuse before touching anything; check again once no other create can race.
        if (latest === '') throw unavailable(`The image ${plan.image} is not built on this host`);
        await this.precheck(spec, plan, existing);
        if (existing?.State.Running) await this.stopContainer(existing.Id, DEFAULT_STOP_TIMEOUT_SEC);
        await this.creating.run(async () => {
          await this.precheck(spec, plan, existing);
          await this.ensureVolumes(spec.id, plan);
          await this.ensureNetwork(spec.id);
          await this.attachPanel(plan.network);
          if (existing) await this.docker.call('DELETE', `/containers/${existing.Id}`, { query: { force: true } });
          const r = await this.docker.raw('POST', '/containers/create', { query: { name: plan.name }, body: plan.body });
          if (r.status === 404) throw unavailable(`The image ${plan.image} is not built on this host`);
          if (r.status < 200 || r.status >= 300) throw new DockerError(r.status, (r.data as { message?: string } | null)?.message ?? `Docker answered ${r.status}`);
        });
        return this.describe(await this.mustFind(spec.id), spec.id);
      }),
    );
  }

  start(id: string): Promise<ServerContainer> {
    return this.guard(() =>
      this.busy.run(id, async () => {
        const c = await this.mustFind(id);
        await this.attachPanel(names(this.stack, id).network);
        await this.docker.call('POST', `/containers/${c.Id}/start`, { ok: [204, 304] });
        return this.describe(await this.mustFind(id), id);
      }),
    );
  }

  stop(id: string, timeoutSec = DEFAULT_STOP_TIMEOUT_SEC): Promise<ServerContainer> {
    return this.guard(() =>
      this.busy.run(id, async () => {
        const c = await this.mustFind(id);
        await this.stopContainer(c.Id, timeoutSec);
        return this.describe(await this.mustFind(id), id);
      }),
    );
  }

  restart(id: string, timeoutSec = DEFAULT_STOP_TIMEOUT_SEC): Promise<ServerContainer> {
    return this.guard(() =>
      this.busy.run(id, async () => {
        const c = await this.mustFind(id);
        await this.attachPanel(names(this.stack, id).network);
        await this.docker.call('POST', `/containers/${c.Id}/restart`, { query: { t: timeoutSec }, timeoutMs: (timeoutSec + 60) * 1000 });
        return this.describe(await this.mustFind(id), id);
      }),
    );
  }

  stats(id: string): Promise<ServerStats> {
    return this.guard(async () => {
      const c = await this.mustFind(id);
      const s = await this.docker.call<DockerStats>('GET', `/containers/${c.Id}/stats`, { query: { stream: false } });
      return statsOf(id, s);
    });
  }

  remove(id: string, removeVolumes: boolean): Promise<DeleteResponse> {
    return this.guard(() =>
      this.busy.run(id, async () => {
        const n = names(this.stack, id);
        const c = await this.container(id);
        const net = await this.docker.find<DockerNetwork>(`/networks/${n.network}`);
        if (net && !this.owned(net.Labels, id)) throw refused('id', `Network ${n.network} exists but is not this stack's server ${id}`);
        const volumes: DockerVolume[] = [];
        for (const kind of VOLUME_KINDS) {
          const v = await this.docker.find<DockerVolume>(`/volumes/${n.volume(kind)}`);
          if (v && !this.owned(v.Labels, id)) throw refused('id', `Volume ${v.Name} exists but is not this stack's server ${id}`);
          if (v) volumes.push(v);
        }
        if (c) {
          if (c.State.Running) await this.stopContainer(c.Id, DEFAULT_STOP_TIMEOUT_SEC);
          await this.docker.call('DELETE', `/containers/${c.Id}`, { query: { force: true } });
        }
        if (net) {
          // Inspected again: the server's own endpoint went with its container.
          const full = await this.docker.find<DockerNetwork>(`/networks/${net.Id}`);
          for (const attached of Object.keys(full?.Containers ?? {})) {
            await this.docker.call('POST', `/networks/${net.Id}/disconnect`, { body: { Container: attached, Force: true } });
          }
          await this.docker.call('DELETE', `/networks/${net.Id}`, { ok: [204, 404] });
        }
        if (removeVolumes) for (const v of volumes) await this.docker.call('DELETE', `/volumes/${v.Name}`, { ok: [204, 404] });
        return { removed: c !== null, volumesRemoved: removeVolumes };
      }),
    );
  }

  // ------------------------------------------------------------------ helpers

  private owned(labels: Labels, id: string): boolean {
    return labels?.[LABEL.stack] === this.stack && labels[LABEL.server] === id;
  }

  /** Its name, stack label and server label all agree: a server container of this stack. */
  private isOurs(c: DockerContainer, id: string): boolean {
    return c.Name === `/${names(this.stack, id).container}` && this.owned(c.Config.Labels, id);
  }

  /** The server id of a listed container of this stack whose name matches its labels. */
  private serverIdOf(s: DockerContainerSummary): string | null {
    const id = s.Labels?.[LABEL.server];
    if (!id || !isServerId(id) || s.Labels?.[LABEL.stack] !== this.stack) return null;
    return s.Names.includes(`/${names(this.stack, id).container}`) ? id : null;
  }

  private stackContainers(): Promise<DockerContainerSummary[]> {
    return this.docker.call<DockerContainerSummary[]>('GET', '/containers/json', { query: { all: true, filters: labelFilter(`${LABEL.stack}=${this.stack}`) } });
  }

  /** Servers whose network exists (their container may be gone). */
  private async networkIds(): Promise<string[]> {
    const nets = await this.docker.call<DockerNetwork[]>('GET', '/networks', { query: { filters: labelFilter(`${LABEL.stack}=${this.stack}`) } });
    return nets.flatMap((n) => {
      const id = n.Labels?.[LABEL.server];
      return id && isServerId(id) && n.Name === names(this.stack, id).network && this.owned(n.Labels, id) ? [id] : [];
    });
  }

  /** The server's container, null when there is none; refused when its name is taken by anything else. */
  private async container(id: string): Promise<DockerContainer | null> {
    const name = names(this.stack, id).container;
    const c = await this.docker.find<DockerContainer>(`/containers/${name}/json`);
    if (!c) return null;
    if (!this.isOurs(c, id)) throw refused('id', `Container ${name} exists but is not this stack's server ${id}`);
    return c;
  }

  private async mustFind(id: string): Promise<DockerContainer> {
    const c = await this.container(id);
    if (!c) throw notFound(`Server ${id} has no container`);
    return c;
  }

  /** A container as the API reports it, with the image id Docker recorded on it and the one its image names now. */
  private async describe(c: DockerContainer, id: string, latest: ImageIds = (name) => this.latestImageId(name)): Promise<ServerContainer> {
    const status = c.State.Status;
    const state: ContainerState = STATES.has(status) ? (status as ContainerState) : status === 'removing' ? 'exited' : 'dead';
    return {
      id,
      state,
      startedAt: time(c.State.StartedAt),
      finishedAt: time(c.State.FinishedAt),
      exitCode: state === 'exited' || state === 'dead' ? c.State.ExitCode : null,
      image: c.Config.Image,
      specHash: c.Config.Labels?.[LABEL.specHash] ?? '',
      agentUrl: agentUrl(this.stack, id),
      imageId: c.Image ?? '',
      latestImageId: await latest(c.Config.Image),
    };
  }

  private missing(id: string): ServerContainer {
    return { id, state: 'missing', startedAt: null, finishedAt: null, exitCode: null, image: '', specHash: '', agentUrl: agentUrl(this.stack, id), imageId: '', latestImageId: '' };
  }

  /**
   * The content id a runtime image name resolves to on this host now, '' when
   * it isn't built. Only names of the allowlist's shape are looked up (a
   * container's own `Config.Image` is not trusted into a path).
   */
  private async latestImageId(name: string): Promise<string> {
    if (!RUNTIME_IMAGE.test(name)) return '';
    const image = await this.docker.find<DockerImage>(`/images/${name}/json`);
    return typeof image?.Id === 'string' ? image.Id : '';
  }

  /** `latestImageId`, looked up once per name (a listing of many servers of one image). */
  private imageIds(): ImageIds {
    const seen = new Map<string, Promise<string>>();
    return (name) => {
      let p = seen.get(name);
      if (!p) {
        p = this.latestImageId(name);
        seen.set(name, p);
      }
      return p;
    };
  }

  private stopContainer(containerId: string, timeoutSec: number): Promise<unknown> {
    return this.docker.call('POST', `/containers/${containerId}/stop`, { query: { t: timeoutSec }, ok: [204, 304], timeoutMs: (timeoutSec + 60) * 1000 });
  }

  /** Everything that can refuse or clash, before anything changes. */
  private async precheck(spec: ServerSpec, plan: ContainerPlan, existing: DockerContainer | null): Promise<void> {
    if (spec.cpus !== undefined) {
      const info = await this.docker.call<DockerInfo>('GET', '/info');
      if (spec.cpus > info.NCPU) throw refused('cpus', `This host has ${info.NCPU} CPUs`);
    }
    if (!existing) {
      const ids = new Set(await this.networkIds());
      for (const s of await this.stackContainers()) {
        const sid = this.serverIdOf(s);
        if (sid) ids.add(sid);
      }
      if (!ids.has(spec.id) && ids.size >= this.o.policy.maxServers) throw refused('id', `This host allows at most ${this.o.policy.maxServers} servers`);
    }
    const net = await this.docker.find<DockerNetwork>(`/networks/${plan.network}`);
    if (net && (net.Name !== plan.network || !this.owned(net.Labels, spec.id))) throw refused('id', `Network ${plan.network} exists but is not this stack's server ${spec.id}`);
    for (const v of plan.volumes) {
      const found = await this.docker.find<DockerVolume>(`/volumes/${v.name}`);
      if (found && !this.owned(found.Labels, spec.id)) throw refused('id', `Volume ${v.name} exists but is not this stack's server ${spec.id}`);
    }
    await this.checkPorts(spec, existing?.Id);
  }

  /**
   * Host ports another container publishes: running containers of any
   * project, and this stack's stopped servers (they get theirs back on start).
   */
  private async checkPorts(spec: ServerSpec, selfId: string | undefined): Promise<void> {
    if (spec.ports.length === 0) return;
    const taken = new Map<string, string>();
    const all = await this.docker.call<DockerContainerSummary[]>('GET', '/containers/json', { query: { all: true } });
    for (const s of all) {
      if (s.Id === selfId) continue;
      const sid = this.serverIdOf(s);
      const who = sid ? `server ${sid}` : 'another container on this host';
      for (const p of s.Ports ?? []) if (p.PublicPort) taken.set(`${p.PublicPort}/${p.Type}`, who);
      if (sid && s.State !== 'running') {
        const c = await this.docker.find<DockerContainer>(`/containers/${s.Id}/json`);
        for (const [key, binds] of Object.entries(c?.HostConfig.PortBindings ?? {})) {
          const proto = key.split('/')[1] ?? 'tcp';
          for (const b of binds ?? []) if (b.HostPort) taken.set(`${b.HostPort}/${proto}`, who);
        }
      }
    }
    spec.ports.forEach((p, i) => {
      const who = taken.get(`${p.host}/${p.proto}`);
      if (who) throw conflict(`Host port ${p.host}/${p.proto} is already published by ${who}`, `ports[${i}].host`);
    });
  }

  private async ensureVolumes(id: string, plan: ContainerPlan): Promise<void> {
    for (const v of plan.volumes) {
      if (await this.docker.find<DockerVolume>(`/volumes/${v.name}`)) continue;
      await this.docker.call('POST', '/volumes/create', { body: { Name: v.name, Driver: 'local', Labels: { [LABEL.stack]: this.stack, [LABEL.server]: id, [LABEL.volume]: v.kind } } });
    }
  }

  /** The server's own bridge network: egress for the game, and the panel's way to its agent. */
  private async ensureNetwork(id: string): Promise<void> {
    const name = names(this.stack, id).network;
    if (await this.docker.find<DockerNetwork>(`/networks/${name}`)) return;
    await this.docker.call('POST', '/networks/create', {
      body: { Name: name, Driver: 'bridge', Internal: false, Attachable: false, EnableIPv6: false, Labels: { [LABEL.stack]: this.stack, [LABEL.server]: id } },
    });
  }

  /** Joins this stack's panel container(s) to a server's network, if not already on it. */
  private async attachPanel(network: string): Promise<void> {
    const panels = await this.docker.call<DockerContainerSummary[]>('GET', '/containers/json', {
      query: { all: true, filters: labelFilter(`${COMPOSE_PROJECT}=${this.stack}`, `${COMPOSE_SERVICE}=${PANEL_SERVICE}`) },
    });
    if (panels.length === 0) throw unavailable(`No panel container in ${this.stack} to join ${network}`);
    for (const p of panels) {
      const c = await this.docker.find<DockerContainer>(`/containers/${p.Id}/json`);
      if (!c || Object.hasOwn(c.NetworkSettings.Networks ?? {}, network)) continue;
      await this.docker.call('POST', `/networks/${network}/connect`, { body: { Container: p.Id } });
    }
  }
}

/** One stats sample as the API reports it; CPU in percent of one core. */
export function statsOf(id: string, s: DockerStats): ServerStats {
  const cpuDelta = (s.cpu_stats?.cpu_usage?.total_usage ?? 0) - (s.precpu_stats?.cpu_usage?.total_usage ?? 0);
  const sysDelta = (s.cpu_stats?.system_cpu_usage ?? 0) - (s.precpu_stats?.system_cpu_usage ?? 0);
  const online = s.cpu_stats?.online_cpus || 1;
  const usage = s.memory_stats?.usage ?? 0;
  // cgroup v2 reports inactive_file, v1 total_inactive_file: page cache the kernel can drop.
  const cache = s.memory_stats?.stats?.inactive_file ?? s.memory_stats?.stats?.total_inactive_file ?? 0;
  let rx = 0;
  let tx = 0;
  for (const n of Object.values(s.networks ?? {})) {
    rx += n.rx_bytes ?? 0;
    tx += n.tx_bytes ?? 0;
  }
  return {
    id,
    at: time(s.read) ?? new Date().toISOString(),
    cpuPercent: cpuDelta > 0 && sysDelta > 0 ? round2((cpuDelta / sysDelta) * online * 100) : 0,
    memBytes: Math.max(0, usage - cache),
    memLimitBytes: s.memory_stats?.limit || null,
    netRxBytes: rx,
    netTxBytes: tx,
  };
}
