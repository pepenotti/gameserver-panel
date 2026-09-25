import type { ServerSpec } from '@gsp/shared';
import { describe, expect, it } from 'vitest';
import { imageName } from '../src/derive';
import { OrchError } from '../src/errors';
import { canonicalJson, specHash } from '../src/hash';
import { parsePortRanges } from '../src/policy';
import { parseEmpty, parseSpec, parseStop } from '../src/spec';
import { policy, spec } from './helpers';

/** The error `fn` throws, as the API would answer it. */
function answer(fn: () => unknown): { code: string; field?: string; status: number } {
  try {
    fn();
  } catch (e) {
    if (e instanceof OrchError) return { code: e.code, field: e.field, status: e.status };
    throw e;
  }
  throw new Error('expected a refusal, got none');
}

const parse = (body: unknown, id = 'pz') => parseSpec(body, id, policy);
const withEnv = (env: Record<string, unknown>) => ({ ...spec(), env: { ...spec().env, ...env } });

describe('a well-formed spec (NFR-02)', () => {
  it('is accepted as sent, and nothing else is added', () => {
    expect(parse(JSON.parse(JSON.stringify(spec())))).toEqual(spec());
    const minimal = { id: 'mc-1', runtime: 'java', env: { AGENT_TOKEN: 'x'.repeat(32), GAME_ADAPTER: 'mc', TZ: 'UTC' }, ports: [], memoryMb: 128 };
    expect(parse(minimal, 'mc-1')).toEqual(minimal);
    expect(parse({ ...spec(), cpus: 1.5 })).toMatchObject({ cpus: 1.5 });
  });
});

