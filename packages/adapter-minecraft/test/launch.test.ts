// Launch params (UPD-02, UPD-05, UPD-06, Q11) and the Java each version runs
// on (PRD §10, HST-01), from the measured facts.
import { describe, expect, it } from 'vitest';
import { channelAllows, compareVersions, isOffered, parseMinecraftLaunch, PAPER_CHANNELS } from '../src/shared';
import { javaBin, jreFor, SHIPPED_JRES } from '../src/runtime';
import { fixture } from './helpers';

const base = { version: '26.3', memoryMb: 2048 };

describe('launch params (UPD-02, UPD-06)', () => {
  it('takes each loader with its own options, and fills in the defaults', () => {
    expect(parseMinecraftLaunch({ ...base, loader: 'vanilla' })).toEqual({ ...base, loader: 'vanilla', channel: null, build: null, loaderVersion: null });
    // UPD-05: STABLE unless an admin picks BETA or ALPHA.
    expect(parseMinecraftLaunch({ ...base, loader: 'paper' })).toMatchObject({ loader: 'paper', channel: 'STABLE', build: null });
    expect(parseMinecraftLaunch({ ...base, loader: 'paper', channel: 'ALPHA', build: 41 })).toMatchObject({ channel: 'ALPHA', build: 41 });
    expect(parseMinecraftLaunch({ ...base, loader: 'fabric', loaderVersion: '0.19.5' })).toMatchObject({ loader: 'fabric', loaderVersion: '0.19.5', channel: null });
    // A form may send the other loaders' fields empty.
    expect(parseMinecraftLaunch({ ...base, loader: 'vanilla', channel: null, build: null, loaderVersion: null }).loader).toBe('vanilla');
    expect(parseMinecraftLaunch({ version: '1.16.5', loader: 'vanilla', memoryMb: 1024 }).version).toBe('1.16.5');
  });

  it('refuses what a loader does not take', () => {
    expect(() => parseMinecraftLaunch({ ...base, loader: 'vanilla', build: 41 })).toThrow(/build is only for Paper/);
    expect(() => parseMinecraftLaunch({ ...base, loader: 'fabric', channel: 'ALPHA' })).toThrow(/channel is only for Paper/);
    expect(() => parseMinecraftLaunch({ ...base, loader: 'paper', loaderVersion: '0.19.5' })).toThrow(/loaderVersion is only for Fabric/);
    // The channel filter is case-sensitive on Fill v3.
    expect(() => parseMinecraftLaunch({ ...base, loader: 'paper', channel: 'stable' })).toThrow(/channel must be one of STABLE, BETA, ALPHA/);
    expect(() => parseMinecraftLaunch({ ...base, loader: 'paper', build: 1.5 })).toThrow(/build/);
    expect(() => parseMinecraftLaunch({ ...base, loader: 'fabric', loaderVersion: '0.19.5; rm -rf /' })).toThrow(/loaderVersion/);
    expect(() => parseMinecraftLaunch({ ...base, loader: 'forge' })).toThrow(/loader must be one of vanilla, paper, fabric/);
  });

  it('offers Minecraft 1.16.5 and newer releases only (Q11)', () => {
    for (const version of ['1.16.4', '1.12.2', '1.8.9']) expect(() => parseMinecraftLaunch({ ...base, version, loader: 'vanilla' }), version).toThrow(/1\.16\.5 or newer/);
    for (const version of ['26.4-snapshot-1', '1.21.11-pre5', '26.3-rc-3', 'latest', '', '../26.3', '26.3\n']) expect(() => parseMinecraftLaunch({ ...base, version, loader: 'vanilla' }), version).toThrow(/Minecraft release/);
    expect(isOffered('1.16.5')).toBe(true);
    expect(isOffered('1.16.4')).toBe(false);
    expect(isOffered('26.1.2')).toBe(true);
  });

  it('checks the heap size', () => {
    for (const memoryMb of [512, 1023, 65_537, 2048.5, '2048']) expect(() => parseMinecraftLaunch({ ...base, loader: 'vanilla', memoryMb }), String(memoryMb)).toThrow(/memoryMb/);
  });

  it('orders versions numerically: the 26.x releases are newer than every 1.x one', () => {
    const ids = ['1.16.5', '26.1', '1.21.11', '26.1.2', '1.9.4', '26.3', '1.21.9'];
    expect([...ids].sort(compareVersions)).toEqual(['1.9.4', '1.16.5', '1.21.9', '1.21.11', '26.1', '26.1.2', '26.3']);
  });

  it("reads a Paper version's newest build as whether it has a STABLE one, as measured on every version from 1.16.5 up (Q13)", () => {
    const m = JSON.parse(fixture('paper', 'api', 'channel-matrix.json')) as { versions: { version: string; newestChannel: string; latestIsNewest: boolean; channelsOnlyMoveForward: boolean; counts: Record<string, number> }[] };
    expect(m.versions.at(-1)!.version).toBe('1.16.5');
    for (const v of m.versions) {
      // `/builds/latest` is the newest build of any channel, and a version's builds only move ALPHA → BETA → STABLE…
      expect([v.latestIsNewest, v.channelsOnlyMoveForward], v.version).toEqual([true, true]);
      // …so it has a STABLE build exactly when its newest is one: what versions() warns about.
      expect((v.counts.STABLE ?? 0) > 0, v.version).toBe(v.newestChannel === 'STABLE');
    }
    // Some versions never got a STABLE build: they stay offered, with the warning.
    expect(m.versions.filter((v) => v.newestChannel !== 'STABLE').map((v) => v.version)).toEqual(expect.arrayContaining(['26.3', '1.21.9', '1.18']));
  });

  it('takes Paper builds of the pinned channel or a more stable one (UPD-05)', () => {
    expect(PAPER_CHANNELS).toEqual(['STABLE', 'BETA', 'ALPHA']);
    expect(channelAllows('STABLE', 'STABLE')).toBe(true);
    expect(channelAllows('STABLE', 'BETA')).toBe(false);
    expect(channelAllows('STABLE', 'ALPHA')).toBe(false);
    expect(channelAllows('BETA', 'STABLE')).toBe(true);
    expect(channelAllows('BETA', 'ALPHA')).toBe(false);
    expect(channelAllows('ALPHA', 'BETA')).toBe(true);
  });
});

describe('the Java each version runs on (PRD §10, HST-01)', () => {
  it('uses the declared major when the image ships it, 17 for the older ones, and refuses the rest', () => {
    expect(SHIPPED_JRES).toEqual([25, 21, 17]);
    expect([25, 21, 17, 16, 8].map(jreFor)).toEqual([25, 21, 17, 17, 17]);
    for (const n of [11, 22, 26, 29]) expect(() => jreFor(n), String(n)).toThrow(`needs Java ${n}`);
    expect(javaBin(21)).toBe('/opt/java/21/bin/java');
  });

  it('covers every offered release in the measured Java matrix', () => {
    const matrix = JSON.parse(fixture('vanilla', 'api', 'java-matrix.json')) as { id: string; java: number; serverJar: boolean }[];
    const offered = matrix.filter((v) => v.serverJar && isOffered(v.id));
    expect(offered.map((v) => v.id)).toContain('1.16.5');
    for (const v of offered) expect(() => jreFor(v.java), v.id).not.toThrow();
    // The measured edges: 1.16.5 declares 8, 1.17.1 declares 16; both ran on 17.
    const java = Object.fromEntries(matrix.map((v) => [v.id, v.java]));
    expect([java['1.16.5'], java['1.17.1'], java['1.20.6'], java['26.3']]).toEqual([8, 16, 21, 25]);
  });
});
