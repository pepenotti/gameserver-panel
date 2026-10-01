// What the panel does for the adapter contract's M6 additions (D4):
// - SRV-01: a port that follows another (`PortDecl.follows`) is never asked
//   for; it is allocated with the port it follows (conflicts and the host's
//   ranges checked for it too), stored with the server and published the
//   same way in the orchestrator's spec;
// - CFG-01, UX-01: a launch setting an adapter refuses with a worded
//   refusal (`LaunchSettingRefusal`) is answered with its key and EN/ES text.
import { describe, expect, it } from 'vitest';
import type { PanelAdapter, PortDecl } from '@gsp/adapter-api';
import { pzPanelAdapter } from '@gsp/adapter-pz/panel';
import { userActor, type Actor } from '../src/audit';
import type { CreateServerInput } from '../src/servers/registry';
import { buildSpec, planPorts, type TakenPort } from '../src/servers/spec';
import type { ServerRow } from '../src/servers/store';
import { launchRefusal } from '../src/routes/server';
import { makePanel, ownerReady, type TestPanel } from './harness';

const OWNER_ACTOR: Actor = userActor({ id: 1, username: 'alice' });
const label = (en: string) => ({ en, es: en });

/** A Steam game whose query port is always its game port + 1, and whose game port is both UDP and TCP. */
const PORTS: PortDecl[] = [
  { id: 'game', proto: 'udp', default: 2456, publish: true, sameInsideOut: true, label: label('Game') },
  { id: 'query', proto: 'udp', default: 2457, publish: true, sameInsideOut: true, follows: { id: 'game', offset: 1 }, label: label('Query') },
  { id: 'gametcp', proto: 'tcp', default: 2456, publish: true, sameInsideOut: true, follows: { id: 'game', offset: 0 }, label: label('Game (TCP)') },
  { id: 'rcon', proto: 'tcp', default: 27015, publish: false, sameInsideOut: false, label: label('RCON') },
];

/** Refuses a launch setting the way a manifest's rules do: worded, with the key. */
function refuse(field: string, en: string, es: string): never {
  throw Object.assign(new Error(en), { field, text: { en, es } });
}

const following: PanelAdapter = {
  ...pzPanelAdapter,
  meta: { ...pzPanelAdapter.meta, id: 'following', ports: PORTS },
  launch: {
    ...pzPanelAdapter.launch,
    toAgent: (srv, s, secrets, o) => {
      const v = s as { branch: string };
      if (v.branch === 'refused') refuse('branch', 'That branch is not offered.', 'Esa rama no se ofrece.');
      return pzPanelAdapter.launch.toAgent(srv, s as Parameters<typeof pzPanelAdapter.launch.toAgent>[1], secrets, o);
    },
  },
};

function create(p: TestPanel, over: Partial<CreateServerInput> = {}) {
  return p.deps.servers.create({ id: 'vh-one', name: 'One', adapter: 'following', by: OWNER_ACTOR, ...over });
}

async function refusal(p: Promise<unknown>): Promise<{ status: number; code: string; extra?: Record<string, unknown> }> {
  try {
    await p;
  } catch (e) {
    const err = e as { statusCode: number; code: string; extra?: Record<string, unknown> };
    return { status: err.statusCode, code: err.code, extra: err.extra };
  }
  throw new Error('expected a refusal');
}

