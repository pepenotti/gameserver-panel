// Every game's install, as an install job leaves it, runs read-only through
// the agent (HST-09, D12, NFR-07): for each adapter and flavour, an install
// job installs (and warms up and links its redirects), then a server on that
// install boots, saves, takes a running backup, stops, starts and stops
// again, and the install is unchanged, file by file. The fakes treat an
// install with the shared-install marker as read-only, and write into it
// where the real games were measured to (docs/verification/shared-installs.md):
// without Minecraft's warm-up or tModLoader's redirect the start fails.
import { createHash } from 'node:crypto';
import { lstatSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { RuntimeAdapter } from '@gsp/adapter-api';
import { runtimeAdapter } from '@gsp/adapters/runtime';
import { SHARED_INSTALL_MARKER } from '@gsp/shared';
import { startFakeDownloads as startMinecraft, type FakeDownloads as McDownloads } from '../../../tools/fake-minecraft/downloads.mjs';
import { startFakeDownloads as startTerraria, type FakeDownloads as TrDownloads } from '../../../tools/fake-terraria/downloads.mjs';
import type { AgentConfig } from '../src/config';
import { fakeSteamcmd, freePort, makeHarness, TIME_SCALE, tools, type Harness } from './helpers';

const fake = (game: string, kind: 'server' | 'steamcmd' = 'server') => [process.execPath, path.join(tools, '..', `fake-${game}`, `${kind}.mjs`)];

/** What the fakes need in the agent's environment (the adapters and games read the agent's). */
const ENV: Record<string, string> = { FAKE_MC_BOOT_MS: '50', FAKE_TERRARIA_BOOT_MS: '50', FAKE_AVORION_BOOT_MS: '50', FAKE_VALHEIM_BOOT_MS: '50', FAKE_VALHEIM_GEN_MS: '20', FAKE_VALHEIM_STOP_MS: '20' };
let mc: McDownloads;
let tr: TrDownloads;
beforeAll(async () => {
  mc = await startMinecraft({ fail: '' });
  tr = await startTerraria({ fail: '' });
  Object.assign(ENV, { GAME_MC_MOJANG_URL: mc.url, GAME_MC_PAPER_URL: mc.url, GAME_MC_FABRIC_URL: mc.url, GAME_TERRARIA_ORG_URL: tr.url, GAME_TERRARIA_GITHUB_URL: tr.url });
  Object.assign(process.env, ENV);
});
afterAll(async () => {
  for (const k of Object.keys(ENV)) delete process.env[k];
  await mc.close();
  await tr.close();
});

const harnesses: Harness[] = [];
const dirs: string[] = [];
afterEach(async () => {
  for (const h of harnesses.splice(0).reverse()) await h.cleanup();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

/** Every entry of a tree: a file's SHA-256, a link's target, a folder. */
function tree(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (d: string, rel: string) => {
    for (const name of readdirSync(d).sort()) {
      const p = path.join(d, name);
      const r = rel ? `${rel}/${name}` : name;
      const st = lstatSync(p);
      if (st.isSymbolicLink()) out[r] = `link:${readlinkSync(p)}`;
      else if (st.isDirectory()) {
        out[r] = 'dir';
        walk(p, r);
      } else out[r] = createHash('sha256').update(readFileSync(p)).digest('hex');
    }
  };
  walk(dir, '');
  return out;
}

interface Game {
  name: string;
  adapter: string;
  flavour: string | null;
  launcher: string[];
  steamcmd?: string[];
  params: Record<string, unknown>;
  eula?: boolean;
  /** Leave out the declared redirects, or the warm-up: the start must fail as measured. */
  without?: 'redirects' | 'warmUp';
}

const GAMES: Game[] = [
  { name: 'Minecraft vanilla', adapter: 'minecraft', flavour: 'vanilla', launcher: fake('minecraft'), params: { version: '26.3', loader: 'vanilla', memoryMb: 1024 }, eula: true },
  { name: 'Minecraft Paper', adapter: 'minecraft', flavour: 'paper', launcher: fake('minecraft'), params: { version: '26.2', loader: 'paper', memoryMb: 1024 }, eula: true },
  { name: 'Minecraft Fabric', adapter: 'minecraft', flavour: 'fabric', launcher: fake('minecraft'), params: { version: '26.3', loader: 'fabric', memoryMb: 1024 }, eula: true },
  { name: 'Terraria vanilla', adapter: 'terraria', flavour: 'vanilla', launcher: fake('terraria'), params: { flavour: 'vanilla', world: 'world', worldSize: 1, maxPlayers: 8, memoryMb: 2048 } },
  { name: 'Terraria TShock', adapter: 'terraria', flavour: 'tshock', launcher: fake('terraria'), params: { flavour: 'tshock', world: 'world', worldSize: 1, maxPlayers: 8, memoryMb: 2048 } },
  { name: 'Terraria tModLoader', adapter: 'terraria', flavour: 'tmodloader', launcher: fake('terraria'), steamcmd: fakeSteamcmd, params: { flavour: 'tmodloader', world: 'world', worldSize: 1, maxPlayers: 8, memoryMb: 2048 } },
  {
    name: 'Avorion (a manifest)',
    adapter: 'avorion',
    flavour: null,
    launcher: fake('avorion'),
    steamcmd: fake('avorion', 'steamcmd'),
    params: { name: 'gal', branch: 'public', updateOnStart: false, memoryMb: 2048, serverName: 'Gal test', maxPlayers: 8, listed: false, saveInterval: 300 },
  },
  // Valheim stops on SIGINT, which Windows can't deliver to a child that handles it (runtime-contract.test.ts): Linux only.
  ...(process.platform === 'win32'
    ? []
    : [
        {
          name: 'Valheim (a manifest plus hooks)',
          adapter: 'valheim',
          flavour: null,
          launcher: fake('valheim'),
          steamcmd: fake('valheim', 'steamcmd'),
          params: { name: 'vh', branch: 'public', updateOnStart: false, memoryMb: 3072, serverName: 'Shared test', password: 'secret12', public: false, crossplay: false, saveInterval: 60 },
        },
      ]),
];

/** Free ports for every port the adapter declares (one following another gets its number plus the offset). */
async function portsFor(a: RuntimeAdapter): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  for (const d of a.meta.ports) out[d.id] = d.follows ? out[d.follows.id]! + d.follows.offset : await freePort();
  return out;
}

const strip = (g: Game) => (a: RuntimeAdapter): RuntimeAdapter => {
  if (g.without === 'warmUp') return { ...a, warmUp: undefined };
  if (g.without !== 'redirects') return a;
  const flavours = a.meta.flavours.map((f) => (f.install ? { ...f, install: { mode: f.install.mode } } : f));
  return { ...a, meta: { ...a.meta, flavours, ...(a.meta.install ? { install: { mode: a.meta.install.mode } } : {}) } };
};

async function harnessFor(g: Game, over: Partial<AgentConfig>): Promise<Harness> {
  const a = runtimeAdapter(g.adapter);
  const h = await makeHarness(
    { adapter: g.adapter, flavour: g.flavour, launcher: g.launcher, steamcmd: g.steamcmd ?? fakeSteamcmd, ports: await portsFor(a), readyTimeoutMs: 20_000 * TIME_SCALE, stopTimeoutMs: 10_000 * TIME_SCALE, ...over },
    { adapter: strip(g) },
  );
  harnesses.push(h);
  return h;
}

const envelope = (g: Game) => ({ adapter: g.adapter, params: g.params, ...(g.eula ? { eulaAccepted: true } : {}) });

/** An install job's install of `g`, done, with `data` standing for `/data` in its container. */
async function installJob(g: Game, data: string): Promise<Harness> {
  const job = await harnessFor(g, { mode: 'install-job', dataDir: data });
  job.agent.setLaunch(envelope(g));
  expect(await job.agent.install({ validate: false }, undefined)).toEqual({ ok: true });
  expect(job.agent.status().install?.marker).toMatchObject({ adapter: g.adapter, flavour: g.flavour });
  return job;
}

/** A folder standing for `/data`: the same path in the job's container and the server's (one host here). */
function dataFolder(): string {
  const d = mkdtempSync(path.join(os.tmpdir(), 'gsp-shared-data-'));
  dirs.push(d);
  return d;
}

/** A running backup of the server's whole data root, read to its end. */
async function hotBackup(h: Harness): Promise<number> {
  const rels = (await h.agent.files.list('data', '')).map((e) => e.name);
  let bytes = 0;
  for await (const chunk of await h.agent.pack({ root: 'data', rels })) bytes += chunk.length;
  return bytes;
}

describe('every game runs from the install an install job made, read-only (HST-09, D12, NFR-07)', () => {
  for (const g of GAMES) {
    it(`${g.name}: boots, saves, is backed up running, stops, starts again; the install unchanged`, { timeout: 120_000 * TIME_SCALE }, async () => {
      const data = dataFolder();
      const job = await installJob(g, data);
      const install = job.cfg.installDir!;
      const before = tree(install);
      // A fresh server's data: whatever the job made in its own data is gone.
      for (const name of readdirSync(data)) rmSync(path.join(data, name), { recursive: true, force: true });
      const srv = await harnessFor(g, { installShared: true, installDir: install, dataDir: data });
      await srv.agent.start(envelope(g), undefined);
      await srv.waitFor((s) => s.state === 'running', 30_000 * TIME_SCALE);
      if (srv.adapter.save) expect(await srv.agent.save(10_000 * TIME_SCALE)).toEqual({ ok: true });
      if (srv.adapter.hotCopy) expect(await hotBackup(srv)).toBeGreaterThan(0);
      await srv.agent.stop({}, undefined);
      await srv.waitFor((s) => s.state === 'stopped');
      await srv.agent.start(undefined, undefined);
      await srv.waitFor((s) => s.state === 'running', 30_000 * TIME_SCALE);
      await srv.agent.stop({}, undefined);
      await srv.waitFor((s) => s.state === 'stopped');
      expect(srv.agent.status().lastExit).toMatchObject({ expected: true });
      expect(tree(install)).toEqual(before);
      expect(before[SHARED_INSTALL_MARKER]).toBeDefined();
    });
  }

  for (const g of [
    { ...GAMES[0]!, name: 'Minecraft vanilla without its warm-up', without: 'warmUp' as const },
    { ...GAMES[2]!, name: 'Minecraft Fabric without its warm-up', without: 'warmUp' as const },
    { ...GAMES[5]!, name: 'tModLoader without its log redirect', without: 'redirects' as const },
  ]) {
    it(`${g.name}: never starts, as measured, and the install stays as it was`, { timeout: 120_000 * TIME_SCALE }, async () => {
      const data = dataFolder();
      const job = await installJob(g, data);
      const install = job.cfg.installDir!;
      const before = tree(install);
      const srv = await harnessFor(g, { installShared: true, installDir: install, dataDir: data });
      await srv.agent.start(envelope(g), undefined);
      const s = await srv.waitFor((x) => x.state === 'failed', 60_000 * TIME_SCALE);
      expect(s.failure).toMatch(/^Crashed 3 times/);
      expect(srv.logs().some((l) => /Failed to extract server libraries|Failed to init logging/.test(l))).toBe(true);
      expect(tree(install)).toEqual(before);
    });
  }
});
