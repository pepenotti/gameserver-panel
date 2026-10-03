// Shared installs on the agent's side (HST-09, D12): an install job installs,
// warms up, links the redirects and writes the marker last, never starting
// the game or writing files people ask for; a server on a shared install
// never installs or updates it, refuses a launch that wants another one
// (install-mismatch), makes the redirects' targets before each start, and
// its file API finds nothing through the install's links. The fake game
// treats an install with the marker as read-only, as the orchestrator
// mounts it, so a missing redirect fails as measured.
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import type http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { RuntimeAdapter } from '@gsp/adapter-api';
import { SHARED_INSTALL_MARKER, type SharedInstallMarker } from '@gsp/shared';
import { AgentError } from '../src/agent';
import { loadConfig } from '../src/config';
import { createAgentServer } from '../src/http';
import { linkRedirect, makeRedirectTargets, measureInstall, resolveRedirect } from '../src/shared-install';
import { envelope, launch, makeHarness, type Harness } from './helpers';

const PZ_REDIRECT = { path: 'steamapps/workshop', to: '/data/.workshop/steamapps/workshop' };
const ITEM = '2544353492';

const harnesses: Harness[] = [];
const dirs: string[] = [];
let server: http.Server | null = null;
afterEach(async () => {
  if (server) {
    server.closeAllConnections();
    await new Promise((r) => server!.close(r));
    server = null;
  }
  // Servers on an install go before the job that made it.
  for (const h of harnesses.splice(0).reverse()) await h.cleanup();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  delete process.env.FAKE_STEAMCMD_FAIL;
});

async function harness(...a: Parameters<typeof makeHarness>): Promise<Harness> {
  const h = await makeHarness(...a);
  harnesses.push(h);
  return h;
}

/** What `fn` throws (it must throw). */
function thrown(fn: () => unknown): unknown {
  try {
    fn();
  } catch (e) {
    return e;
  }
  throw new Error('expected a throw');
}

/** A folder standing for `/data`, the same path in the job's container and the server's (one host here). */
function dataFolder(): string {
  const d = mkdtempSync(path.join(os.tmpdir(), 'gsp-shared-data-'));
  dirs.push(d);
  return d;
}

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

/** The PZ adapter with another install declaration (a game not measured, a redirect left out). */
const withSharing = (install: RuntimeAdapter['meta']['install']) => (a: RuntimeAdapter): RuntimeAdapter => ({ ...a, meta: { ...a.meta, install } });

/** An install job's harness on `data`, its install done. */
async function jobDone(data: string, o: { adapter?: (a: RuntimeAdapter) => RuntimeAdapter } = {}): Promise<Harness> {
  const job = await harness({ mode: 'install-job', dataDir: data }, o);
  job.agent.setLaunch(envelope());
  expect(await job.agent.install({ validate: false }, undefined)).toEqual({ ok: true });
  return job;
}

/** A server's harness on the job's install, with `data` as its data. */
const onInstall = (job: Harness, data: string, o: { adapter?: (a: RuntimeAdapter) => RuntimeAdapter } = {}) => harness({ installShared: true, installDir: job.cfg.installDir!, dataDir: data }, o);

/** The server's ini with a Workshop item, as the panel's Mods page leaves it. */
function withWorkshopItem(data: string): void {
  mkdirSync(path.join(data, 'Server'), { recursive: true });
  writeFileSync(path.join(data, 'Server', `${launch.serverName}.ini`), `WorkshopItems=${ITEM}\nMods=Mod${ITEM}\n`);
}

describe('the agent learns its mode from the orchestrator (HST-09, D3)', () => {
  it('reads GSP_AGENT_MODE and GSP_INSTALL_SHARED, and refuses anything else, or both', () => {
    const token = { AGENT_TOKEN: 't'.repeat(40) };
    expect(loadConfig(token)).toMatchObject({ mode: 'server', installShared: false });
    expect(loadConfig({ ...token, GSP_AGENT_MODE: 'install-job' })).toMatchObject({ mode: 'install-job', installShared: false });
    expect(loadConfig({ ...token, GSP_INSTALL_SHARED: '1' })).toMatchObject({ mode: 'server', installShared: true });
    expect(loadConfig({ ...token, GSP_INSTALL_SHARED: '0' })).toMatchObject({ installShared: false });
    expect(() => loadConfig({ ...token, GSP_AGENT_MODE: 'server' })).toThrow(/GSP_AGENT_MODE/);
    expect(() => loadConfig({ ...token, GSP_INSTALL_SHARED: 'yes' })).toThrow(/GSP_INSTALL_SHARED/);
    expect(() => loadConfig({ ...token, GSP_AGENT_MODE: 'install-job', GSP_INSTALL_SHARED: '1' })).toThrow(/install job/);
  });
});