describe('refusals (NFR-02, D3)', () => {
  it('refuses every key the contract does not have: no privileges, host mounts, host network, capabilities, devices or images from the caller', () => {
    for (const key of ['privileged', 'Privileged', 'binds', 'Binds', 'mounts', 'volumes', 'networkMode', 'network', 'hostNetwork', 'capAdd', 'CapAdd', 'devices', 'image', 'Image', 'user', 'labels', 'Labels', 'securityOpt', 'hostConfig', 'HostConfig', 'pidMode', 'ipcMode', 'readOnly', 'name', '__proto__', 'constructor']) {
      const body = { ...spec(), [key]: key === 'privileged' ? true : 'x' };
      if (key === '__proto__') Object.defineProperty(body, '__proto__', { value: 'x', enumerable: true });
      expect(answer(() => parse(body)), key).toEqual({ code: 'refused', field: key, status: 403 });
    }
    // Inside a port mapping too: no host address or range from the caller.
    for (const key of ['hostIp', 'HostIp', 'range']) {
      const body = { ...spec(), ports: [{ container: 30161, host: 30161, proto: 'udp', [key]: '0.0.0.0' }] };
      expect(answer(() => parse(body)), key).toEqual({ code: 'refused', field: `ports[0].${key}`, status: 403 });
    }
  });

  it('refuses runtimes and image variants outside the allowlist, and fake images unless allowed', () => {
    expect(answer(() => parse({ ...spec(), runtime: 'docker' }))).toMatchObject({ code: 'refused', field: 'runtime' });
    expect(answer(() => parse({ ...spec(), runtime: 'Steam' }))).toMatchObject({ code: 'refused', field: 'runtime' });
    for (const variant of ['alpine', 'latest', 'constructor', 'tostring', 'hasownproperty']) {
      expect(answer(() => parse({ ...spec(), variant })), variant).toMatchObject({ code: 'refused', field: 'variant' });
    }
    for (const variant of ['../x', 'gsp/steam:latest', 'Fake', '', 42]) {
      expect(answer(() => parse({ ...spec(), variant })), String(variant)).toMatchObject({ code: 'bad-request', field: 'variant' });
    }
    expect(answer(() => parseSpec(spec(), 'pz', { ...policy, allowFake: false }))).toMatchObject({ code: 'refused', field: 'variant' });
    const { variant: _, ...plain } = spec();
    expect(parseSpec(plain, 'pz', { ...policy, allowFake: false })).toEqual(plain);
    expect(imageName('steam', undefined, false)).toBe('steam');
    expect(imageName('steam', 'fake', true)).toBe('steam-fake');
  });

  it('refuses environment keys outside AGENT_TOKEN, GAME_ADAPTER, GAME_FLAVOUR, TZ, GAME_* and GSP_*, and the ones the image owns', () => {
    for (const key of ['PATH', 'LD_PRELOAD', 'NODE_OPTIONS', 'HOME', 'AGENT_PORT', 'AGENT_HOST', 'AGENT_STATE_DIR', 'STEAMCMD_COMMAND', 'PZ_START_COMMAND', 'GAME_DATA_DIR', 'GAME_INSTALL_DIR', 'GAME_START_COMMAND', 'game_port', 'GAME_', 'GAME__X', 'GSP-X', 'TZ ', ' GAME_X', 'GAME_X\n']) {
      const field = /^[\x21-\x7e]+$/.test(key) ? `env.${key}` : 'env.?';
      expect(answer(() => parse(withEnv({ [key]: '1' }))), key).toEqual({ code: 'refused', field, status: 403 });
    }
    const proto = withEnv({});
    Object.defineProperty(proto.env, '__proto__', { value: '1', enumerable: true });
    expect(answer(() => parse(proto))).toMatchObject({ code: 'refused', field: 'env.__proto__' });
    expect(answer(() => parse(withEnv(Object.fromEntries(Array.from({ length: 62 }, (_, i) => [`GSP_K${i}`, 'v'])))))).toMatchObject({ code: 'refused', field: 'env' });
  });

  it('refuses environment values that could inject lines, and malformed ones', () => {
    for (const value of ['a\nPATH=/tmp', 'a\rb', 'a\0b', 'x'.repeat(4097)]) {
      expect(answer(() => parse(withEnv({ GAME_X: value }))), JSON.stringify(value.slice(0, 12))).toEqual({ code: 'refused', field: 'env.GAME_X', status: 403 });
    }
    expect(answer(() => parse(withEnv({ TZ: 'Europe/Madrid\nX=1' })))).toMatchObject({ code: 'refused', field: 'env.TZ' });
    expect(answer(() => parse(withEnv({ GAME_X: 1 })))).toMatchObject({ code: 'bad-request', field: 'env.GAME_X' });
    expect(answer(() => parse(withEnv({ GAME_X: null })))).toMatchObject({ code: 'bad-request', field: 'env.GAME_X' });
    expect(answer(() => parse(withEnv({ AGENT_TOKEN: 'short' })))).toMatchObject({ code: 'bad-request', field: 'env.AGENT_TOKEN' });
    expect(answer(() => parse(withEnv({ AGENT_TOKEN: 'x'.repeat(31) + ' ' })))).toMatchObject({ code: 'bad-request', field: 'env.AGENT_TOKEN' });
    expect(answer(() => parse(withEnv({ GAME_ADAPTER: '../pz' })))).toMatchObject({ code: 'bad-request', field: 'env.GAME_ADAPTER' });
    expect(answer(() => parse(withEnv({ GAME_FLAVOUR: 'B42 unstable' })))).toMatchObject({ code: 'bad-request', field: 'env.GAME_FLAVOUR' });
    expect(answer(() => parse(withEnv({ TZ: '../../etc/passwd' })))).toMatchObject({ code: 'bad-request', field: 'env.TZ' });
    const { TZ: _, ...noTz } = spec().env;
    expect(answer(() => parse({ ...spec(), env: noTz }))).toMatchObject({ code: 'bad-request', field: 'env.TZ' });
    expect(answer(() => parse({ ...spec(), env: [] }))).toMatchObject({ code: 'bad-request', field: 'env' });
  });

  it('refuses privileged host ports, ports outside ORCH_HOST_PORTS and publishing the agent', () => {
    const ports = (...p: unknown[]) => ({ ...spec(), ports: p });
    expect(answer(() => parse(ports({ container: 80, host: 80, proto: 'tcp' })))).toEqual({ code: 'refused', field: 'ports[0].host', status: 403 });
    expect(answer(() => parse(ports({ container: 1023, host: 1023, proto: 'udp' })))).toMatchObject({ code: 'refused', field: 'ports[0].host' });
    expect(answer(() => parse(ports({ container: 16261, host: 16261, proto: 'udp' })))).toMatchObject({ code: 'refused', field: 'ports[0].host' });
    expect(answer(() => parse(ports({ container: 30150, host: 30150, proto: 'udp' }, { container: 30200, host: 30200, proto: 'udp' })))).toMatchObject({ code: 'refused', field: 'ports[1].host' });
    expect(answer(() => parse(ports({ container: 8081, host: 30150, proto: 'tcp' })))).toMatchObject({ code: 'refused', field: 'ports[0].container' });
    expect(parse(ports({ container: 8081, host: 30150, proto: 'udp' })).ports).toHaveLength(1);
    expect(answer(() => parse(ports(...Array.from({ length: 17 }, (_, i) => ({ container: 30150 + i, host: 30150 + i, proto: 'tcp' })))))).toMatchObject({ code: 'refused', field: 'ports' });
  });

  it('checks port mappings strictly', () => {
    const ports = (...p: unknown[]) => ({ ...spec(), ports: p });
    expect(answer(() => parse(ports({ container: 30150, host: 30150, proto: 'udp' }, { container: 30151, host: 30150, proto: 'udp' })))).toMatchObject({ code: 'bad-request', field: 'ports[1].host' });
    expect(answer(() => parse(ports({ container: 30150, host: 30150, proto: 'udp' }, { container: 30150, host: 30151, proto: 'udp' })))).toMatchObject({ code: 'bad-request', field: 'ports[1].container' });
    // The same number on both protocols is two ports.
    expect(parse(ports({ container: 30150, host: 30150, proto: 'udp' }, { container: 30150, host: 30150, proto: 'tcp' })).ports).toHaveLength(2);
    expect(answer(() => parse(ports({ container: 30150, host: 30150, proto: 'sctp' })))).toMatchObject({ code: 'bad-request', field: 'ports[0].proto' });
    expect(answer(() => parse(ports({ container: 0, host: 30150, proto: 'tcp' })))).toMatchObject({ code: 'bad-request', field: 'ports[0].container' });
    expect(answer(() => parse(ports({ container: 30150, host: 30150.5, proto: 'tcp' })))).toMatchObject({ code: 'bad-request', field: 'ports[0].host' });
    expect(answer(() => parse(ports({ container: 30150, host: '30150', proto: 'tcp' })))).toMatchObject({ code: 'bad-request', field: 'ports[0].host' });
    expect(answer(() => parse(ports('30150:30150')))).toMatchObject({ code: 'bad-request', field: 'ports[0]' });
    expect(answer(() => parse({ ...spec(), ports: { a: 1 } }))).toMatchObject({ code: 'bad-request', field: 'ports' });
  });

  it('refuses memory above ORCH_MAX_MEM_MB and malformed limits', () => {
    expect(answer(() => parse({ ...spec(), memoryMb: 4097 }))).toEqual({ code: 'refused', field: 'memoryMb', status: 403 });
    expect(parse({ ...spec(), memoryMb: 4096 }).memoryMb).toBe(4096);
    for (const memoryMb of [127, 0, -1, 2048.5, '2048', null]) expect(answer(() => parse({ ...spec(), memoryMb })), String(memoryMb)).toMatchObject({ code: 'bad-request', field: 'memoryMb' });
    for (const cpus of [0, -1, 2000, '2', null, Number.NaN]) expect(answer(() => parse({ ...spec(), cpus })), String(cpus)).toMatchObject({ code: 'bad-request', field: 'cpus' });
  });

  it('holds the id to the contract and to the path: no traversal, upper case or long ids', () => {
    for (const id of ['../pz', 'pz/..', 'Pz', 'PZ', 'a'.repeat(25), 'p', '-pz', 'pz_2', 'pz%2F', '']) {
      expect(answer(() => parse({ ...spec(), id }, id)), id).toMatchObject({ code: 'bad-request', field: 'id' });
    }
    expect(answer(() => parse(spec(), 'other'))).toMatchObject({ code: 'bad-request', field: 'id' });
    expect(answer(() => parse([spec()]))).toMatchObject({ code: 'bad-request' });
    expect(answer(() => parse(null))).toMatchObject({ code: 'bad-request' });
  });
});

