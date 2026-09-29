// Installs per loader against the fake download services, exactly as the
// fact-finding measured them (UPD-01, UPD-05, UPD-06), what `installed()` and
// `installOnStart()` make of them, and the version lists (UPD-02, Q11, Q13).
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { startFakeDownloads, type FakeDownloads } from '../../../tools/fake-minecraft/downloads.mjs';
import { minecraftChoices } from '../src/panel';
import { clearSourceCache, minecraftRuntimeAdapter as mc, readMarker } from '../src/runtime';
import { INSTALL_MARKER, parseMinecraftLaunch, type MinecraftVersionInfo } from '../src/shared';
import { downloadEnv, testCtx, type TestCtx } from './helpers';

let downloads: FakeDownloads;
let ctx: TestCtx | null = null;
beforeAll(async () => {
  downloads = await startFakeDownloads({ fail: '' });
});
afterAll(() => downloads.close());
beforeEach(() => clearSourceCache());
afterEach(() => {
  ctx?.cleanup();
  ctx = null;
});

const launch = (x: Record<string, unknown>) => parseMinecraftLaunch({ version: '26.3', memoryMb: 2048, ...x });
const newCtx = (url = downloads.url) => (ctx = testCtx({ env: downloadEnv(url), eulaAccepted: true }));
const inInstall = (c: TestCtx, rel: string) => path.join(c.roots.install, rel);
const objectRequests = () => downloads.requests.filter((r) => r.path.startsWith('/v1/objects/') || r.path.startsWith('/maven/')).length;

describe('install: vanilla (UPD-01)', () => {
  it("downloads Mojang's server jar, checked against its SHA-1 and size, and records the Java its version declares", async () => {
    const c = newCtx();
    const p = launch({ loader: 'vanilla' });
    expect(mc.installed(c)).toBeNull();
    expect(mc.installOnStart!(c, p)).toBe('required');
    expect(await mc.install!(c, p, { validate: false })).toEqual({ ok: true });
    expect(readFileSync(inInstall(c, 'server.jar'), 'utf8')).toBe('FAKE-MINECRAFT minecraft server 26.3\n');
    expect(readMarker(c)).toMatchObject({ loader: 'vanilla', version: '26.3', javaMajor: 25, jre: 25, jar: 'server.jar', sha1: expect.stringMatching(/^[0-9a-f]{40}$/) });
    expect(mc.installed(c)).toEqual({ version: '26.3', channel: 'vanilla' });
    expect(mc.installOnStart!(c, p)).toBeNull();
    // Nothing but the jar and the marker: the bundler unpacks at first start, into the install root.
    expect(existsSync(inInstall(c, '.gsp-staging'))).toBe(false);
    // Every request named the panel.
    expect(new Set(downloads.requests.map((r) => r.userAgent))).toEqual(new Set(['gameserver-panel/test']));
  });

  it.each([
    ['1.16.5', 8, 17],
    ['1.17.1', 16, 17],
    ['1.20.6', 21, 21],
    ['1.20.4', 17, 17],
  ])('Minecraft %s declares Java %i and runs on %i (PRD §10)', async (version, declared, jre) => {
    const c = newCtx();
    expect(await mc.install!(c, launch({ version, loader: 'vanilla' }), { validate: false })).toEqual({ ok: true });
    expect(readMarker(c)).toMatchObject({ version, javaMajor: declared, jre });
    expect(mc.command(c, launch({ version, loader: 'vanilla' })).argv).toContain(`-DbundlerRepoDir=${c.roots.install}`);
  });

  it('downloads nothing when the same thing is installed, except to validate; a new version replaces the old files', async () => {
    const c = newCtx();
    await mc.install!(c, launch({ version: '26.2', loader: 'vanilla' }), { validate: false });
    // What the bundler unpacked at a first start of 26.2.
    mkdirSync(inInstall(c, 'versions/26.2'), { recursive: true });
    writeFileSync(inInstall(c, 'versions/26.2/server-26.2.jar'), 'x');
    const before = objectRequests();
    expect(await mc.install!(c, launch({ version: '26.2', loader: 'vanilla' }), { validate: false })).toEqual({ ok: true });
    expect(objectRequests()).toBe(before);
    expect(await mc.install!(c, launch({ version: '26.2', loader: 'vanilla' }), { validate: true })).toEqual({ ok: true });
    expect(objectRequests()).toBe(before + 1);
    expect(existsSync(inInstall(c, 'versions/26.2'))).toBe(false);
    await mc.install!(c, launch({ version: '26.3', loader: 'vanilla' }), { validate: false });
    expect(readMarker(c)?.version).toBe('26.3');
  });

  it('refuses versions Mojang does not list as releases', async () => {
    const c = newCtx();
    expect(await mc.install!(c, launch({ version: '1.19.2', loader: 'vanilla' }), { validate: false })).toEqual({ ok: false, error: 'Mojang lists no Minecraft release 1.19.2' });
    expect(mc.installed(c)).toBeNull();
  });
});

