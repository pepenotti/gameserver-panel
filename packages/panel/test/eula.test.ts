// A game's license the owner must accept (D6, PRD §7 "Minecraft EULA"): the
// panel asks the owner explicitly and never accepts on their behalf. `other`
// is a made-up game with an EULA, built on the PZ adapter; nothing about
// Project Zomboid changes.
import { describe, expect, it } from 'vitest';
import type { PanelAdapter } from '@gsp/adapter-api';
import { pzPanelAdapter } from '@gsp/adapter-pz/panel';
import type { LaunchEnvelope } from '@gsp/shared';
import { fakeStatus, friend, makePanel, ownerReady, until, type TestPanel } from './harness';

const other: PanelAdapter = {
  ...pzPanelAdapter,
  meta: {
    ...pzPanelAdapter.meta,
    id: 'other',
    capabilities: [...pzPanelAdapter.meta.capabilities, 'eula'],
    eula: { name: { en: 'Test Game EULA', es: 'EULA del juego de prueba' }, url: 'https://eula.example/terms' },
  },
};

interface Summary {
  id: string;
  eula: { name: { en: string }; url: string; acceptedAt: string | null; acceptedBy: string | null } | null;
}

async function panel() {
  const p = await makePanel({}, { adapters: [pzPanelAdapter, other] });
  const { client: owner } = await ownerReady(p);
  return { p, owner };
}

/** Every launch the server's agent was started with. */
function launches(p: TestPanel, id: string): LaunchEnvelope[] {
  const seen: LaunchEnvelope[] = [];
  p.fakes(id).agent.start = async (l?: LaunchEnvelope) => {
    if (l) seen.push(l);
    return fakeStatus();
  };
  return seen;
}

const summaryOf = async (c: { get(url: string): Promise<{ json(): unknown }> }, id: string) => ((await c.get('/api/servers')).json() as Summary[]).find((s) => s.id === id)!;

