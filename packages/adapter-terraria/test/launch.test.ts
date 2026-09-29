// Launch params per flavour (SRV-01, SRV-05, UPD-02) and the command each
// flavour starts with, exactly as measured (docs/verification/terraria-1.4.5.8.md,
// "Launch"): every path absolute, the data root as the save folder always.
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { DOTNET, terrariaRuntimeAdapter as tr } from '../src/runtime';
import { INSTALL_MARKER, parseTerrariaLaunch, type InstallMarker, type TerrariaFlavour } from '../src/shared';
import { testCtx, type TestCtx } from './helpers';

const base = { world: 'myworld', worldSize: 1, maxPlayers: 8, memoryMb: 2048 };

describe('launch params (SRV-01, SRV-05, UPD-02)', () => {
  it('takes each flavour with its own version shape, and fills in what is left out', () => {
    expect(parseTerrariaLaunch({ ...base, flavour: 'vanilla', version: '1.4.5.8' })).toEqual({ flavour: 'vanilla', version: '1.4.5.8', channel: null, world: 'myworld', worldSize: 1, maxPlayers: 8, password: null, memoryMb: 2048 });
    expect(parseTerrariaLaunch({ ...base, flavour: 'tshock', version: 'v6.2.1' })).toMatchObject({ flavour: 'tshock', version: 'v6.2.1', channel: null });
    expect(parseTerrariaLaunch({ ...base, flavour: 'tshock', version: 'v6.0.0-pre3' }).version).toBe('v6.0.0-pre3');
    expect(parseTerrariaLaunch({ ...base, flavour: 'tmodloader' })).toMatchObject({ flavour: 'tmodloader', version: null, channel: 'stable' });
    expect(parseTerrariaLaunch({ ...base, flavour: 'tmodloader', version: 'v2026.08.2.2', channel: 'preview' })).toMatchObject({ channel: 'preview' });
    expect(parseTerrariaLaunch({ ...base, flavour: 'vanilla', password: '' }).password).toBe('');
    expect(parseTerrariaLaunch({ ...base, flavour: 'vanilla', password: 'hunter 2' }).password).toBe('hunter 2');
  });

  it.each([
    [{ flavour: 'terraria' }, /flavour/],
    [{ flavour: 'vanilla', version: '1458' }, /version must be a Terraria version such as 1\.4\.5\.8/],
    [{ flavour: 'vanilla', version: 'v6.2.1' }, /version/],
    [{ flavour: 'tshock', version: '6.2.1' }, /release tag such as v6\.2\.1/],
    [{ flavour: 'tmodloader', version: 'v2026.7.3.0' }, /release tag such as v2026\.07\.3\.0/],
    [{ flavour: 'vanilla', channel: 'stable' }, /only for tModLoader/],
    [{ flavour: 'tmodloader', channel: 'beta' }, /channel must be one of stable, preview/],
    [{ flavour: 'vanilla', world: 'My World' }, /world/],
    [{ flavour: 'vanilla', world: '../x' }, /world/],
    [{ flavour: 'vanilla', world: 'x'.repeat(33) }, /world/],
    [{ flavour: 'vanilla', worldSize: 4 }, /worldSize/],
    [{ flavour: 'vanilla', maxPlayers: 0 }, /maxPlayers/],
    [{ flavour: 'vanilla', maxPlayers: 256 }, /maxPlayers/],
    [{ flavour: 'vanilla', password: 'a\nb' }, /password/],
    [{ flavour: 'vanilla', password: ' padded' }, /password/],
    [{ flavour: 'vanilla', memoryMb: 512 }, /memoryMb must be a whole number from 1024/],
  ])('refuses %j', (x, why) => {
    expect(() => parseTerrariaLaunch({ ...base, ...x })).toThrow(why);
  });

  it('asks 2048 MiB for a large world, which took 1.2 GiB with nobody online (SRV-05)', () => {
    expect(() => parseTerrariaLaunch({ ...base, flavour: 'vanilla', worldSize: 3, memoryMb: 1024 })).toThrow(/large world .* at least 2048/);
    expect(parseTerrariaLaunch({ ...base, flavour: 'vanilla', worldSize: 3, memoryMb: 2048 }).worldSize).toBe(3);
    expect(parseTerrariaLaunch({ ...base, flavour: 'vanilla', worldSize: 2, memoryMb: 1024 }).worldSize).toBe(2);
  });

  it('names the password and the control secret for redaction, and keeps them out of the command line', () => {
    const p = parseTerrariaLaunch({ ...base, flavour: 'vanilla', password: 'Sw0rdfish' });
    expect(tr.secrets(p, { controlSecret: 's'.repeat(48), gameVersion: null })).toEqual(['s'.repeat(48), 'Sw0rdfish']);
    expect(tr.secrets(parseTerrariaLaunch({ ...base, flavour: 'vanilla', password: '' }), { controlSecret: 'x'.repeat(48), gameVersion: null })).toEqual(['x'.repeat(48)]);
  });
});