describe('install: Paper, pinned to its version and channel (UPD-01, UPD-05)', () => {
  it("takes the newest STABLE build by default, checked against its SHA-256 and size, then runs Paper's patch step", async () => {
    const c = newCtx();
    const p = launch({ version: '26.2', loader: 'paper' });
    expect(p.channel).toBe('STABLE');
    expect(await mc.install!(c, p, { validate: false })).toEqual({ ok: true });
    expect(readFileSync(inInstall(c, 'paper.jar'), 'utf8')).toBe('FAKE-MINECRAFT paper 26.2 build 129\n');
    expect(readMarker(c)).toMatchObject({ loader: 'paper', version: '26.2', build: 129, channel: 'STABLE', jar: 'paper.jar', javaMajor: 25, sha256: expect.stringMatching(/^[0-9a-f]{64}$/) });
    expect(mc.installed(c)).toEqual({ version: '26.2', channel: 'paper', build: '129' });
    // The patch step fetched Mojang's jar and patched it, into the install root (the fake's own files).
    expect(existsSync(inInstall(c, 'cache'))).toBe(true);
    expect(c.lines).toEqual(expect.arrayContaining(['Applying patches']));
  });

  it('refuses a version with no STABLE build unless the admin picked a less stable channel (Q13), and keeps what was installed', async () => {
    const c = newCtx();
    await mc.install!(c, launch({ version: '26.2', loader: 'paper' }), { validate: false });
    const r = await mc.install!(c, launch({ loader: 'paper' }), { validate: false });
    expect(r).toEqual({ ok: false, error: 'Paper has no STABLE build of Minecraft 26.3 yet (the newest, 41, is ALPHA); choose the ALPHA channel to install it, or another version' });
    expect(readMarker(c)).toMatchObject({ version: '26.2', build: 129 });
    const alpha = launch({ loader: 'paper', channel: 'ALPHA' });
    expect(await mc.install!(c, alpha, { validate: false })).toEqual({ ok: true });
    expect(readMarker(c)).toMatchObject({ version: '26.3', build: 41, channel: 'ALPHA' });
    expect(mc.installOnStart!(c, alpha)).toBeNull();
    // Back to STABLE: the installed ALPHA build no longer qualifies.
    expect(mc.installOnStart!(c, launch({ loader: 'paper' }))).toBe('required');
    // ALPHA takes better builds too: 26.2's newest is STABLE.
    expect(await mc.install!(c, launch({ version: '26.2', loader: 'paper', channel: 'ALPHA' }), { validate: false })).toEqual({ ok: true });
    expect(readMarker(c)).toMatchObject({ build: 129, channel: 'STABLE' });
  });

  it('installs a pinned build only from the pinned channel or a more stable one', async () => {
    const c = newCtx();
    expect(await mc.install!(c, launch({ version: '26.2', loader: 'paper', build: 128 }), { validate: false })).toEqual({ ok: true });
    expect(readMarker(c)).toMatchObject({ build: 128 });
    const beta = await mc.install!(c, launch({ version: '26.2', loader: 'paper', build: 82 }), { validate: false });
    expect(beta.error).toBe('Paper build 82 of 26.2 is BETA, and this server takes STABLE builds only; choose the BETA channel to install it');
    expect(await mc.install!(c, launch({ version: '26.2', loader: 'paper', build: 82, channel: 'BETA' }), { validate: false })).toEqual({ ok: true });
    expect((await mc.install!(c, launch({ version: '26.2', loader: 'paper', build: 999 }), { validate: false })).error).toBe('Paper has no build 999 of Minecraft 26.2');
  });

  it('never moves to another Minecraft version on its own: a start keeps the build, an update takes the newest build of the pinned version', async () => {
    const c = newCtx();
    await mc.install!(c, launch({ version: '26.2', loader: 'paper', build: 128 }), { validate: false });
    const unpinned = launch({ version: '26.2', loader: 'paper' });
    // A start doesn't update (the panel's update policy does, UPD-03).
    expect(mc.installOnStart!(c, unpinned)).toBeNull();
    expect(await mc.install!(c, unpinned, { validate: false })).toEqual({ ok: true });
    expect(readMarker(c)).toMatchObject({ version: '26.2', build: 129 });
    // A pinned build that differs from the installed one is installed at the next start.
    expect(mc.installOnStart!(c, launch({ version: '26.2', loader: 'paper', build: 128 }))).toBe('required');
    expect(mc.installOnStart!(c, launch({ version: '26.3', loader: 'paper', channel: 'ALPHA' }))).toBe('required');
    expect(mc.installOnStart!(c, launch({ version: '26.2', loader: 'vanilla' }))).toBe('required');
  });
});

