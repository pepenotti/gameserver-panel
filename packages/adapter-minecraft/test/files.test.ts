// The files the agent owns before every start (CFG-04), the EULA (D6),
// Paper's bStats (Q10, NFR-09), and the launch command (SRV-01, NFR-04).
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { parseProperties, propertiesToRecord } from '@gsp/formats';
import { BSTATS_CONFIG, EULA_NOT_ACCEPTED, minecraftRuntimeAdapter as mc } from '../src/runtime';
import { INSTALL_MARKER, MANAGED_PROPERTIES, parseMinecraftLaunch, type InstallMarker, type Loader } from '../src/shared';
import { fixture, testCtx, type TestCtx } from './helpers';

let ctx: TestCtx | null = null;
afterEach(() => {
  ctx?.cleanup();
  ctx = null;
});

const launch = (loader: Loader, extra: Record<string, unknown> = {}) => parseMinecraftLaunch({ version: '26.3', loader, memoryMb: 2048, ...(loader === 'paper' ? { channel: 'ALPHA' } : {}), ...extra });
const props = (c: TestCtx) => propertiesToRecord(parseProperties(readFileSync(path.join(c.roots.data, 'server.properties'), 'utf8')));
const read = (c: TestCtx, rel: string) => readFileSync(path.join(c.roots.data, rel), 'utf8');

describe('prepare: the owner must have accepted the EULA (D6)', () => {
  it('refuses to start, with its own message, and writes nothing', async () => {
    for (const eulaAccepted of [undefined, false]) {
      ctx = testCtx({ eulaAccepted });
      await expect(mc.prepare(ctx, launch('vanilla'))).rejects.toThrow(EULA_NOT_ACCEPTED);
      expect(readdirSync(ctx.roots.data)).toEqual([]);
      ctx.cleanup();
    }
    ctx = null;
    expect(EULA_NOT_ACCEPTED).toMatch(/only the owner can accept it, in the panel/i);
    expect(EULA_NOT_ACCEPTED).toContain('https://aka.ms/MinecraftEULA');
  });

  it("writes eula=true once accepted, and turns the game's own eula=false file true, keeping its comments", async () => {
    ctx = testCtx({ eulaAccepted: true });
    await mc.prepare(ctx, launch('vanilla'));
    expect(propertiesToRecord(parseProperties(read(ctx, 'eula.txt')))).toEqual({ eula: 'true' });
    const generated = fixture('vanilla', 'config', 'eula.txt.generated');
    writeFileSync(path.join(ctx.roots.data, 'eula.txt'), generated);
    await mc.prepare(ctx, launch('vanilla'));
    expect(read(ctx, 'eula.txt')).toBe(generated.replace('eula=false', 'eula=true'));
  });
});

describe('prepare: managed server.properties keys (CFG-04)', () => {
  it('writes only the managed keys on a first start: the game completes the file', async () => {
    ctx = testCtx({ eulaAccepted: true, ports: { game: 25565, rcon: 25575 } });
    await mc.prepare(ctx, launch('vanilla'));
    expect(props(ctx)).toEqual({
      'server-port': '25565',
      'server-ip': '',
      'enable-rcon': 'true',
      'rcon.port': '25575',
      'rcon.password': ctx.state.controlSecret,
      'enable-query': 'false',
      'management-server-enabled': 'false',
      'level-name': 'world',
    });
    expect(Object.keys(props(ctx)).sort()).toEqual([...MANAGED_PROPERTIES].sort());
  });

  it("applies them again over the game's own file at every start, leaving every other line as it was", async () => {
    ctx = testCtx({ eulaAccepted: true, ports: { game: 25565, rcon: 30410 } });
    // What the game wrote on its first start: 71 keys, RCON off, an empty password.
    const generated = fixture('vanilla', 'config', 'server.properties.generated');
    writeFileSync(path.join(ctx.roots.data, 'server.properties'), generated);
    await mc.prepare(ctx, launch('vanilla'));
    const after = read(ctx, 'server.properties');
    expect(props(ctx)).toMatchObject({ 'enable-rcon': 'true', 'rcon.port': '30410', 'rcon.password': ctx.state.controlSecret, 'white-list': 'true', motd: 'A Minecraft Server' });
    const managed = new Set<string>(MANAGED_PROPERTIES);
    const others = (text: string) => text.split('\n').filter((l) => !managed.has(l.split('=')[0]!));
    expect(others(after)).toEqual(others(generated));
    expect(after.split('\n')).toHaveLength(generated.split('\n').length);
  });

  it('is idempotent: a second prepare changes nothing', async () => {
    ctx = testCtx({ eulaAccepted: true });
    writeFileSync(path.join(ctx.roots.data, 'server.properties'), fixture('paper', 'config', 'server.properties.after'));
    await mc.prepare(ctx, launch('paper'));
    const snap = () => Object.fromEntries(['server.properties', 'eula.txt', BSTATS_CONFIG].map((f) => [f, read(ctx!, f)]));
    const first = snap();
    await mc.prepare(ctx, launch('paper'));
    expect(snap()).toEqual(first);
  });
});