describe('stop and start bodies', () => {
  it('takes timeoutSec 0-600 and nothing else', () => {
    expect(parseStop(undefined)).toEqual({});
    expect(parseStop({})).toEqual({});
    expect(parseStop({ timeoutSec: 600 })).toEqual({ timeoutSec: 600 });
    for (const bad of [{ timeoutSec: 601 }, { timeoutSec: -1 }, { timeoutSec: 1.5 }, { timeoutSec: '5' }, { signal: 'KILL' }, [], 'x']) {
      expect(answer(() => parseStop(bad)), JSON.stringify(bad)).toMatchObject({ code: 'bad-request' });
    }
    expect(() => parseEmpty(undefined)).not.toThrow();
    expect(() => parseEmpty({})).not.toThrow();
    expect(answer(() => parseEmpty({ image: 'x' }))).toMatchObject({ code: 'bad-request' });
  });
});

describe('spec hash', () => {
  it('is the sha256 of the canonical JSON: key order does not matter, values do', () => {
    const a = spec();
    const b = JSON.parse(canonicalJson(a)) as ServerSpec;
    const reordered: ServerSpec = { memoryMb: a.memoryMb, ports: a.ports, env: { TZ: a.env.TZ, GAME_ADAPTER: a.env.GAME_ADAPTER, AGENT_TOKEN: a.env.AGENT_TOKEN, GAME_PORT_UDP: '30162', GAME_PORT_GAME: '30161' }, variant: 'fake', runtime: 'steam', id: 'pz' };
    expect(specHash(reordered)).toBe(specHash(a));
    expect(specHash(b)).toBe(specHash(a));
    expect(specHash(a)).toMatch(/^[0-9a-f]{64}$/);
    expect(specHash({ ...a, memoryMb: 2049 })).not.toBe(specHash(a));
    expect(canonicalJson({ b: 1, a: [2, { d: undefined, c: 'x' }] })).toBe('{"a":[2,{"c":"x"}],"b":1}');
  });
});

describe('ORCH_HOST_PORTS', () => {
  it('parses ports and ranges, all unprivileged', () => {
    expect(parsePortRanges('30150-30199')).toEqual([[30150, 30199]]);
    expect(parsePortRanges('2456-2499, 16261 ,25565-25599')).toEqual([
      [2456, 2499],
      [16261, 16261],
      [25565, 25599],
    ]);
    for (const bad of ['', '80-90', '1000-2000', '30199-30150', '30150-70000', 'x', '30150-', '-1']) expect(() => parsePortRanges(bad), bad).toThrow();
  });
});
