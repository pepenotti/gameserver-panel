// A recording stand-in for the Docker Engine API, for the orchestrator's
// tests (NFR-02): the endpoints the orchestrator uses, over plain HTTP on
// 127.0.0.1, with containers, networks and volumes kept in memory, and image
// names that resolve to content ids a test can change ("rebuild"). It answers
// the way Docker does where the orchestrator depends on it (404 bodies, 304
// on start/stop, "port is already allocated", endpoints already attached),
// and records every request so tests can assert exactly what was asked.
import { randomBytes } from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';

export interface Call {
  method: string;
  /** Without the API version prefix, e.g. `/containers/create`. */
  path: string;
  /** The version prefix the caller used, e.g. `v1.44`. */
  version: string;
  query: Record<string, string>;
  body: unknown;
}

export type Labels = Record<string, string>;
type Binding = { HostIp?: string; HostPort?: string };

export interface FakeContainer {
  Id: string;
  /** With the leading slash, like Docker. */
  Name: string;
  /** Content id of the image it was created from (`Config.Image` as it resolved then), like Docker's inspect. */
  Image: string;
  Config: { Image: string; Labels: Labels; Env: string[]; Cmd?: string[] | null };
  State: { Status: string; Running: boolean; StartedAt: string; FinishedAt: string; ExitCode: number };
  HostConfig: Record<string, unknown> & { PortBindings: Record<string, Binding[]>; Mounts?: { Source?: string; Target?: string; ReadOnly?: boolean }[] };
  NetworkSettings: { Networks: Record<string, { NetworkID: string }> };
  /** The `POST /containers/create` body, as received. */
  createBody?: unknown;
}

export interface FakeNetwork {
  Id: string;
  Name: string;
  Driver: string;
  Internal: boolean;
  Labels: Labels;
  Containers: Record<string, { Name: string }>;
}

export interface FakeVolume {
  Name: string;
  Driver: string;
  Labels: Labels;
  CreatedAt: string;
  /**
   * What the volume holds, by path from its root (`/`-separated), for
   * `GET /containers/{id}/archive` of a path a container mounts it at
   * (the orchestrator reads a shared install's marker that way). A test
   * fills it; nothing else is modelled.
   */
  files: Map<string, string>;
}

export interface FakeDocker {
  url: string;
  calls: Call[];
  containers: Map<string, FakeContainer>;
  networks: Map<string, FakeNetwork>;
  volumes: Map<string, FakeVolume>;
  info: { Architecture: string; NCPU: number; MemTotal: number; ServerVersion: string; OperatingSystem: string };
  /** Images that exist; null: every image does. */
  images: Set<string> | null;
  /** The content id an image name resolves to now (`sha256:…`), made up on first use. */
  imageId(name: string): string;
  /** `docker build` again under the same name: it resolves to a new id (and exists); returns it. */
  rebuildImage(name: string): string;
  /** Requests that changed something (everything but GET). */
  writes(): Call[];
  /** The next matching request fails with this status and message. */
  failNext(method: string, path: RegExp, status: number, message: string): void;
  addContainer(o: { name: string; image?: string; labels?: Labels; running?: boolean; ports?: { container: number; host: number; proto: 'tcp' | 'udp' }[]; id?: string; networks?: string[] }): FakeContainer;
  addNetwork(o: { name: string; labels?: Labels }): FakeNetwork;
  addVolume(o: { name: string; labels?: Labels; files?: Record<string, string> }): FakeVolume;
  close(): Promise<void>;
}

const NO_TIME = '0001-01-01T00:00:00Z';
const newId = () => randomBytes(32).toString('hex');
const now = () => new Date().toISOString();

class Reply {
  constructor(
    readonly status: number,
    readonly body?: unknown,
  ) {}
}
const noSuch = (what: string, name: string) => new Reply(404, { message: `No such ${what}: ${name}` });

/** Docker's `filters` query: `{"label":["k=v","k"]}` or `{"label":{"k=v":true}}`. */
function labelFilters(q: Record<string, string>): string[] {
  if (!q.filters) return [];
  const f = JSON.parse(q.filters) as { label?: string[] | Record<string, boolean> };
  if (!f.label) return [];
  return Array.isArray(f.label) ? f.label : Object.keys(f.label).filter((k) => (f.label as Record<string, boolean>)[k]);
}

