// Installs per flavour against the fake download services, exactly as the
// fact-finding measured them (UPD-01), what `installed()` and
// `installOnStart()` make of them, the version lists (UPD-02), and GitHub's
// anonymous limit (60 calls an hour, 304s included).
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { DownloadRequest } from '@gsp/adapter-api';
import { startFakeDownloads, type FakeDownloads } from '../../../tools/fake-terraria/downloads.mjs';
import { clearSourceCache, readMarker, terrariaRuntimeAdapter as tr } from '../src/runtime';
import { parseTerrariaLaunch, VANILLA_PINS, type TerrariaVersionInfo } from '../src/shared';
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

const posix = process.platform !== 'win32';
const launch = (x: Record<string, unknown>) => parseTerrariaLaunch({ world: 'w', worldSize: 1, maxPlayers: 8, memoryMb: 2048, ...x });
const newCtx = (url = downloads.url) => (ctx = testCtx({ env: downloadEnv(url) }));
const inInstall = (c: TestCtx, ...rel: string[]) => path.join(c.roots.install, ...rel);
const githubCalls = () => downloads.requests.filter((r) => r.path.startsWith('/repos/')).length;

describe('install: vanilla (UPD-01)', () => {
  it("unpacks only the Linux server from terraria.org's zip and makes its binary executable (the zip stores no modes)", async () => {
    const c = newCtx();
    const p = launch({ flavour: 'vanilla', version: '1.4.5.8' });
    expect(tr.installed(c)).toBeNull();
    expect(tr.installOnStart!(c, p)).toBe('required');
    expect(await tr.install!(c, p, { validate: false })).toEqual({ ok: true });
    expect(readdirSync(c.roots.install).sort()).toEqual(['.gsp-install.json', 'vanilla-1458']);
    expect(readdirSync(inInstall(c, 'vanilla-1458')).sort()).toEqual(['TerrariaServer', 'TerrariaServer.bin.x86_64', 'TerrariaServer.exe', 'changelog.txt', 'lib64', 'monoconfig']);
    if (posix) expect(statSync(inInstall(c, 'vanilla-1458', 'TerrariaServer.bin.x86_64')).mode & 0o777).toBe(0o755);
    expect(readMarker(c)).toMatchObject({ flavour: 'vanilla', version: '1.4.5.8', terraria: '1.4.5.8', folder: 'vanilla-1458', sha256: expect.stringMatching(/^[0-9a-f]{64}$/), verified: false });
    expect(tr.installed(c)).toEqual({ version: '1.4.5.8', channel: 'vanilla' });
    expect(tr.installOnStart!(c, p)).toBeNull();
    // Another pinned version is another install; a newer one isn't taken on its own.
    expect(tr.installOnStart!(c, launch({ flavour: 'vanilla', version: '1.4.5.7' }))).toBe('required');
    expect(tr.installOnStart!(c, launch({ flavour: 'vanilla' }))).toBeNull();
    expect(tr.installOnStart!(c, launch({ flavour: 'tshock' }))).toBe('required');
    // Every request named the panel.
    expect(new Set(downloads.requests.map((r) => r.userAgent))).toEqual(new Set(['gameserver-panel/test']));
  });

  it("checks terraria.org's own zips against the size and SHA-256 measured for each version, which it doesn't publish", async () => {
    const c = newCtx();
    // terraria.org itself, as a real server's agent has it.
    c.env = { ...c.env, GAME_TERRARIA_ORG_URL: undefined, GAME_TERRARIA_GITHUB_URL: undefined };
    const asked: DownloadRequest[] = [];
    c.download = async (req) => {
      asked.push(req);
      throw new Error('offline');
    };
    expect(await tr.install!(c, launch({ flavour: 'vanilla', version: '1.4.5.8' }), { validate: false })).toEqual({ ok: false, error: 'offline' });
    expect(asked[0]).toMatchObject({ url: 'https://terraria.org/api/download/pc-dedicated-server/terraria-server-1458.zip', size: 46_415_317, sha256: 'f513a4ac9789d34af766291ae217c9cd7d9472e13782a0e2b17512f70d7a8334' });
    // Every version measured to download has its own.
    expect(Object.keys(VANILLA_PINS).sort()).toEqual(['1412', '1423', '1435', '1436', '1441', '1443', '1444', '1445', '1447', '1448', '1449', '1450', '1451', '1452', '1453', '1454', '1455', '1456', '1457', '1458']);
    for (const pin of Object.values(VANILLA_PINS)) expect(pin.sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it('takes the newest when none is pinned, downloads nothing for what is installed, and replaces the old install with a new one', async () => {
    const c = newCtx();
    expect(await tr.install!(c, launch({ flavour: 'vanilla' }), { validate: false })).toEqual({ ok: true });
    expect(readMarker(c)).toMatchObject({ version: '1.4.5.8' });
    const zips = () => downloads.requests.filter((r) => r.path.endsWith('.zip')).length;
    const before = zips();
    expect(await tr.install!(c, launch({ flavour: 'vanilla', version: '1.4.5.8' }), { validate: false })).toEqual({ ok: true });
    expect(zips()).toBe(before);
    expect(await tr.install!(c, launch({ flavour: 'vanilla', version: '1.4.5.8' }), { validate: true })).toEqual({ ok: true });
    expect(zips()).toBe(before + 1);
    expect(await tr.install!(c, launch({ flavour: 'vanilla', version: '1.4.4.9' }), { validate: false })).toEqual({ ok: true });
    expect(readdirSync(c.roots.install).sort()).toEqual(['.gsp-install.json', 'vanilla-1449']);
  });
});

describe('install: TShock and tModLoader from GitHub (UPD-01)', () => {
  it("TShock: the Linux x86-64 build, checked against GitHub's digest; the tar inside keeps the exec bits", async () => {
    const c = newCtx();
    const p = launch({ flavour: 'tshock' });
    expect(await tr.install!(c, p, { validate: false })).toEqual({ ok: true });
    expect(readdirSync(c.roots.install).sort()).toEqual(['.gsp-install.json', 'tshock-v6.2.1']);
    expect(readdirSync(inInstall(c, 'tshock-v6.2.1')).sort()).toEqual(['GeoIP.dat', 'ServerPlugins', 'TShock.Installer', 'TShock.Server', 'bin', 'i18n']);
    if (posix) expect(statSync(inInstall(c, 'tshock-v6.2.1', 'TShock.Server')).mode & 0o777).toBe(0o755);
    expect(readFileSync(inInstall(c, 'tshock-v6.2.1', 'TShock.Server'), 'utf8')).toContain('TShock.Server 6.2.1 x64');
    expect(readMarker(c)).toMatchObject({ flavour: 'tshock', version: 'v6.2.1', terraria: '1.4.5.8', channel: 'stable', verified: true });
    expect(tr.installed(c)).toEqual({ version: '1.4.5.8', channel: 'tshock', build: 'v6.2.1' });
    // 5.x named its build amd64.
    expect(await tr.install!(c, launch({ flavour: 'tshock', version: 'v5.2.4' }), { validate: false })).toEqual({ ok: true });
    expect(tr.installed(c)).toEqual({ version: '1.4.4.9', channel: 'tshock', build: 'v5.2.4' });
    expect(await tr.install!(c, launch({ flavour: 'tshock', version: 'v9.9.9' }), { validate: false })).toEqual({ ok: false, error: 'TShock has no release v9.9.9' });
  });

  it("tModLoader: its zip, checked against GitHub's digest, from the stable channel unless a preview is chosen", async () => {
    const c = newCtx();
    expect(await tr.install!(c, launch({ flavour: 'tmodloader' }), { validate: false })).toEqual({ ok: true });
    expect(readMarker(c)).toMatchObject({ flavour: 'tmodloader', version: 'v2026.07.3.0', terraria: '1.4.4', channel: 'stable', verified: true });
    expect(existsSync(inInstall(c, 'tmodloader-v2026.07.3.0', 'tModLoader.dll'))).toBe(true);
    expect(tr.installed(c)).toEqual({ version: '1.4.4', channel: 'tmodloader', build: 'v2026.07.3.0' });
    // Once the game said which 1.4.4 it is built on, that is the version.
    c.state = { ...c.state, gameVersion: '1.4.4.9' };
    expect(tr.installed(c)).toEqual({ version: '1.4.4.9', channel: 'tmodloader', build: 'v2026.07.3.0' });

    const preview = launch({ flavour: 'tmodloader', version: 'v2026.08.2.2' });
    expect(await tr.install!(c, preview, { validate: false })).toMatchObject({ ok: false, error: expect.stringMatching(/is a preview, and this server takes stable releases only/) });
    expect(readMarker(c)).toMatchObject({ version: 'v2026.07.3.0' });
    const previewChannel = launch({ flavour: 'tmodloader', channel: 'preview' });
    expect(await tr.install!(c, previewChannel, { validate: false })).toEqual({ ok: true });
    expect(readMarker(c)).toMatchObject({ version: 'v2026.08.2.2', channel: 'preview' });
    // A server back on the stable channel reinstalls a stable release before it starts.
    expect(tr.installOnStart!(c, launch({ flavour: 'tmodloader' }))).toBe('required');
  });
});

describe('install failures leave what was installed (UPD-01)', () => {
  it('refuses downloads that are not what was published, and missing ones', async () => {
    const bad = await startFakeDownloads({ fail: 'bad-checksum' });
    try {
      const c = newCtx();
      expect(await tr.install!(c, launch({ flavour: 'vanilla', version: '1.4.5.8' }), { validate: false })).toEqual({ ok: true });
      c.env = { ...c.env, ...downloadEnv(bad.url) };
      clearSourceCache();
      // TShock's and tModLoader's digests don't match; terraria.org's zip comes truncated.
      for (const p of [launch({ flavour: 'tshock' }), launch({ flavour: 'tmodloader' }), launch({ flavour: 'vanilla', version: '1.4.5.7' })]) {
        const r = await tr.install!(c, p, { validate: false });
        expect(r.ok, p.flavour).toBe(false);
        expect(readMarker(c)).toMatchObject({ flavour: 'vanilla', version: '1.4.5.8' });
        expect(readdirSync(c.roots.install).sort()).toEqual(['.gsp-install.json', 'vanilla-1458']);
      }
    } finally {
      await bad.close();
    }
    const missing = await startFakeDownloads({ fail: 'not-found' });
    try {
      const c = newCtx(missing.url);
      expect(await tr.install!(c, launch({ flavour: 'vanilla', version: '1.4.5.8' }), { validate: false })).toMatchObject({ ok: false, error: expect.stringMatching(/HTTP 404/) });
    } finally {
      await missing.close();
    }
  });

  it('downloads only over HTTPS, or from a service the environment points elsewhere', async () => {
    const c = newCtx();
    // GitHub's API on the fake, its assets somewhere else over plain HTTP.
    c.env = { ...c.env, GAME_TERRARIA_ORG_URL: '' };
    const realFetch = c.fetch!;
    c.fetch = async (url) => {
      const res = await realFetch(url);
      if (!url.includes('/releases?')) return res;
      const text = (await res.text()).replaceAll(downloads.url, 'http://downloads.example');
      return new Response(text, { status: res.status });
    };
    expect(await tr.install!(c, launch({ flavour: 'tshock' }), { validate: false })).toMatchObject({ ok: false, error: expect.stringMatching(/isn't HTTPS: http:\/\/downloads\.example/) });
  });
});

describe('versions (UPD-02)', () => {
  it("vanilla: terraria.org's newest and every version measured, newest first", async () => {
    const c = newCtx();
    const r = await tr.versions!(c, launch({ flavour: 'vanilla' }));
    const ids = r.versions.map((v) => v.id);
    expect(ids.slice(0, 3)).toEqual(['1.4.5.8', '1.4.5.7', '1.4.5.6']);
    expect(ids.at(-1)).toBe('1.4.1.2');
    expect(r.versions[0]).toEqual({ id: '1.4.5.8', build: '1458' });
    expect(r.installed).toBeNull();
  });

  it('vanilla: a version terraria.org lists that was never measured carries a warning; without terraria.org the measured ones are listed', async () => {
    const c = newCtx();
    c.fetch = async (url) => (url.endsWith('/dedicated-servers-names') ? Response.json(['terraria-server-1459.zip']) : fetch(url));
    const r = await tr.versions!(c, launch({ flavour: 'vanilla' }));
    expect(r.versions[0]).toEqual({ id: '1.4.5.9', build: '1459', warning: 'unverified-download' });
    clearSourceCache();
    c.fetch = async () => new Response('bad gateway', { status: 502 });
    const offline = await tr.versions!(c, launch({ flavour: 'vanilla' }));
    expect(offline.versions[0]!.id).toBe('1.4.5.8');
    expect(c.logs.some((l) => /Could not read terraria.org's version list \(terraria.org answered HTTP 502\)/.test(l))).toBe(true);
  });

  it('TShock: releases with a Linux x86-64 build, the Terraria version each is for, pre-releases flagged', async () => {
    const c = newCtx();
    const v = (await tr.versions!(c, launch({ flavour: 'tshock' }))).versions as TerrariaVersionInfo[];
    expect(v.map((x) => x.id)).toEqual(['v6.2.1', 'v6.1.0', 'v6.0.0-pre3', 'v5.2.4']);
    expect(v[0]).toEqual({ id: 'v6.2.1', channel: 'stable', terraria: '1.4.5.8', description: 'for Terraria 1.4.5.8', timeUpdated: Math.floor(Date.parse('2026-09-27T14:57:16Z') / 1000) });
    expect(v[2]).toMatchObject({ channel: 'prerelease', warning: 'tshock-prerelease' });
  });

  it('tModLoader: stable and preview releases, previews flagged', async () => {
    const c = newCtx();
    const v = (await tr.versions!(c, launch({ flavour: 'tmodloader' }))).versions;
    expect(v.map((x) => [x.id, x.channel, x.warning])).toEqual([
      ['v2026.08.2.2', 'preview', 'tml-preview'],
      ['v2026.07.3.0', 'stable', undefined],
      ['v2026.06.3.6', 'stable', undefined],
    ]);
  });

  it("asks GitHub once for a list and the install right after it: 60 calls an hour, a 304 counts too", async () => {
    const c = newCtx();
    const before = githubCalls();
    await tr.versions!(c, launch({ flavour: 'tshock' }));
    await tr.versions!(c, launch({ flavour: 'tshock' }));
    expect(await tr.install!(c, launch({ flavour: 'tshock' }), { validate: false })).toEqual({ ok: true });
    expect(await tr.install!(c, launch({ flavour: 'tshock', version: 'v6.1.0' }), { validate: false })).toEqual({ ok: true });
    expect(githubCalls() - before).toBe(1);
  });

  it("says when GitHub's anonymous limit is used up, and asks nothing more until it frees up", async () => {
    const limited = await startFakeDownloads({ fail: 'rate-limit' });
    try {
      const c = newCtx(limited.url);
      await expect(tr.versions!(c, launch({ flavour: 'tmodloader' }))).rejects.toThrow(/limit for anonymous requests \(60 an hour\) is used up until \d\d:\d\d UTC/);
      expect(await tr.install!(c, launch({ flavour: 'tshock' }), { validate: false })).toMatchObject({ ok: false, error: expect.stringMatching(/used up/) });
      expect(limited.requests.filter((r) => r.path.startsWith('/repos/'))).toHaveLength(1);
    } finally {
      await limited.close();
    }
  });
});