describe("prepare: Paper's bStats off for a new server (Q10, NFR-09)", () => {
  it('writes enabled: false when the file does not exist yet', async () => {
    ctx = testCtx({ eulaAccepted: true });
    await mc.prepare(ctx, launch('paper'));
    expect(read(ctx, BSTATS_CONFIG)).toMatch(/^enabled: false$/m);
  });

  it("leaves an existing file alone, so an owner who turned bStats on keeps it on", async () => {
    ctx = testCtx({ eulaAccepted: true });
    const onByOwner = fixture('paper', 'data', 'plugins', 'bStats', 'config.yml');
    expect(onByOwner).toMatch(/^enabled: true$/m);
    mkdirSync(path.join(ctx.roots.data, 'plugins', 'bStats'), { recursive: true });
    writeFileSync(path.join(ctx.roots.data, BSTATS_CONFIG), onByOwner);
    await mc.prepare(ctx, launch('paper'));
    expect(read(ctx, BSTATS_CONFIG)).toBe(onByOwner);
  });

  it('writes nothing of the kind for vanilla or Fabric', async () => {
    for (const loader of ['vanilla', 'fabric'] as const) {
      ctx = testCtx({ eulaAccepted: true });
      await mc.prepare(ctx, launch(loader));
      expect(existsSync(path.join(ctx.roots.data, 'plugins')), loader).toBe(false);
      ctx.cleanup();
    }
    ctx = null;
  });
});

describe('the launch command (SRV-01, NFR-04)', () => {
  function installed(c: TestCtx, loader: Loader, jre: number): void {
    const jar = { vanilla: 'server.jar', paper: 'paper.jar', fabric: 'fabric-server-launch.jar' }[loader];
    const marker: InstallMarker = { schema: 1, loader, version: '26.3', build: loader === 'paper' ? 41 : null, channel: loader === 'paper' ? 'ALPHA' : null, loaderVersion: loader === 'fabric' ? '0.19.5' : null, installerVersion: null, javaMajor: jre, jre, jar, sha1: null, sha256: null, installedAt: new Date().toISOString() };
    writeFileSync(path.join(c.roots.install, INSTALL_MARKER), JSON.stringify(marker));
    writeFileSync(path.join(c.roots.install, jar), 'x');
  }

  it.each([
    ['vanilla', 'server.jar', []],
    ['paper', 'paper.jar', []],
    ['fabric', 'fabric-server-launch.jar', ['-Dfabric.gameJarPath=<install>/server.jar']],
  ] as const)('%s: the measured argument list, in the data root, on the recorded Java', (loader, jar, extra) => {
    ctx = testCtx({ eulaAccepted: true });
    installed(ctx, loader, 21);
    const install = ctx.roots.install;
    // Without a launcher the image's JRE runs it.
    const real = mc.command({ ...ctx, tools: { home: ctx.tools.home } }, launch(loader, { memoryMb: 3072 }));
    expect(real).toEqual({
      argv: ['/opt/java/21/bin/java', '-Xms3072m', '-Xmx3072m', `-DbundlerRepoDir=${install}`, ...extra.map((a) => a.replace('<install>/server.jar', path.join(install, 'server.jar'))), '-jar', path.join(install, jar), 'nogui'],
      cwd: ctx.roots.data,
    });
    // Tests and the dev loop put the fake in java's place, with the same arguments.
    expect(mc.command(ctx, launch(loader, { memoryMb: 3072 })).argv).toEqual([...ctx.tools.launcher!, ...real.argv.slice(1)]);
  });

  it('refuses to launch what is not installed', () => {
    ctx = testCtx({ eulaAccepted: true });
    expect(() => mc.command(ctx!, launch('vanilla'))).toThrow(/not installed/);
    installed(ctx, 'paper', 25);
    expect(() => mc.command(ctx!, launch('vanilla'))).toThrow(/installed server is paper 26\.3/);
  });

  it('talks to the game over RCON with the control secret, which it redacts', () => {
    ctx = testCtx({ ports: { game: 25565, rcon: 30410 } });
    const p = launch('vanilla');
    expect(mc.channel(ctx, p)).toEqual({ kind: 'rcon', port: 30410, password: ctx.state.controlSecret });
    expect(mc.secrets(p, ctx.state)).toEqual([ctx.state.controlSecret]);
    expect(mc.roots(p)).toEqual({ data: '/data', install: '/opt/game' });
  });
});