describe('install: Fabric (UPD-01, UPD-06)', () => {
  it("runs Fabric's installer, checked against its maven SHA-256, with the newest stable loader, then checks Mojang's jar it fetched", async () => {
    const c = newCtx();
    const p = launch({ loader: 'fabric' });
    expect(await mc.install!(c, p, { validate: false })).toEqual({ ok: true });
    for (const f of ['fabric-server-launch.jar', 'server.jar', 'libraries/net/fabricmc/fabric-loader/0.19.5/fabric-loader-0.19.5.jar']) expect(existsSync(inInstall(c, f)), f).toBe(true);
    expect(readMarker(c)).toMatchObject({ loader: 'fabric', version: '26.3', loaderVersion: '0.19.5', installerVersion: '1.1.2', jar: 'fabric-server-launch.jar', jre: 25 });
    expect(mc.installed(c)).toEqual({ version: '26.3', channel: 'fabric', build: '0.19.5' });
    // The installer ran as `java -jar fabric-installer-<v>.jar server …` (its lines went to the job's log).
    expect(c.lines).toEqual(expect.arrayContaining(['Installing Fabric Loader 0.19.5(26.3) on the server', 'Done, start server by running fabric-server-launch.jar']));
    // The installer itself is not kept.
    expect(existsSync(inInstall(c, '.gsp-staging'))).toBe(false);
    expect(mc.installOnStart!(c, p)).toBeNull();
    expect(mc.installOnStart!(c, launch({ loader: 'fabric', loaderVersion: '0.19.4' }))).toBe('required');
  });

  it('takes a pinned loader Fabric has for the version, and refuses others and versions Fabric lacks', async () => {
    const c = newCtx();
    expect(await mc.install!(c, launch({ loader: 'fabric', loaderVersion: '0.19.4' }), { validate: false })).toEqual({ ok: true });
    expect(readMarker(c)?.loaderVersion).toBe('0.19.4');
    expect((await mc.install!(c, launch({ loader: 'fabric', loaderVersion: '9.9.9' }), { validate: false })).error).toBe('Fabric Loader 9.9.9 is not available for Minecraft 26.3');
    expect((await mc.install!(c, launch({ version: '1.20.6', loader: 'fabric' }), { validate: false })).error).toBe('Fabric does not support Minecraft 1.20.6');
  });
});