/** A ustar archive of one file, as Docker's archive endpoint answers. */
function tarOf(name: string, data: Buffer): Buffer {
  const header = Buffer.alloc(512);
  const field = (off: number, len: number, value: string) => header.write(value, off, len, 'ascii');
  field(0, 100, name);
  field(100, 8, '0000644\0');
  field(108, 8, '0001750\0');
  field(116, 8, '0001750\0');
  field(124, 12, `${data.length.toString(8).padStart(11, '0')}\0`);
  field(136, 12, `${Math.floor(Date.now() / 1000).toString(8).padStart(11, '0')}\0`);
  header.fill(' ', 148, 156);
  field(156, 1, '0');
  field(257, 6, 'ustar\0');
  field(263, 2, '00');
  let sum = 0;
  for (const b of header) sum += b;
  field(148, 8, `${sum.toString(8).padStart(6, '0')}\0 `);
  const pad = Buffer.alloc((512 - (data.length % 512)) % 512);
  return Buffer.concat([header, data, pad, Buffer.alloc(1024)]);
}

function matchesLabels(labels: Labels, filters: string[]): boolean {
  return filters.every((f) => {
    const eq = f.indexOf('=');
    return eq < 0 ? f in labels : labels[f.slice(0, eq)] === f.slice(eq + 1);
  });
}

