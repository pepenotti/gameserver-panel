// Nobody reaches a server they have no role on (ACC-02, M2 "cross-server
// permission tests"). Generated from the route table: every route of one
// server (`/api/servers/:sid…`), present and future, is asked for with the
// server swapped for one the user has no grant on, and must answer
// "server-not-found" without touching it; the websocket must carry nothing
// about that server either. Two servers of each kind: `default` (the one the
// environment describes) and `pz-two` (the orchestrator's).
import { describe, expect, it } from 'vitest';
import type { AgentEvent } from '@gsp/shared';
import type { RouteInfo } from '../src/app';
import { SERVER_PREFIX } from '../src/routes/scope';
import { fakeStatus, friend, listenWs, makePanel, ownerReady, until, type Client, type TestPanel } from './harness';

type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

/** Every route of one server, as registered. */
function serverRoutes(p: TestPanel): RouteInfo[] {
  return p.app.routeTable.filter((r) => r.method !== 'HEAD' && (r.url === SERVER_PREFIX || r.url.startsWith(`${SERVER_PREFIX}/`)));
}

/** The route's URL on `sid`, other parameters filled with something of the right shape. */
function urlOf(r: RouteInfo, sid: string): string {
  return r.url.replace(':sid', sid).replace(/:(\w+)/g, (_, name: string) => (name === 'id' ? '1' : `x-${name}`));
}

/** Every kind of agent event, and what the panel itself says about a server. */
function everything(p: TestPanel, sid: string, emit: (e: AgentEvent) => void): void {
  emit({ type: 'state', status: fakeStatus({ state: 'running' }) });
  emit({ type: 'log', stream: 'out', line: `secret line of ${sid}` });
  emit({ type: 'players', count: 1, names: ['rick'] });
  emit({ type: 'job', job: { id: 'j', kind: 'install', startedAt: '', progress: 5, message: 'installing' } });
  emit({ type: 'alert', kind: 'crash', message: 'boom' });
  p.deps.bus.emit({ type: 'op', serverId: sid, op: { id: 'o', kind: 'backup', startedAt: '', startedBy: 'x', step: 'archiving', countdownEndsAt: null, cancellable: false, progress: 1, done: false, ok: null, error: null } });
  p.deps.bus.emit({ type: 'notice', serverId: sid, kind: 'x', message: `about ${sid}`, permission: 'server.view' });
}

async function setup() {
  const p = await makePanel();
  const { client: owner } = await ownerReady(p);
  expect((await owner.post('/api/servers', { id: 'pz-two', name: 'Second', adapter: 'pz' })).statusCode).toBe(200);
  // Admins, so no permission check hides a missing server check; each of one server only.
  const onDefault = await friend(p, owner, 'default-admin', 'admin', { default: 'admin' });
  const onTwo = await friend(p, owner, 'two-admin', 'admin', { 'pz-two': 'admin' });
  return { p, owner, onDefault, onTwo };
}

describe('cross-server isolation (ACC-02), generated from the route table', () => {
  it('covers every route of a server', async () => {
    const { p } = await setup();
    const routes = serverRoutes(p);
    // A table that shrank would prove less: it only grows as routes are added.
    expect(routes.length).toBeGreaterThan(50);
    expect(routes.map((r) => `${r.method} ${r.url}`)).toEqual(expect.arrayContaining([`PATCH ${SERVER_PREFIX}`, `DELETE ${SERVER_PREFIX}`, `POST ${SERVER_PREFIX}/reset`, `GET ${SERVER_PREFIX}/notifications`]));
  });

  for (const [who, mine, theirs] of [
    ['an admin of default only', 'default', 'pz-two'],
    ['an admin of pz-two only', 'pz-two', 'default'],
  ] as const) {
    it(`answers ${who} "server-not-found" on every route of the other server, and touches nothing there`, async () => {
      const { p, onDefault, onTwo } = await setup();
      const user: Client = mine === 'default' ? onDefault : onTwo;
      const other = theirs === 'default' ? { agent: p.agent } : p.fakes('pz-two');
      const auditBefore = p.deps.audit.list({ serverId: theirs, limit: 500 }).length;
      const orchBefore = [...p.orch.calls];
      const leaks: string[] = [];
      for (const r of serverRoutes(p)) {
        for (const body of r.method === 'GET' ? [undefined] : [{}, { confirm: 'Second', role: 'admin', name: 'x' }]) {
          const res = await user.req(r.method as Method, urlOf(r, theirs), body);
          if (res.statusCode !== 404 || res.json<{ error: string }>().error !== 'server-not-found') leaks.push(`${r.method} ${r.url} → ${res.statusCode} ${res.body.slice(0, 80)}`);
        }
      }
      expect(leaks).toEqual([]);
      // Nothing reached the other server: no agent call, no orchestrator call, nothing audited there.
      expect(other.agent.calls).toEqual([]);
      expect(p.orch.calls).toEqual(orchBefore);
      expect(p.deps.audit.list({ serverId: theirs, limit: 500 })).toHaveLength(auditBefore);
      expect(p.deps.servers.get(theirs)).not.toBeNull();
    });

    it(`lets ${who} reach every route of their own server (the 404s above are the grant's doing)`, async () => {
      const { p, onDefault, onTwo } = await setup();
      const user: Client = mine === 'default' ? onDefault : onTwo;
      const missing: string[] = [];
      for (const r of serverRoutes(p)) {
        // Empty bodies: refused as invalid where one is needed, so nothing destructive runs.
        const res = await user.req(r.method as Method, urlOf(r, mine), r.method === 'GET' ? undefined : {});
        if (res.statusCode === 404 && res.json<{ error: string }>().error === 'server-not-found') missing.push(`${r.method} ${r.url}`);
        // One operation at a time per server: let what a route started finish.
        await p.deps.servers.get(mine)?.ops.idle();
      }
      expect(missing).toEqual([]);
    });
  }

  it('sends nobody a word about a server they have no role on over the websocket', async () => {
    const { p, owner, onDefault, onTwo } = await setup();
    const a = await listenWs(p, onDefault);
    const b = await listenWs(p, onTwo);
    const o = await listenWs(p, owner);
    everything(p, 'default', (e) => p.feed.emit(e));
    everything(p, 'pz-two', (e) => p.fakes('pz-two').feed.emit(e));
    // The owner sees both servers' messages: once those arrived, the others would have too.
    await until(() => o.messages.filter((m) => m.serverId === 'pz-two').length >= 7 && o.messages.filter((m) => m.serverId === 'default').length >= 7);
    const about = (ms: typeof a.messages, sid: string) => ms.filter((m) => m.serverId === sid || m.servers?.some((s) => s.serverId === sid) || JSON.stringify(m).includes(`of ${sid}`) || JSON.stringify(m).includes(`about ${sid}`));
    expect(about(a.messages, 'pz-two')).toEqual([]);
    expect(about(b.messages, 'default')).toEqual([]);
    // And each saw its own server's (non-vacuous).
    expect(about(a.messages, 'default').length).toBeGreaterThanOrEqual(7);
    expect(about(b.messages, 'pz-two').length).toBeGreaterThanOrEqual(7);
    a.ws.terminate();
    b.ws.terminate();
    o.ws.terminate();
  });
});