describe('an install job (HST-09, D12)', () => {
  it('installs, links the redirects into the data, writes the marker last with what the install is, and never starts the game', async () => {
    const data = dataFolder();
    const job = await jobDone(data);
    const install = job.cfg.installDir!;
    const marker = JSON.parse(readFileSync(path.join(install, SHARED_INSTALL_MARKER), 'utf8')) as SharedInstallMarker;
    expect(marker).toEqual({
      schema: 1,
      adapter: 'pz',
      flavour: null,
      mode: 'shared',
      key: { flavour: null, version: null, build: '24909800', branch: 'public' },
      installed: { version: null, channel: 'public', build: '24909800' },
      redirects: [PZ_REDIRECT],
      bytes: expect.any(Number),
      files: 1,
      agentVersion: 'test',
      finishedAt: expect.stringMatching(/^\d{4}-/),
    });
    expect(marker.bytes).toBeGreaterThan(0);
    // The redirect: a link in the install, leading to the data root, its target made.
    const link = path.join(install, 'steamapps', 'workshop');
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    expect(realpathSync(link)).toBe(realpathSync(path.join(data, '.workshop', 'steamapps', 'workshop')));
    const s = job.agent.status();
    expect(s.install).toEqual({ mode: 'job', sharing: { mode: 'shared', redirects: [PZ_REDIRECT] }, marker, mismatch: null });
    expect(s).toMatchObject({ state: 'stopped', pid: null, desired: 'stopped' });
    expect(job.logs().some((l) => l.startsWith('Starting:'))).toBe(false);
    expect(job.logs()).toContain(`Shared install ready: 1 files, ${marker.bytes} bytes.`);
  });

  it('never starts the game, runs its commands, saves, runs actions or writes files, through the agent or its API', async () => {
    const job = await harness({ mode: 'install-job' });
    const refused = { code: 'conflict', install: 'install-job' };
    for (const call of [() => job.agent.start(envelope(), undefined), () => job.agent.command('players', undefined), () => job.agent.save(), () => job.agent.action('workshop-download', { ids: [ITEM] }), () => job.agent.pack({ root: 'data', rels: ['Server'] })]) {
      await expect((async () => call())()).rejects.toMatchObject(refused);
    }
    for (const call of [() => job.agent.kill(undefined), () => job.agent.stop({}, undefined)]) expect(call).toThrow(AgentError);
    server = createAgentServer(job.agent, job.hub, job.cfg.token);
    await new Promise<void>((r) => server!.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const auth = { authorization: `Bearer ${job.cfg.token}` };
    const json = { ...auth, 'content-type': 'application/json' };
    for (const [method, p, body, type] of [
      ['POST', '/v1/start', '{}', 'application/json'],
      ['POST', '/v1/command', '{"command":"players"}', 'application/json'],
      ['POST', '/v1/save', '{}', 'application/json'],
      ['POST', '/v1/actions/workshop-download', '{"input":{"ids":["1"]}}', 'application/json'],
      ['PUT', '/v1/fs/write?root=install&rel=x.txt', 'x', 'application/octet-stream'],
      ['POST', '/v1/fs/remove', '{"root":"data","rels":["x"]}', 'application/json'],
      ['POST', '/v1/archive/pack', '{"root":"install","rels":["steamapps"]}', 'application/json'],
      ['POST', '/v1/archive/stage', 'x', 'application/x-tar'],
    ] as const) {
      const r = await fetch(`${base}${p}`, { method, headers: { ...auth, 'content-type': type }, body });
      expect([r.status, await r.json()], `${method} ${p}`).toEqual([409, expect.objectContaining({ code: 'conflict', install: 'install-job' })]);
    }
    expect(existsSync(path.join(job.cfg.installDir!, 'x.txt'))).toBe(false);
    // What drives it, and reads.
    expect((await fetch(`${base}/v1/status`, { headers: auth })).status).toBe(200);
    expect((await fetch(`${base}/v1/launch`, { method: 'PUT', headers: json, body: JSON.stringify(envelope()) })).status).toBe(200);
    expect((await fetch(`${base}/v1/install`, { method: 'POST', headers: json, body: '{}' })).status).toBe(200);
    const list = await fetch(`${base}/v1/fs/list`, { method: 'POST', headers: json, body: '{"root":"install","rel":""}' });
    expect(list.status).toBe(200);
    expect(((await list.json()) as { entries: { name: string }[] }).entries.map((e) => e.name)).toEqual([SHARED_INSTALL_MARKER, 'steamapps']);
  });

  it("drops a copied install's marker first, and replaces what a game wrote at a redirect path with the link", async () => {
    const data = dataFolder();
    const job = await harness({ mode: 'install-job', dataDir: data });
    const install = job.cfg.installDir!;
    // What a copy of another install (or of a server's own install, at migration) brings along.
    mkdirSync(path.join(install, 'steamapps', 'workshop', 'content', '108600', ITEM), { recursive: true });
    writeFileSync(path.join(install, 'steamapps', 'workshop', 'content', '108600', ITEM, 'mod.info'), 'x');
    writeFileSync(path.join(install, SHARED_INSTALL_MARKER), JSON.stringify({ schema: 1, adapter: 'pz', flavour: null, key: {} }));
    job.agent.setLaunch(envelope());
    process.env.FAKE_STEAMCMD_FAIL = 'disk';
    expect(await job.agent.install({ validate: false }, undefined)).toMatchObject({ ok: false });
    // A failed job leaves no marker: no server mounts it.
    expect(existsSync(path.join(install, SHARED_INSTALL_MARKER))).toBe(false);
    expect(job.agent.status().install?.marker).toBeNull();
    delete process.env.FAKE_STEAMCMD_FAIL;
    expect(await job.agent.install({ validate: false }, undefined)).toEqual({ ok: true });
    expect(lstatSync(path.join(install, 'steamapps', 'workshop')).isSymbolicLink()).toBe(true);
    expect(existsSync(path.join(data, '.workshop', 'steamapps', 'workshop', 'content'))).toBe(false);
    expect(job.agent.status().install?.marker).toMatchObject({ files: 1 });
  });

  it("refuses a game whose installs aren't shared, and leaves no marker when the warm-up fails", async () => {
    const own = await harness({ mode: 'install-job' }, { adapter: withSharing({ mode: 'own' }) });
    own.agent.setLaunch(envelope());
    expect(thrown(() => own.agent.install({ validate: false }, undefined))).toMatchObject({ code: 'conflict', install: 'install-job' });
    const cold = await harness({ mode: 'install-job' }, { adapter: (a) => ({ ...a, warmUp: async () => ({ ok: false, error: 'no bundler' }) }) });
    cold.agent.setLaunch(envelope());
    expect(await cold.agent.install({ validate: false }, undefined)).toEqual({ ok: false, error: 'Warm-up failed: no bundler' });
    expect(existsSync(path.join(cold.cfg.installDir!, SHARED_INSTALL_MARKER))).toBe(false);
  });
});

describe('a server on a shared install (HST-09, D12, UPD-03)', () => {
  it('never installs, updates or validates it: those come from install jobs', async () => {
    const data = dataFolder();
    const job = await jobDone(data);
    const srv = await onInstall(job, dataFolder());
    srv.agent.setLaunch(envelope());
    expect(thrown(() => srv.agent.install({ validate: true }, undefined))).toMatchObject({ code: 'conflict', install: 'shared-install' });
    expect(srv.agent.status().install).toMatchObject({ mode: 'shared', marker: { adapter: 'pz' }, mismatch: null });
    // The version list only reads Steam's (steamcmd writes its HOME, measured).
    expect((await srv.agent.versions()).installed).toMatchObject({ channel: 'public', build: '24909800' });
  });

  it("refuses to start on an install no job finished, and on one that isn't what its launch asks for (install-mismatch), installing nothing", async () => {
    const empty = await harness({ installShared: true });
    await empty.agent.start(envelope(), undefined);
    expect((await empty.waitFor((s) => s.state === 'failed')).failure).toMatch(/shared install isn't finished/);

    const data = dataFolder();
    const job = await jobDone(data);
    const before = tree(job.cfg.installDir!);
    const srv = await onInstall(job, dataFolder());
    await srv.agent.start(envelope({ branch: 'legacy41' }), undefined);
    const s = await srv.waitFor((x) => x.state === 'failed');
    expect(s.failure).toMatch(/^install-mismatch: this server's shared install holds public build 24909800, and its launch asks for another/);
    expect(s.install?.mismatch).toEqual({ installed: { version: null, channel: 'public', build: '24909800' }, message: s.failure });
    expect(srv.events.some((e) => e.event.type === 'job')).toBe(false);
    expect(tree(job.cfg.installDir!)).toEqual(before);
    // A launch that fits starts, and the mismatch is gone.
    await srv.agent.start(envelope({ updateOnStart: true }), undefined);
    const ok = await srv.waitFor((x) => x.state === 'running');
    expect(ok.install?.mismatch).toBeNull();
    expect(srv.logs()).toContain('Not updating at start: this server runs from a shared install, which install jobs update.');
    expect(srv.events.some((e) => e.event.type === 'job')).toBe(false);
  });

  it("makes the redirect targets before each start: the game's own Workshop download lands in the server's data, the install unchanged", async () => {
    const data = dataFolder();
    const job = await jobDone(data);
    const before = tree(job.cfg.installDir!);
    // A fresh server's data: the target the job made in its own data isn't there.
    rmSync(path.join(data, '.workshop'), { recursive: true, force: true });
    withWorkshopItem(data);
    const srv = await onInstall(job, data);
    await srv.agent.start(envelope(), undefined);
    await srv.waitFor((s) => s.state === 'running');
    expect(existsSync(path.join(data, '.workshop', 'steamapps', 'workshop', 'content', '108600', ITEM, 'mods', `Mod${ITEM}`, '42', 'mod.info'))).toBe(true);
    expect(srv.logs().some((l) => l.includes(`loading Mod${ITEM}`))).toBe(true);
    expect(tree(job.cfg.installDir!)).toEqual(before);
    await srv.agent.stop({}, undefined);
    await srv.agent.start(undefined, undefined);
    await srv.waitFor((s) => s.state === 'running');
    expect(tree(job.cfg.installDir!)).toEqual(before);
  });

  it("fails like the game does when the redirect is missing: the fakes refuse writes into a shared install (measured: a NullPointerException, exit 0)", async () => {
    const data = dataFolder();
    const job = await jobDone(data, { adapter: withSharing({ mode: 'shared' }) });
    expect(existsSync(path.join(job.cfg.installDir!, 'steamapps', 'workshop'))).toBe(false);
    const before = tree(job.cfg.installDir!);
    withWorkshopItem(data);
    const srv = await onInstall(job, data, { adapter: withSharing({ mode: 'shared' }) });
    await srv.agent.start(envelope(), undefined);
    await srv.waitFor((s) => s.state === 'crashed' || s.state === 'failed');
    expect(srv.logs().some((l) => l.includes('Install library folder not found'))).toBe(true);
    expect(tree(job.cfg.installDir!)).toEqual(before);
  });

  it("answers 'not there' for lookups through the install's links, and never writes the install", async () => {
    const data = dataFolder();
    const job = await jobDone(data);
    const srv = await onInstall(job, data);
    srv.agent.setLaunch(envelope());
    mkdirSync(path.join(data, '.workshop', 'steamapps', 'workshop', 'content', '108600', ITEM), { recursive: true });
    const rel = `steamapps/workshop/content/108600/${ITEM}`;
    expect(await srv.agent.files.stat('install', 'steamapps/workshop')).toBeNull();
    expect(await srv.agent.files.stat('install', rel)).toBeNull();
    expect(await srv.agent.files.list('install', rel)).toEqual([]);
    expect(await srv.agent.files.read('install', `${rel}/mod.info`)).toBeNull();
    // A listing shows the link as one; what is behind it is reached through the data root.
    expect((await srv.agent.files.list('install', 'steamapps')).map((e) => [e.name, e.kind])).toEqual([
      ['appmanifest_380870.acf', 'file'],
      ['workshop', 'symlink'],
    ]);
    expect(await srv.agent.files.stat('data', `.workshop/${rel}`)).toMatchObject({ kind: 'dir' });
    await expect(srv.agent.files.writeAtomic('install', 'x.txt', 'x')).rejects.toMatchObject({ code: 'outside-root' });
    await expect(srv.agent.files.pack({ root: 'install', rels: [rel] })).rejects.toMatchObject({ code: 'outside-root' });
  });
});

describe('redirects, links and targets (HST-09)', () => {
  function folder(): string {
    const d = mkdtempSync(path.join(os.tmpdir(), 'gsp-redirect-'));
    dirs.push(d);
    return d;
  }

  it("resolves a version's folder by its pattern, never through a link, and finds nothing when the folders aren't there", () => {
    const root = folder();
    const r = { path: 'tmodloader-*/tModLoader-Logs', to: '/data/tModLoader-Logs' };
    expect(resolveRedirect(root, r)).toEqual([]);
    mkdirSync(path.join(root, 'tmodloader-v2026.07.3.0'));
    mkdirSync(path.join(root, 'tshock-v6.2.1'));
    writeFileSync(path.join(root, 'tmodloader-notes.txt'), '');
    const elsewhere = folder();
    symlinkSync(elsewhere, path.join(root, 'tmodloader-link'), process.platform === 'win32' ? 'junction' : 'dir');
    expect(resolveRedirect(root, r)).toEqual(['tmodloader-v2026.07.3.0/tModLoader-Logs']);
    expect(resolveRedirect(root, PZ_REDIRECT)).toEqual([]);
    expect(() => resolveRedirect(root, { path: '../x', to: '/data/x' })).toThrow(/inside the install/);
  });

  it('links into the data root only, refusing a way through a link, and makes targets only as plain folders', () => {
    const root = folder();
    const data = folder();
    const r = { path: 'tmodloader-*/tModLoader-Logs', to: '/data/tModLoader-Logs' };
    mkdirSync(path.join(root, 'tmodloader-v1', 'tModLoader-Logs'), { recursive: true });
    writeFileSync(path.join(root, 'tmodloader-v1', 'tModLoader-Logs', 'server.log'), 'old');
    linkRedirect(root, data, 'tmodloader-v1/tModLoader-Logs', r);
    expect(realpathSync(path.join(root, 'tmodloader-v1', 'tModLoader-Logs'))).toBe(realpathSync(path.join(data, 'tModLoader-Logs')));
    expect(readdirSync(path.join(data, 'tModLoader-Logs'))).toEqual([]);
    // Again: the link replaced, not followed.
    linkRedirect(root, data, 'tmodloader-v1/tModLoader-Logs', r);
    expect(lstatSync(path.join(root, 'tmodloader-v1', 'tModLoader-Logs')).isSymbolicLink()).toBe(true);
    const away = folder();
    symlinkSync(away, path.join(root, 'tmodloader-v2'), process.platform === 'win32' ? 'junction' : 'dir');
    expect(() => linkRedirect(root, data, 'tmodloader-v2/tModLoader-Logs', r)).toThrow(/not a plain folder/);
    expect(readdirSync(away)).toEqual([]);
    expect(() => linkRedirect(root, data, '../escape', { path: 'escape', to: '/data/x' })).toThrow(/inside the install/);

    const srvData = folder();
    makeRedirectTargets(srvData, [r, PZ_REDIRECT]);
    expect(lstatSync(path.join(srvData, 'tModLoader-Logs')).isDirectory()).toBe(true);
    expect(lstatSync(path.join(srvData, '.workshop', 'steamapps', 'workshop')).isDirectory()).toBe(true);
    rmSync(path.join(srvData, 'tModLoader-Logs'), { recursive: true });
    writeFileSync(path.join(srvData, 'tModLoader-Logs'), 'in the way');
    expect(() => makeRedirectTargets(srvData, [r])).toThrow(/not a plain folder/);
  });

  it('measures the files of an install, links and the marker aside', async () => {
    const root = folder();
    mkdirSync(path.join(root, 'a', 'b'), { recursive: true });
    writeFileSync(path.join(root, 'a', 'b', 'f'), '12345');
    writeFileSync(path.join(root, 'g'), '12');
    writeFileSync(path.join(root, SHARED_INSTALL_MARKER), '{}');
    symlinkSync(folder(), path.join(root, 'link'), process.platform === 'win32' ? 'junction' : 'dir');
    expect(await measureInstall(root)).toEqual({ bytes: 7, files: 2 });
  });
});
