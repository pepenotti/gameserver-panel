// The host page through the API (HST-03, HST-07, SRV-05, UX-04): the
// overview of every server's state, limits, use and files against what the
// host has, with a warning when the memory limits add up to more; the
// limitations that apply to this host, each naming its docs/limitations.md
// entry; and whether players' and visitors' addresses arrive, for the notes
// where that matters (address bans).
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { panelAdapterEntries } from '@gsp/adapters/panel';
import type { HostTraits, VolumeUsage } from '@gsp/shared';
import { HOST_LIMITATIONS, hostLimitations } from '../src/host/limitations';
import type { HostOverview } from '../src/host/overview';
import { addressesOf, HostTraitsCache } from '../src/host/traits';
import { ADDRESSES_DOC, type HostTraitsView } from '../src/routes/host';
import type { ServerSummary } from '../src/routes/servers';
import { OrchestratorCallError } from '../src/servers/orchestrator';
import { Client, FakeOrchestrator, friend, makePanel, ownerReady, until, type TestPanel } from './harness';

const MIB = 1024 ** 2;
const GIB = 1024 ** 3;
const LAUNCH = { memoryMb: 2048, branch: 'public', updateOnStart: false };
const DESKTOP_WINDOWS: HostTraits = { docker: 'desktop', platform: 'windows', addressesVisible: false };
const ENGINE_LINUX: HostTraits = { docker: 'engine', platform: 'linux', addressesVisible: 'expected' };

async function created(p: TestPanel, owner: Client, id: string, launch: Record<string, unknown> = LAUNCH): Promise<ServerSummary> {
  const res = await owner.post('/api/servers', { id, name: id.toUpperCase(), adapter: 'pz', launch });
  expect(res.statusCode, res.body).toBe(200);
  return res.json() as ServerSummary;
}

const overviewOf = async (c: Client) => {
  const res = await c.get('/api/host/overview');
  expect(res.statusCode, res.body).toBe(200);
  return res.json() as HostOverview;
};

const vol = (name: string, use: VolumeUsage['use'], bytes: number | null, o: { server?: string; install?: string } = {}): VolumeUsage => ({ name, use, server: o.server ?? null, install: o.install ?? null, bytes });