export async function startFakeDocker(): Promise<FakeDocker> {
  const calls: Call[] = [];
  const containers = new Map<string, FakeContainer>();
  const networks = new Map<string, FakeNetwork>();
  const volumes = new Map<string, FakeVolume>();
  const failures: { method: string; path: RegExp; status: number; message: string }[] = [];
  const imageIds = new Map<string, string>();
  const imageExists = (name: string) => fd.images === null || fd.images.has(name);

  const findContainer = (ref: string) => containers.get(ref) ?? [...containers.values()].find((c) => c.Name === `/${ref}` || (ref.length >= 12 && c.Id.startsWith(ref)));
  const findNetwork = (ref: string) => networks.get(ref) ?? [...networks.values()].find((n) => n.Name === ref);

  const publishedPorts = (c: FakeContainer) =>
    c.State.Running
      ? Object.entries(c.HostConfig.PortBindings ?? {}).flatMap(([key, binds]) => {
          const [priv, type = 'tcp'] = key.split('/');
          return (binds ?? []).map((b) => ({ IP: b.HostIp || '0.0.0.0', PrivatePort: Number(priv), PublicPort: Number(b.HostPort), Type: type }));
        })
      : [];

  const summary = (c: FakeContainer) => ({
    Id: c.Id,
    Names: [c.Name],
    Image: c.Config.Image,
    Labels: c.Config.Labels,
    State: c.State.Status,
    Ports: publishedPorts(c),
    // As Docker lists them: a named volume's name, where it is mounted, and whether it is writable.
    Mounts: (c.HostConfig.Mounts ?? []).map((m) => ({ Type: 'volume', Name: m.Source ?? '', Destination: m.Target ?? '', RW: m.ReadOnly !== true })),
  });

  function attach(net: FakeNetwork, c: FakeContainer): void {
    net.Containers[c.Id] = { Name: c.Name.slice(1) };
    c.NetworkSettings.Networks[net.Name] = { NetworkID: net.Id };
  }

  const fd: FakeDocker = {
    url: '',
    calls,
    containers,
    networks,
    volumes,
    info: { Architecture: 'x86_64', NCPU: 8, MemTotal: 16 * 1024 ** 3, ServerVersion: '29.0.0-fake', OperatingSystem: 'Fake Linux' },
    images: null,
    imageId(name) {
      let id = imageIds.get(name);
      if (!id) {
        id = `sha256:${newId()}`;
        imageIds.set(name, id);
      }
      return id;
    },
    rebuildImage(name) {
      imageIds.set(name, `sha256:${newId()}`);
      fd.images?.add(name);
      return fd.imageId(name);
    },
    writes: () => calls.filter((c) => c.method !== 'GET'),
    failNext(method, path, status, message) {
      failures.push({ method, path, status, message });
    },
    addContainer(o) {
      const image = o.image ?? 'alpine:3';
      const c: FakeContainer = {
        Id: o.id ?? newId(),
        Name: `/${o.name}`,
        Image: fd.imageId(image),
        Config: { Image: image, Labels: o.labels ?? {}, Env: [] },
        State: { Status: o.running ? 'running' : 'created', Running: !!o.running, StartedAt: o.running ? now() : NO_TIME, FinishedAt: NO_TIME, ExitCode: 0 },
        HostConfig: { PortBindings: Object.fromEntries((o.ports ?? []).map((p) => [`${p.container}/${p.proto}`, [{ HostIp: '0.0.0.0', HostPort: String(p.host) }]])) },
        NetworkSettings: { Networks: {} },
      };
      containers.set(c.Id, c);
      for (const n of o.networks ?? []) {
        const net = findNetwork(n) ?? fd.addNetwork({ name: n });
        attach(net, c);
      }
      return c;
    },
    addNetwork(o) {
      const n: FakeNetwork = { Id: newId(), Name: o.name, Driver: 'bridge', Internal: false, Labels: o.labels ?? {}, Containers: {} };
      networks.set(n.Id, n);
      return n;
    },
    addVolume(o) {
      const v: FakeVolume = { Name: o.name, Driver: 'local', Labels: o.labels ?? {}, CreatedAt: now(), files: new Map(Object.entries(o.files ?? {})) };
      volumes.set(v.Name, v);
      return v;
    },
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };

  function handle(method: string, path: string, q: Record<string, string>, body: unknown): Reply {
    const b = (body ?? {}) as Record<string, unknown>;
    let m: RegExpExecArray | null;
    if (method === 'GET' && path === '/_ping') return new Reply(200, 'OK');
    if (method === 'GET' && path === '/info') return new Reply(200, fd.info);

    // ---- containers
    if (method === 'GET' && path === '/containers/json') {
      const filters = labelFilters(q);
      const all = q.all === 'true' || q.all === '1';
      return new Reply(200, [...containers.values()].filter((c) => (all || c.State.Running) && matchesLabels(c.Config.Labels, filters)).map(summary));
    }
    if (method === 'POST' && path === '/containers/create') {
      const name = q.name ?? '';
      if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]+$/.test(name)) return new Reply(400, { message: `Invalid container name (${name})` });
      if (findContainer(name)) return new Reply(409, { message: `Conflict. The container name "/${name}" is already in use` });
      const image = String(b.Image ?? '');
      if (!imageExists(image)) return new Reply(404, { message: `No such image: ${image}` });
      const hc = (b.HostConfig ?? {}) as FakeContainer['HostConfig'];
      const netName = String(hc.NetworkMode ?? 'bridge');
      const net = findNetwork(netName);
      if (netName !== 'bridge' && !net) return new Reply(404, { message: `network ${netName} not found` });
      const c: FakeContainer = {
        Id: newId(),
        Name: `/${name}`,
        Image: fd.imageId(image),
        Config: { Image: image, Labels: (b.Labels as Labels) ?? {}, Env: (b.Env as string[]) ?? [], Cmd: (b.Cmd as string[] | undefined) ?? null },
        State: { Status: 'created', Running: false, StartedAt: NO_TIME, FinishedAt: NO_TIME, ExitCode: 0 },
        HostConfig: { ...hc, PortBindings: hc.PortBindings ?? {} },
        NetworkSettings: { Networks: {} },
        createBody: body,
      };
      containers.set(c.Id, c);
      if (net) attach(net, c);
      return new Reply(201, { Id: c.Id, Warnings: [] });
    }
    if (method === 'GET' && (m = /^\/containers\/([^/]+)\/archive$/.exec(path))) {
      // `docker cp` out of a container, created or running: one file of a volume it mounts, as a tar.
      const c = findContainer(decodeURIComponent(m[1] ?? ''));
      if (!c) return noSuch('container', m[1] ?? '');
      const want = q.path ?? '';
      for (const mt of c.HostConfig.Mounts ?? []) {
        const target = (mt.Target ?? '').replace(/\/$/, '');
        if (!target || !want.startsWith(`${target}/`)) continue;
        const text = volumes.get(mt.Source ?? '')?.files.get(want.slice(target.length + 1));
        if (text === undefined) break;
        return new Reply(200, tarOf(want.slice(want.lastIndexOf('/') + 1), Buffer.from(text, 'utf8')));
      }
      return new Reply(404, { message: `Could not find the file ${want} in container ${c.Name.slice(1)}` });
    }
    if ((m = /^\/containers\/([^/]+)\/(json|start|stop|restart|stats)$/.exec(path)) || (m = /^\/containers\/([^/]+)()$/.exec(path))) {
      const c = findContainer(decodeURIComponent(m[1] ?? ''));
      if (!c) return noSuch('container', m[1] ?? '');
      const action = m[2];
      if (method === 'GET' && action === 'json') return new Reply(200, c);
      if (method === 'GET' && action === 'stats') {
        return new Reply(200, {
          read: now(),
          cpu_stats: { cpu_usage: { total_usage: 3_000_000_000 }, system_cpu_usage: 20_000_000_000, online_cpus: 4 },
          precpu_stats: { cpu_usage: { total_usage: 2_000_000_000 }, system_cpu_usage: 16_000_000_000 },
          memory_stats: { usage: 600 * 1024 ** 2, limit: Number(c.HostConfig.Memory ?? 0), stats: { inactive_file: 100 * 1024 ** 2 } },
          networks: { eth0: { rx_bytes: 1000, tx_bytes: 2000 }, eth1: { rx_bytes: 10, tx_bytes: 20 } },
        });
      }
      if (method === 'POST' && action === 'start') {
        if (c.State.Running) return new Reply(304);
        for (const p of publishedPortsIfRunning(c)) {
          const other = [...containers.values()].find((o) => o !== c && publishedPorts(o).some((x) => x.PublicPort === p.PublicPort && x.Type === p.Type));
          if (other) return new Reply(500, { message: `driver failed programming external connectivity on endpoint ${c.Name.slice(1)}: Bind for ${p.IP}:${p.PublicPort} failed: port is already allocated` });
        }
        Object.assign(c.State, { Status: 'running', Running: true, StartedAt: now() });
        return new Reply(204);
      }
      if (method === 'POST' && action === 'stop') {
        if (!c.State.Running) return new Reply(304);
        Object.assign(c.State, { Status: 'exited', Running: false, FinishedAt: now(), ExitCode: 0 });
        return new Reply(204);
      }
      if (method === 'POST' && action === 'restart') {
        Object.assign(c.State, { Status: 'running', Running: true, StartedAt: now() });
        return new Reply(204);
      }
      if (method === 'DELETE' && action === '') {
        if (c.State.Running && q.force !== 'true' && q.force !== '1') return new Reply(409, { message: `cannot remove container "${c.Name}": container is running: stop the container before removing or force remove` });
        containers.delete(c.Id);
        for (const n of networks.values()) delete n.Containers[c.Id];
        return new Reply(204);
      }
    }

    // ---- images (inspect only: the orchestrator never pulls or builds)
    if (method === 'GET' && (m = /^\/images\/(.+)\/json$/.exec(path))) {
      const name = decodeURIComponent(m[1] ?? '');
      if (!imageExists(name)) return noSuch('image', name);
      return new Reply(200, { Id: fd.imageId(name), RepoTags: [name] });
    }

    // ---- networks
    if (method === 'GET' && path === '/networks') {
      const filters = labelFilters(q);
      return new Reply(200, [...networks.values()].filter((n) => matchesLabels(n.Labels, filters)).map((n) => ({ ...n, Containers: {} })));
    }
    if (method === 'POST' && path === '/networks/create') {
      const name = String(b.Name ?? '');
      if (findNetwork(name)) return new Reply(409, { message: `network with name ${name} already exists` });
      const n = fd.addNetwork({ name, labels: (b.Labels as Labels) ?? {} });
      n.Driver = String(b.Driver ?? 'bridge');
      n.Internal = b.Internal === true;
      return new Reply(201, { Id: n.Id, Warning: '' });
    }
    if ((m = /^\/networks\/([^/]+)(?:\/(connect|disconnect))?$/.exec(path))) {
      const n = findNetwork(decodeURIComponent(m[1] ?? ''));
      if (!n) return noSuch('network', m[1] ?? '');
      const action = m[2];
      if (method === 'GET' && !action) return new Reply(200, n);
      if (method === 'POST' && action) {
        const c = findContainer(String(b.Container ?? ''));
        if (!c) return noSuch('container', String(b.Container ?? ''));
        if (action === 'connect') {
          if (n.Containers[c.Id]) return new Reply(403, { message: `endpoint with name ${c.Name.slice(1)} already exists in network ${n.Name}` });
          attach(n, c);
        } else {
          delete n.Containers[c.Id];
          delete c.NetworkSettings.Networks[n.Name];
        }
        return new Reply(200);
      }
      if (method === 'DELETE' && !action) {
        if (Object.keys(n.Containers).length) return new Reply(403, { message: `error while removing network: network ${n.Name} id ${n.Id} has active endpoints` });
        networks.delete(n.Id);
        return new Reply(204);
      }
    }

    // ---- volumes
    const volumeJson = (v: FakeVolume) => ({ Name: v.Name, Driver: v.Driver, Labels: v.Labels, CreatedAt: v.CreatedAt, Mountpoint: `/var/lib/docker/volumes/${v.Name}/_data`, Scope: 'local' });
    if (method === 'GET' && path === '/volumes') {
      const filters = labelFilters(q);
      return new Reply(200, { Volumes: [...volumes.values()].filter((v) => matchesLabels(v.Labels, filters)).map(volumeJson), Warnings: null });
    }
    if (method === 'POST' && path === '/volumes/create') {
      const name = String(b.Name ?? '');
      const v = volumes.get(name) ?? fd.addVolume({ name, labels: (b.Labels as Labels) ?? {} });
      return new Reply(201, volumeJson(v));
    }
    if ((m = /^\/volumes\/([^/]+)$/.exec(path))) {
      const name = decodeURIComponent(m[1] ?? '');
      const v = volumes.get(name);
      if (!v) return noSuch('volume', name);
      if (method === 'GET') return new Reply(200, volumeJson(v));
      if (method === 'DELETE') {
        const user = [...containers.values()].find((c) => (c.HostConfig.Mounts ?? []).some((mt) => mt.Source === name));
        if (user) return new Reply(409, { message: `remove ${name}: volume is in use - [${user.Id}]` });
        volumes.delete(name);
        return new Reply(204);
      }
    }
    return new Reply(404, { message: 'page not found' });
  }

  /** The ports a container will publish once it runs. */
  function publishedPortsIfRunning(c: FakeContainer) {
    return publishedPorts({ ...c, State: { ...c.State, Running: true } });
  }

  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (d: Buffer) => chunks.push(d));
    req.on('end', () => {
      const url = new URL(req.url ?? '/', 'http://docker');
      const vm = /^\/(v\d+\.\d+)(\/.*)$/.exec(url.pathname);
      const version = vm?.[1] ?? '';
      const path = vm?.[2] ?? url.pathname;
      const query = Object.fromEntries(url.searchParams);
      const text = Buffer.concat(chunks).toString('utf8');
      let body: unknown;
      try {
        body = text ? JSON.parse(text) : undefined;
      } catch {
        body = text;
      }
      const method = req.method ?? 'GET';
      calls.push({ method, path, version, query, body });
      const fi = failures.findIndex((f) => f.method === method && f.path.test(path));
      let reply: Reply;
      if (fi >= 0) {
        const [f] = failures.splice(fi, 1);
        reply = new Reply(f!.status, { message: f!.message });
      } else {
        reply = handle(method, path, query, body);
      }
      if (reply.body === undefined) {
        res.writeHead(reply.status);
        res.end();
      } else if (Buffer.isBuffer(reply.body)) {
        res.writeHead(reply.status, { 'content-type': 'application/x-tar' });
        res.end(reply.body);
      } else if (typeof reply.body === 'string') {
        res.writeHead(reply.status, { 'content-type': 'text/plain' });
        res.end(reply.body);
      } else {
        res.writeHead(reply.status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(reply.body));
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  fd.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return fd;
}