describe('the command per flavour (SRV-01, NFR-04)', () => {
  let ctx: TestCtx | null = null;
  afterEach(() => {
    ctx?.cleanup();
    ctx = null;
  });

  /** An install as the marker records it, without downloading anything. */
  function installed(flavour: TerrariaFlavour, version: string, folder: string, entry: string) {
    const c = (ctx = testCtx({ ports: { game: 7777, rest: 7878 } }));
    c.tools.launcher = undefined;
    mkdirSync(path.join(c.roots.install, folder), { recursive: true });
    writeFileSync(path.join(c.roots.install, folder, entry), '');
    const marker: InstallMarker = { schema: 1, flavour, version, terraria: '1.4.5.8', channel: null, folder, sha256: '0'.repeat(64), verified: true, installedAt: '2026-09-29T00:00:00.000Z' };
    writeFileSync(path.join(c.roots.install, INSTALL_MARKER), JSON.stringify(marker));
    return c;
  }

  it('vanilla: the binary itself, the flags measured, the data root as its save folder', () => {
    const c = installed('vanilla', '1.4.5.8', 'vanilla-1458', 'TerrariaServer.bin.x86_64');
    const d = c.roots.data;
    const cmd = tr.command(c, parseTerrariaLaunch({ ...base, flavour: 'vanilla', version: '1.4.5.8', password: 'secret1' }));
    expect(cmd).toEqual({
      argv: [
        path.join(c.roots.install, 'vanilla-1458', 'TerrariaServer.bin.x86_64'),
        ...['-port', '7777', '-maxplayers', '8', '-world', path.join(d, 'Worlds', 'myworld.wld'), '-autocreate', '1', '-worldname', 'myworld'],
        ...['-banlist', path.join(d, 'banlist.txt'), '-config', path.join(d, 'serverconfig.txt'), '-savedirectory', d, '-noupnp'],
      ],
      cwd: d,
    });
    expect(cmd.argv.join(' ')).not.toContain('secret1');
  });

  it('TShock: its app host with its config, log and crash folders in the data root, and a bundle folder in /tmp', () => {
    const c = installed('tshock', 'v6.2.1', 'tshock-v6.2.1', 'TShock.Server');
    const d = c.roots.data;
    const cmd = tr.command(c, parseTerrariaLaunch({ ...base, flavour: 'tshock', version: 'v6.2.1' }));
    expect(cmd.argv[0]).toBe(path.join(c.roots.install, 'tshock-v6.2.1', 'TShock.Server'));
    expect(cmd.argv.slice(-8)).toEqual(['-savedirectory', d, '-configpath', path.join(d, 'tshock'), '-logpath', path.join(d, 'tshock', 'logs'), '-crashdir', path.join(d, 'tshock', 'crashes')]);
    expect(cmd.cwd).toBe(d);
    expect(cmd.env).toEqual({ DOTNET_BUNDLE_EXTRACT_BASE_DIR: '/tmp/dotnet-bundle', DOTNET_CLI_TELEMETRY_OPTOUT: '1' });
    // The REST token lives in its config, never on the command line (TShock logs it to ServerLog.txt).
    expect(cmd.argv.some((a) => /rest/i.test(a))).toBe(false);
  });

  it('tModLoader: dotnet and its dll without Steam, its own save flag, the Workshop cache, run from its install folder', () => {
    const c = installed('tmodloader', 'v2026.07.3.0', 'tmodloader-v2026.07.3.0', 'tModLoader.dll');
    const d = c.roots.data;
    const folder = path.join(c.roots.install, 'tmodloader-v2026.07.3.0');
    const cmd = tr.command(c, parseTerrariaLaunch({ ...base, flavour: 'tmodloader', version: 'v2026.07.3.0' }));
    expect(cmd.argv.slice(0, 4)).toEqual([DOTNET, path.join(folder, 'tModLoader.dll'), '-server', '-nosteam']);
    expect(cmd.argv.slice(-4)).toEqual(['-tmlsavedirectory', d, '-steamworkshopfolder', path.join(d, '.workshop', 'steamapps', 'workshop')]);
    expect(cmd.argv).toContain('-world');
    expect(cmd.cwd).toBe(folder);
    // The launcher (tests, the dev loop) stands in for dotnet only.
    c.tools.launcher = ['node', 'fake.mjs'];
    expect(tr.command(c, parseTerrariaLaunch({ ...base, flavour: 'tmodloader' })).argv.slice(0, 3)).toEqual(['node', 'fake.mjs', path.join(folder, 'tModLoader.dll')]);
  });

  it('refuses to start what is not installed, or another flavour than the one installed', () => {
    const c = installed('tshock', 'v6.2.1', 'tshock-v6.2.1', 'TShock.Server');
    expect(() => tr.command(c, parseTerrariaLaunch({ ...base, flavour: 'vanilla' }))).toThrow(/installed server is tshock, not vanilla/);
    const empty = testCtx();
    try {
      expect(() => tr.command(empty, parseTerrariaLaunch({ ...base, flavour: 'vanilla' }))).toThrow(/not installed yet/);
    } finally {
      empty.cleanup();
    }
  });
});