describe('the host overview (HST-03, Q9)', () => {
  it('is for those who see the host: the owner and admins on every server', async () => {
    const p = await makePanel();
    const { client: owner } = await ownerReady(p);
    expect((await owner.get('/api/host/overview')).statusCode).toBe(200);
    const admin = await friend(p, owner, 'all-admin', 'admin');
    expect((await admin.get('/api/host/overview')).statusCode).toBe(200);
    const someAdmin = await friend(p, owner, 'some-admin', 'admin', 'admin');
    expect((await someAdmin.get('/api/host/overview')).json()).toEqual({ error: 'forbidden' });
    const op = await friend(p, owner, 'all-op', 'operator');
    expect((await op.get('/api/host/overview')).statusCode).toBe(403);
    expect((await new Client(p.app).get('/api/host/overview')).statusCode).toBe(401);
  });

  it("adds up every server's limits, use and files against what the host has, each part measured once", async () => {
    const p = await makePanel();
    Object.assign(p.orch, { memBytes: 64 * GIB, cpus: 12, traits: ENGINE_LINUX, maxMemMb: 16384 });
    const { client: owner } = await ownerReady(p);
    await created(p, owner, 'pz-two');
    await p.orch.stop('pz-two');
    await created(p, owner, 'pz-three');
    p.orch.stats_.set('pz-three', { memBytes: 3 * GIB, cpuPercent: 150.5 });
    p.orch.volumes = [
      vol('s-pz-two-data', 'data', 300 * MIB, { server: 'pz-two' }),
      vol('s-pz-two-install', 'install', 7 * GIB, { server: 'pz-two' }),
      vol('s-pz-two-steam', 'steam', 200 * MIB, { server: 'pz-two' }),
      vol('s-pz-three-data', 'data', 100 * MIB, { server: 'pz-three' }),
      vol('s-pz-three-install', 'install', null, { server: 'pz-three' }),
      vol('s-pz-three-steam', 'steam', 200 * MIB, { server: 'pz-three' }),
      vol('s_panel-data', 'stack', 2 * MIB),
    ];
    const o = await overviewOf(owner);
    expect(o.host).toEqual({ arch: 'amd64', cpus: 12, memBytes: 64 * GIB, dockerVersion: 'fake', os: 'fake', docker: 'engine', platform: 'linux', maxMemMb: 16384 });
    expect(o.servers.map((s) => [s.id, s.container, s.memLimitMb, s.memBytes, s.cpuPercent, s.dataBytes, s.installBytes])).toEqual([
      // The stack's own server: no container of the orchestrator's, nothing measured.
      ['default', null, 8192 + 3072, null, null, null, null],
      ['pz-two', 'exited', 5120, null, null, 500 * MIB, 7 * GIB],
      ['pz-three', 'running', 5120, 3 * GIB, 150.5, 300 * MIB, null],
    ]);
    expect(o.servers[1]).toMatchObject({ adapter: 'pz', adapterName: { en: 'Project Zomboid' }, flavour: null, cpus: null, install: { mode: 'own' }, backups: { count: 0, bytes: 0 } });
    expect(o.totals.memory).toEqual({ limitsMb: 8192 + 3072 + 5120 * 2, runningLimitsMb: 5120, usedBytes: 3 * GIB, hostBytes: 64 * GIB });
    expect(o.totals.cpu).toEqual({ percent: 150.5, hostCpus: 12, limitsCpus: 0, unlimited: 3 });
    // A volume Docker couldn't size leaves its part unknown, not smaller.
    expect(o.totals.disk).toMatchObject({ serversBytes: 800 * MIB, installsBytes: null, panelBytes: 2 * MIB, totalBytes: null });
    expect(o.warnings).toEqual([]);
    expect(o.measured.usage).toMatch(/^\d{4}-/);
    expect(o.measured.disk).toMatch(/^\d{4}-/);
    expect(p.orch.calls.filter((c) => c === 'usage')).toHaveLength(1);
  });

  it('counts a shared install once, at the size Docker measured, else as its job counted it (HST-09)', async () => {
    const p = await makePanel();
    p.orch.sharedInstalls = true;
    const { client: owner } = await ownerReady(p);
    const a = await created(p, owner, 'pz-a');
    const iid = a.install!.id!;
    await until(() => p.orch.containers.get('pz-a')?.spec.install === iid);
    await created(p, owner, 'pz-b');
    await until(() => p.orch.containers.get('pz-b')?.spec.install === iid);
    p.orch.volumes = [vol(`s-inst-${iid}`, 'shared-install', 5 * GIB, { install: iid }), vol('s-pz-a-data', 'data', MIB, { server: 'pz-a' }), vol('s-pz-b-data', 'data', MIB, { server: 'pz-b' })];
    const o = await overviewOf(owner);
    const rows = o.servers.filter((s) => s.id !== 'default');
    expect(rows.map((s) => [s.id, s.install?.mode, s.install?.id, s.install?.sharedWith, s.installBytes])).toEqual([
      ['pz-a', 'shared', iid, 1, 5 * GIB],
      ['pz-b', 'shared', iid, 1, 5 * GIB],
    ]);
    expect(o.totals.disk).toMatchObject({ serversBytes: 2 * MIB, installsBytes: 5 * GIB });
    // Not measured by Docker: the size its install job counted.
    const q = await makePanel({}, { orch: Object.assign(new FakeOrchestrator(), { sharedInstalls: true, volumes: null }) });
    const { client: owner2 } = await ownerReady(q);
    const c = await created(q, owner2, 'pz-c');
    await until(() => q.orch.containers.get('pz-c')?.spec.install === c.install!.id);
    const o2 = await overviewOf(owner2);
    expect(o2.servers.find((s) => s.id === 'pz-c')).toMatchObject({ installBytes: 1_000_000, dataBytes: null });
    expect(o2.totals.disk).toMatchObject({ serversBytes: null, installsBytes: null, panelBytes: null, totalBytes: null });
    expect(o2.measured.disk).toBeNull();
  });

  it('warns when the memory limits add up to more than Docker has, louder when the running servers already do (SRV-05)', async () => {
    const p = await makePanel();
    // default (11 GiB) and two servers of 5 GiB: 21 GiB of limits, 10 GiB of them running.
    p.orch.memBytes = 16 * GIB;
    const { client: owner } = await ownerReady(p);
    await created(p, owner, 'pz-two');
    await created(p, owner, 'pz-three');
    const over = await overviewOf(owner);
    expect(over.warnings).toEqual([{ code: 'memory-over', limitsMb: 8192 + 3072 + 10240, hostMb: 16384 }]);
    const q = await makePanel({}, { orch: Object.assign(new FakeOrchestrator(), { memBytes: 8 * GIB }) });
    const { client: owner2 } = await ownerReady(q);
    await created(q, owner2, 'pz-two');
    await created(q, owner2, 'pz-three');
    expect((await overviewOf(owner2)).warnings).toEqual([{ code: 'memory-over-running', limitsMb: 10240, hostMb: 8192 }]);
    // Within what Docker has: no warning.
    const r = await makePanel();
    const { client: owner3 } = await ownerReady(r);
    await created(r, owner3, 'pz-two');
    expect((await overviewOf(owner3)).warnings).toEqual([]);
  });

  it("counts the backups folder and each server's backups, and the disk the folder is on", async () => {
    const p = await makePanel();
    const { client: owner } = await ownerReady(p);
    await created(p, owner, 'pz-two');
    const dir = path.join(p.deps.env.backupDir, 'pz-two');
    mkdirSync(dir, { recursive: true });
    const name = 'pz-pz-two-20261005T100000Z-manual.tar.zst';
    writeFileSync(path.join(dir, name), Buffer.alloc(4000));
    writeFileSync(path.join(dir, `${name}.json`), JSON.stringify({ size: 4000, sha256: 'x', pinned: false, manifest: { createdAt: '2026-10-05T10:00:00.000Z' } }));
    mkdirSync(path.join(p.deps.env.backupDir, 'panel'), { recursive: true });
    writeFileSync(path.join(p.deps.env.backupDir, 'panel', 'panel-20261005T100000Z.sqlite'), Buffer.alloc(1000));
    const o = await overviewOf(owner);
    expect(o.servers.find((s) => s.id === 'pz-two')!.backups).toEqual({ count: 1, bytes: 4000 });
    const sidecar = readFileSync(path.join(dir, `${name}.json`)).length;
    expect(o.totals.disk.backupsBytes).toBe(4000 + sidecar + 1000);
    expect(o.totals.backupsDisk).toMatchObject({ freeBytes: expect.any(Number) as unknown, sizeBytes: expect.any(Number) as unknown });
    expect(o.measured.backups).toMatch(/^\d{4}-/);
  });

  it('keeps an overview a few seconds and builds it once at a time, so a refreshing page never hammers Docker', async () => {
    const p = await makePanel();
    const { client: owner } = await ownerReady(p);
    const [a, b] = await Promise.all([overviewOf(owner), overviewOf(owner)]);
    expect(b.at).toBe(a.at);
    expect((await overviewOf(owner)).at).toBe(a.at);
    expect(p.orch.calls.filter((c) => c === 'usage')).toHaveLength(1);
    expect(p.orch.calls.filter((c) => c === 'host')).toHaveLength(1);
  });

  it("still lists every server when the orchestrator can't be asked, or is older than host usage", async () => {
    const old = await makePanel({}, { orch: Object.assign(new FakeOrchestrator(), { hasUsage: false, traits: undefined }) });
    const { client: owner } = await ownerReady(old);
    const o = await overviewOf(owner);
    expect(o).toMatchObject({ host: { arch: 'amd64', docker: null, platform: null }, addresses: 'unknown', measured: { usage: null, disk: null } });
    expect(o.servers.map((s) => s.id)).toEqual(['default']);
    expect(o.totals.memory).toMatchObject({ usedBytes: null, hostBytes: 64 * GIB });
    const down = await makePanel();
    down.orch.down = new OrchestratorCallError(503, 'unreachable', 'Orchestrator unreachable');
    const { client: owner2 } = await ownerReady(down);
    const d = await overviewOf(owner2);
    expect(d).toMatchObject({ host: null, addresses: 'unknown', warnings: [], measured: { usage: null, disk: null } });
    expect(d.totals.memory).toMatchObject({ limitsMb: 8192 + 3072, hostBytes: null });
    expect(d.limitations.map((l) => l.id)).toEqual(['addresses-unknown']);
  });
});