describe('install failures leave what was installed (UPD-01)', () => {
  it.each([
    ['bad-checksum', /not what was published/],
    ['not-found', /HTTP 404/],
    ['rate-limit', /limiting requests \(HTTP 429\)/],
  ] as const)('%s', async (fail, error) => {
    const good = newCtx();
    await mc.install!(good, launch({ loader: 'vanilla' }), { validate: false });
    const before = readFileSync(inInstall(good, INSTALL_MARKER), 'utf8');
    const bad = await startFakeDownloads({ fail });
    try {
      const c = { ...good, env: { ...good.env, ...downloadEnv(bad.url) } };
      const r = await mc.install!(c, launch({ loader: 'paper', channel: 'ALPHA' }), { validate: true });
      expect(r.ok).toBe(false);
      expect(r.error).toMatch(error);
      expect(readFileSync(inInstall(good, INSTALL_MARKER), 'utf8')).toBe(before);
      expect(existsSync(inInstall(good, 'server.jar'))).toBe(true);
    } finally {
      await bad.close();
    }
  });

  it('downloads only over HTTPS, or from a service the environment points elsewhere', async () => {
    const { checkUrl } = await import('../src/runtime/sources');
    const c = newCtx();
    expect(checkUrl(c, 'https://piston-data.mojang.com/v1/objects/x/server.jar', 'x')).toMatch(/^https:/);
    expect(checkUrl(c, `${downloads.url}/v1/objects/x/server.jar`, 'x')).toMatch(/^http:/);
    expect(() => checkUrl(c, 'http://example.test/server.jar', 'the server jar')).toThrow(/isn't HTTPS/);
    const plain = testCtx();
    try {
      expect(() => checkUrl(plain, `${downloads.url}/v1/objects/x/server.jar`, 'the server jar')).toThrow(/isn't HTTPS/);
    } finally {
      plain.cleanup();
    }
  });
});

describe('versions (UPD-02, Q11, Q13)', () => {
  const ids = (r: { versions: { id: string }[] }) => r.versions.map((v) => v.id);

  it('vanilla: every release from 1.16.5 up, newest first, no snapshots', async () => {
    const c = newCtx();
    const r = await mc.versions!(c, launch({ loader: 'vanilla' }));
    expect(ids(r)).toEqual(['26.3', '26.2', '1.21.11', '1.20.6', '1.20.4', '1.17.1', '1.16.5']);
    expect(r.versions[0]).toEqual({ id: '26.3', timeUpdated: Math.floor(Date.parse('2026-09-15T11:23:02+00:00') / 1000) });
    expect(r.installed).toBeNull();
  });

  it("Paper: each version's newest build and its channel, a warning where there is no STABLE build, and the pinned version's builds", async () => {
    const c = newCtx();
    const r = await mc.versions!(c, launch({ version: '26.2', loader: 'paper' }));
    const v = r.versions as MinecraftVersionInfo[];
    expect(ids(r)).toEqual(['26.3', '26.2', '1.21.11']);
    expect(v[0]).toMatchObject({ id: '26.3', build: '41', channel: 'ALPHA', warning: 'paper-no-stable-build' });
    expect(v[0]!.builds).toBeUndefined();
    expect(v[1]).toMatchObject({ id: '26.2', build: '129', channel: 'STABLE' });
    expect(v[1]!.warning).toBeUndefined();
    expect(v[1]!.builds!.map((b) => [b.id, b.channel])).toEqual([
      [129, 'STABLE'],
      [128, 'STABLE'],
      [82, 'BETA'],
      [58, 'ALPHA'],
    ]);
    expect(v[2]).toMatchObject({ id: '1.21.11', build: '132', channel: 'STABLE' });
  });

  it('offers what the create form offers, from the same listing, asking each service once while its answer is fresh', async () => {
    for (const loader of ['vanilla', 'paper', 'fabric'] as const) {
      const c = newCtx();
      const p = launch({ loader, ...(loader === 'paper' ? { channel: 'ALPHA' } : {}) });
      const r = await mc.versions!(c, p);
      const form = await minecraftChoices({ flavour: loader, version: null }, { fetch: c.fetch!, env: c.env });
      expect(ids(r), loader).toEqual(form.version!.map((v) => v.value));
      if (loader === 'paper') expect((r.versions as MinecraftVersionInfo[]).map((v) => [v.build, v.channel])).toEqual(form.version!.map((v) => [v.detail!.slice(1), v.channel]));
      const asked = downloads.requests.length;
      expect(await mc.versions!(c, p), loader).toEqual(r);
      expect(downloads.requests.length, `${loader}: asked again`).toBe(asked);
    }
  });

  it("Fabric: each release it supports with the newest stable loader, and the pinned version's loaders", async () => {
    const c = newCtx();
    await mc.install!(c, launch({ loader: 'fabric' }), { validate: false });
    const r = await mc.versions!(c, launch({ loader: 'fabric' }));
    const v = r.versions as MinecraftVersionInfo[];
    expect(ids(r)).toEqual(['26.3', '26.2', '1.21.11']);
    expect(v[0]).toMatchObject({ id: '26.3', build: '0.19.5' });
    expect(v[0]!.loaders).toEqual([
      { version: '0.19.5', stable: true },
      { version: '0.19.4', stable: false },
    ]);
    expect(v[1]!.loaders).toBeUndefined();
    expect(r.installed).toEqual(mc.installed(c));
  });
});