describe('the EULA (D6)', () => {
  it('names the agreement to whoever creates servers, and the owner accepts it by creating one: recorded, audited, told to the agent', async () => {
    const { p, owner } = await panel();
    const adapters = (await owner.get('/api/adapters')).json() as { adapters: { id: string; eula: boolean; agreement: unknown }[] };
    expect(adapters.adapters.find((a) => a.id === 'other')).toMatchObject({ eula: true, agreement: { url: 'https://eula.example/terms', name: { en: 'Test Game EULA' } } });
    expect(adapters.adapters.find((a) => a.id === 'pz')).toMatchObject({ eula: false, agreement: null });

    expect((await owner.post('/api/servers', { id: 'blocks', name: 'Blocks', adapter: 'other' })).json()).toEqual({ error: 'eula-required' });
    const r = await owner.post('/api/servers', { id: 'blocks', name: 'Blocks', adapter: 'other', eulaAccepted: true });
    expect(r.statusCode).toBe(200);
    expect((r.json() as Summary).eula).toEqual({ name: other.meta.eula!.name, url: 'https://eula.example/terms', acceptedAt: expect.stringMatching(/^\d{4}-/), acceptedBy: 'alice' });
    expect(p.deps.audit.list({ action: 'server.eula' })).toEqual([expect.objectContaining({ serverId: 'blocks', username: 'alice', actorType: 'user', ip: expect.any(String) })]);

    const seen = launches(p, 'blocks');
    expect((await owner.post('/api/servers/blocks/server/start')).statusCode).toBe(200);
    await until(() => seen.length > 0);
    expect(seen[0]).toMatchObject({ adapter: 'other', eulaAccepted: true });
  });

  it('lets anyone else create the server with the EULA waiting; nothing starts it until the owner accepts', async () => {
    const { p, owner } = await panel();
    const admin = await friend(p, owner, 'all-admin', 'admin');
    // Only the owner may accept, even when creating.
    expect((await admin.post('/api/servers', { id: 'blocks', name: 'Blocks', adapter: 'other', eulaAccepted: true })).json()).toEqual({ error: 'eula-owner-only' });
    const created = await admin.post('/api/servers', { id: 'blocks', name: 'Blocks', adapter: 'other' });
    expect(created.statusCode).toBe(200);
    expect((created.json() as Summary).eula).toMatchObject({ acceptedAt: null, acceptedBy: null });
    expect(p.deps.audit.list({ action: 'server.eula' })).toEqual([]);

    const seen = launches(p, 'blocks');
    expect(await admin.post('/api/servers/blocks/server/start')).toMatchObject({ statusCode: 409 });
    expect((await admin.post('/api/servers/blocks/server/start')).json()).toEqual({ error: 'eula-required' });
    expect((await admin.post('/api/servers/blocks/server/restart', {})).json()).toEqual({ error: 'eula-required' });
    // A start that doesn't come through the API (a schedule, a restore) is refused too.
    await expect(p.deps.servers.get('blocks')!.control.startAgent()).rejects.toMatchObject({ code: 'eula-required' });
    expect(seen).toEqual([]);

    // Accepting is the owner's alone; a server nobody granted them doesn't exist for them.
    const granted = await friend(p, owner, 'op-here', 'operator', { blocks: 'operator' });
    const elsewhere = await friend(p, owner, 'op-else', 'operator', null);
    expect((await admin.post('/api/servers/blocks/eula', { accept: true })).json()).toEqual({ error: 'forbidden' });
    expect((await granted.post('/api/servers/blocks/eula', { accept: true })).json()).toEqual({ error: 'forbidden' });
    expect((await elsewhere.post('/api/servers/blocks/eula', { accept: true })).statusCode).toBe(404);
    expect((await owner.post('/api/servers/blocks/eula', {})).statusCode).toBe(400);
    expect((await owner.post('/api/servers/blocks/eula', { accept: false })).statusCode).toBe(400);

    const accepted = await owner.post('/api/servers/blocks/eula', { accept: true });
    expect(accepted.statusCode).toBe(200);
    const eula = (accepted.json() as Summary).eula!;
    expect(eula).toMatchObject({ acceptedAt: expect.stringMatching(/^\d{4}-/), acceptedBy: 'alice' });
    expect(p.deps.serverRows.get('blocks')).toMatchObject({ eulaAcceptedAt: eula.acceptedAt, eulaAcceptedBy: p.deps.users.byName('alice')!.id });
    expect(p.deps.audit.list({ action: 'server.eula' })).toEqual([expect.objectContaining({ serverId: 'blocks', username: 'alice', target: 'Blocks', ip: expect.any(String) })]);
    // Everyone sees it accepted; accepting again changes nothing.
    expect((await summaryOf(admin, 'blocks')).eula).toEqual(eula);
    expect(((await owner.post('/api/servers/blocks/eula', { accept: true })).json() as Summary).eula).toEqual(eula);
    expect(p.deps.audit.list({ action: 'server.eula' })).toHaveLength(1);

    expect((await admin.post('/api/servers/blocks/server/start')).statusCode).toBe(200);
    await until(() => seen.length > 0);
    expect(seen[0]).toMatchObject({ adapter: 'other', eulaAccepted: true });
  });

  it('leaves games without an EULA as they were: no agreement, no acceptance, nothing new in the launch', async () => {
    const { p, owner } = await panel();
    expect((await summaryOf(owner, 'default')).eula).toBeNull();
    expect((await owner.post('/api/servers/default/eula', { accept: true })).json()).toEqual({ error: 'eula-not-needed' });
    const seen: LaunchEnvelope[] = [];
    p.agent.start = async (l?: LaunchEnvelope) => (l && seen.push(l), fakeStatus());
    expect((await owner.post('/api/servers/default/server/start')).statusCode).toBe(200);
    await until(() => seen.length > 0);
    expect(seen[0]!.adapter).toBe('pz');
    expect(seen[0]).not.toHaveProperty('eulaAccepted');
  });
});