/** GitHub's anchor of a heading: lower case, punctuation dropped, spaces as dashes. */
const anchorOf = (heading: string) =>
  heading
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s_-]/gu, '')
    .replace(/\s/g, '-');

const docAnchors = (): Set<string> => {
  const text = readFileSync(path.resolve(import.meta.dirname, '..', '..', '..', 'docs', 'limitations.md'), 'utf8');
  return new Set([...text.matchAll(/^#{1,6} (.+)$/gm)].map((m) => anchorOf(m[1]!)));
};

describe("this host's limitations (HST-07, UX-04)", () => {
  const ids = (traits: HostTraits | null, arch: 'amd64' | 'arm64' = 'amd64', trustworthy = false) => hostLimitations({ arch, traits, addresses: addressesOf(traits, trustworthy) }).map((l) => l.id);

  it("Docker Desktop on Windows: hidden addresses first, with Docker's memory, then what else applies", () => {
    expect(ids(DESKTOP_WINDOWS)).toEqual(['hidden-addresses', 'desktop-memory', 'hidden-visitors', 'desktop-disk', 'desktop-ports', 'windows-ports']);
    // Measured beats the owner's word: still hidden.
    expect(ids(DESKTOP_WINDOWS, 'amd64', true)).toContain('hidden-addresses');
  });

  it('Docker Engine on Linux, inside WSL, an ARM Mac, and a host the orchestrator says nothing about', () => {
    expect(ids(ENGINE_LINUX)).toEqual(['addresses-expected']);
    // The owner checked and says so.
    expect(ids(ENGINE_LINUX, 'amd64', true)).toEqual([]);
    expect(ids({ docker: 'engine', platform: 'windows', addressesVisible: 'expected' })).toEqual(['addresses-expected', 'wsl-mirrored', 'windows-ports']);
    expect(ids({ docker: 'desktop', platform: 'macos', addressesVisible: false }, 'arm64')).toEqual(['hidden-addresses', 'desktop-memory', 'hidden-visitors', 'desktop-disk', 'desktop-ports', 'arm-games', 'macos-untested']);
    expect(ids(null, 'arm64')).toEqual(['addresses-unknown', 'arm-games']);
  });

  it('gives each a stable id, a title and a line in both languages, and an entry docs/limitations.md has', () => {
    const anchors = docAnchors();
    expect(new Set(HOST_LIMITATIONS.map((l) => l.id)).size).toBe(HOST_LIMITATIONS.length);
    for (const l of HOST_LIMITATIONS) {
      expect(l.id).toMatch(/^[a-z][a-z0-9-]+$/);
      for (const t of [l.title, l.text]) expect(t.en.trim() && t.es.trim() && t.en !== t.es, `${l.id} in both languages`).toBeTruthy();
      expect(anchors.has(l.doc.replace(/^limitations\.md#/, '')), `${l.id}: ${l.doc}`).toBe(true);
    }
    expect(anchors.has(ADDRESSES_DOC.replace(/^limitations\.md#/, ''))).toBe(true);
  });

  it("names entries docs/limitations.md has from every game's notes and per-address settings too (UX-04)", () => {
    const anchors = docAnchors();
    const missing: string[] = [];
    for (const { adapter } of panelAdapterEntries) {
      const docs = [...(adapter.meta.notes ?? []), ...(adapter.meta.perAddress ?? [])].flatMap((n) => (n.doc ? [`${adapter.meta.id} ${n.id}: ${n.doc}`] : []));
      for (const d of docs) if (!anchors.has(d.slice(d.indexOf('#') + 1))) missing.push(d);
    }
    expect(missing).toEqual([]);
  });

  it('come with the overview, as the API gives them', async () => {
    const p = await makePanel();
    p.orch.traits = DESKTOP_WINDOWS;
    const { client: owner } = await ownerReady(p);
    const o = await overviewOf(owner);
    expect(o.addresses).toBe('hidden');
    expect(o.limitations[0]).toEqual({
      id: 'hidden-addresses',
      level: 'warning',
      status: 'measured',
      title: { en: expect.any(String) as unknown, es: expect.any(String) as unknown },
      text: { en: expect.stringContaining('Docker Desktop') as unknown, es: expect.stringContaining('Docker Desktop') as unknown },
      doc: 'limitations.md#players-addresses-are-hidden-behind-docker-desktop',
    });
  });
});

describe("whether players' and visitors' addresses arrive (HST-07)", () => {
  it('measured beats the owner’s word; the owner’s word beats an expectation; nothing said is unknown', () => {
    expect(addressesOf(DESKTOP_WINDOWS, false)).toBe('hidden');
    expect(addressesOf(DESKTOP_WINDOWS, true)).toBe('hidden');
    expect(addressesOf(ENGINE_LINUX, false)).toBe('expected');
    expect(addressesOf(ENGINE_LINUX, true)).toBe('visible');
    expect(addressesOf({ ...ENGINE_LINUX, addressesVisible: true }, false)).toBe('visible');
    expect(addressesOf(undefined, false)).toBe('unknown');
    expect(addressesOf(null, true)).toBe('visible');
  });

  it('tells everyone with a role on some server, and nothing more of the host', async () => {
    const p = await makePanel();
    p.orch.traits = DESKTOP_WINDOWS;
    const { client: owner } = await ownerReady(p);
    const viewer = await friend(p, owner, 'viewer', 'viewer', 'viewer');
    for (const c of [owner, viewer]) expect((await c.get('/api/host/traits')).json()).toEqual({ addresses: 'hidden', doc: ADDRESSES_DOC } satisfies HostTraitsView);
    // Someone with no server sees no server's notes either.
    const nobody = await friend(p, owner, 'nobody', 'viewer', null);
    expect((await nobody.get('/api/host/traits')).statusCode).toBe(403);
    expect((await new Client(p.app).get('/api/host/traits')).statusCode).toBe(401);
  });

  it('asks the orchestrator at most once a minute, and never makes a page wait for a slow one', async () => {
    let now = 0;
    let calls = 0;
    let answer: Promise<never> | null = null;
    const host = async () => {
      calls++;
      if (answer) return answer;
      return { arch: 'amd64' as const, cpus: 1, memBytes: 1, dockerVersion: 'x', os: 'x', traits: DESKTOP_WINDOWS };
    };
    const cache = new HostTraitsCache({ orchestrator: { host }, clientIpTrustworthy: false, now: () => now, waitMs: 20 });
    expect(await cache.addresses()).toBe('hidden');
    now += 59_000;
    expect(await cache.addresses()).toBe('hidden');
    expect(calls).toBe(1);
    // Once it is old and the orchestrator hangs: what was known, without waiting for it.
    now += 2_000;
    answer = new Promise<never>(() => undefined);
    expect(await cache.addresses()).toBe('hidden');
    expect(calls).toBe(2);
    // A failure is kept a little while, then asked again.
    const failing = new HostTraitsCache({ orchestrator: { host: () => Promise.reject(new Error('down')) }, clientIpTrustworthy: false, now: () => now });
    expect(await failing.addresses()).toBe('unknown');
  });

  it('decides the address-ban notes: an address ban names everyone behind Docker Desktop, one player on Docker Engine', async () => {
    const seen: Record<string, unknown>[] = [];
    for (const [traits, trustworthy] of [
      [DESKTOP_WINDOWS, false],
      [DESKTOP_WINDOWS, true],
      [ENGINE_LINUX, false],
      [undefined, false],
      [undefined, true],
    ] as const) {
      const p = await makePanel({ clientIpTrustworthy: trustworthy }, { orch: Object.assign(new FakeOrchestrator(), { traits }) });
      const { client: owner } = await ownerReady(p);
      const r = (await owner.get('/api/servers/default/players')).json() as { addresses: string; ipBansTrustworthy: boolean };
      seen.push({ addresses: r.addresses, ipBansTrustworthy: r.ipBansTrustworthy });
    }
    expect(seen).toEqual([
      { addresses: 'hidden', ipBansTrustworthy: false },
      { addresses: 'hidden', ipBansTrustworthy: false },
      { addresses: 'expected', ipBansTrustworthy: true },
      { addresses: 'unknown', ipBansTrustworthy: false },
      { addresses: 'visible', ipBansTrustworthy: true },
    ]);
  });
});