describe('ports that follow another (SRV-01, PortDecl.follows)', () => {
  const taken = (...ports: [number, 'tcp' | 'udp'][]): TakenPort[] => ports.map(([port, proto]) => ({ port, proto, by: 'other' }));

  it('come with the port they follow, near the defaults and past taken ports', () => {
    expect(planPorts(following, undefined, [])).toEqual({ game: 2456, query: 2457, gametcp: 2456 });
    // The whole block shifts when one of the following ports is taken.
    expect(planPorts(following, undefined, taken([2457, 'udp']))).toEqual({ game: 2458, query: 2459, gametcp: 2458 });
    expect(planPorts(following, undefined, taken([2456, 'tcp']))).toEqual({ game: 2458, query: 2459, gametcp: 2458 });
    // Only where the host lets servers publish.
    expect(planPorts(following, undefined, [], [{ from: 30550, to: 30599 }])).toEqual({ game: 30550, query: 30551, gametcp: 30550 });
  });

  it('follow a port that was asked for, and refuse it when one of them can not be had', () => {
    expect(planPorts(following, { game: 30560 }, [], [{ from: 30550, to: 30599 }])).toEqual({ game: 30560, query: 30561, gametcp: 30560 });
    const at = (f: () => unknown) => {
      try {
        f();
      } catch (e) {
        const err = e as { statusCode: number; code: string; extra?: Record<string, unknown> };
        return { status: err.statusCode, code: err.code, extra: err.extra };
      }
      throw new Error('expected a refusal');
    };
    // A following port is never asked for.
    expect(at(() => planPorts(following, { query: 30561 }, []))).toMatchObject({ status: 400, code: 'unknown-port', extra: { port: 'query' } });
    // Taken by another server: the conflict names it.
    expect(at(() => planPorts(following, { game: 30560 }, taken([30561, 'udp'])))).toMatchObject({ status: 409, code: 'port-conflict', extra: { port: 30561, proto: 'udp', with: 'other' } });
    expect(at(() => planPorts(following, { game: 30560 }, taken([30560, 'tcp'])))).toMatchObject({ status: 409, code: 'port-conflict', extra: { port: 30560, proto: 'tcp' } });
    // Past the host's ranges: the port asked for is refused, with the ranges.
    expect(at(() => planPorts(following, { game: 30599 }, [], [{ from: 30550, to: 30599 }]))).toMatchObject({ status: 400, code: 'invalid-port', extra: { port: 'game', ranges: '30550-30599' } });
  });

  it('are stored with the server and published like the port they follow', async () => {
    const p = await makePanel({}, { adapters: [pzPanelAdapter, following] });
    p.orch.hostPorts = [{ from: 30550, to: 30599 }];
    await create(p);
    await create(p, { id: 'vh-two', name: 'Two' });
    expect(p.deps.serverRows.get('vh-one')!.ports).toEqual({ game: 30550, query: 30551, gametcp: 30550 });
    expect(p.deps.serverRows.get('vh-two')!.ports).toEqual({ game: 30552, query: 30553, gametcp: 30552 });
    const spec = p.orch.containers.get('vh-two')!.spec;
    expect(spec.ports).toEqual([
      { container: 30552, host: 30552, proto: 'udp' },
      { container: 30553, host: 30553, proto: 'udp' },
      { container: 30552, host: 30552, proto: 'tcp' },
    ]);
    expect(spec.env).toMatchObject({ GAME_PORT_GAME: '30552', GAME_PORT_QUERY: '30553', GAME_PORT_GAMETCP: '30552' });
    // The listing shows every published port.
    const { client } = await ownerReady(p);
    const listed = ((await client.get('/api/servers')).json() as { id: string; ports: { id: string; port: number; proto: string }[] }[]).find((s) => s.id === 'vh-two')!;
    expect(listed.ports).toEqual([
      { id: 'game', port: 30552, proto: 'udp' },
      { id: 'query', port: 30553, proto: 'udp' },
      { id: 'gametcp', port: 30552, proto: 'tcp' },
    ]);
  });

  it('come from their base in a spec of a row stored before they were declared', () => {
    const row = { id: 'old', adapter: 'following', flavour: null, ports: { game: 30570 }, memLimitMb: 1024, cpus: null } as unknown as ServerRow;
    expect(buildSpec(row, following, { agentToken: 't', tz: 'UTC' }).ports).toEqual([
      { container: 30570, host: 30570, proto: 'udp' },
      { container: 30571, host: 30571, proto: 'udp' },
      { container: 30570, host: 30570, proto: 'tcp' },
    ]);
  });
});

describe("a game's notes (UX-04, AdapterMeta.notes)", () => {
  it('reach the create form and the pages of each server of it', async () => {
    const noted: PanelAdapter = { ...following, meta: { ...following.meta, notes: [{ id: 'no-console', text: { en: 'No console.', es: 'Sin consola.' }, doc: 'limitations.md#host' }] } };
    const p = await makePanel({}, { adapters: [pzPanelAdapter, noted] });
    const { client } = await ownerReady(p);
    const games = ((await client.get('/api/adapters')).json() as { adapters: { id: string; notes: unknown[] }[] }).adapters;
    expect(games.find((a) => a.id === 'following')!.notes).toEqual([{ id: 'no-console', text: { en: 'No console.', es: 'Sin consola.' }, doc: 'limitations.md#host' }]);
    expect(games.find((a) => a.id === 'pz')!.notes).toEqual([]);
    await create(p);
    const meta = (await client.get('/api/servers/vh-one/meta')).json() as { adapter: { notes: unknown[] } };
    expect(meta.adapter.notes).toEqual([{ id: 'no-console', text: { en: 'No console.', es: 'Sin consola.' }, doc: 'limitations.md#host' }]);
  });
});

describe('launch settings an adapter refuses in its own words (CFG-01, UX-01)', () => {
  it('reads a worded refusal, and nothing else, as one', () => {
    expect(launchRefusal(Object.assign(new Error('x'), { field: 'password', text: { en: 'Too short.', es: 'Muy corta.' } }))).toEqual({ field: 'password', text: { en: 'Too short.', es: 'Muy corta.' } });
    for (const e of [new Error('plain'), Object.assign(new Error('x'), { field: 'a' }), Object.assign(new Error('x'), { field: 'a', text: 'Too short.' }), { field: 'a', text: { en: 'x', es: 'x' } }, null]) expect(launchRefusal(e)).toBeNull();
  });

  it('answers a create and a change with the setting and its EN/ES text', async () => {
    const p = await makePanel({}, { adapters: [pzPanelAdapter, following] });
    expect(await refusal(create(p, { launch: { branch: 'refused' } }))).toMatchObject({
      status: 400,
      code: 'invalid-options',
      extra: { field: 'branch', text: { en: 'That branch is not offered.', es: 'Esa rama no se ofrece.' }, message: 'That branch is not offered.' },
    });
    await create(p);
    const { client } = await ownerReady(p);
    const r = await client.req('PUT', '/api/servers/vh-one/server/launch', { memoryMb: 4096, branch: 'refused', updateOnStart: true });
    expect(r.statusCode).toBe(400);
    expect(r.json()).toMatchObject({ error: 'validation', field: 'branch', text: { en: 'That branch is not offered.', es: 'Esa rama no se ofrece.' } });
    // Any other refusal stays as it was.
    const plain = await client.req('PUT', '/api/servers/vh-one/server/launch', { memoryMb: 4096, branch: 'bad branch!', updateOnStart: true });
    expect(plain.statusCode).toBe(400);
    expect(plain.json()).toEqual({ error: 'validation' });
  });
});
