// Connection info (SRV-08) and the host's addresses (HST-08), through the
// API with the harness's fakes: who sees what (the password only for those
// who may manage the server, and only when they ask), each game's join
// format, port and router forwards, the steps that apply now, the addresses
// left unset, the DuckDNS name as the default public address, the address
// rules, and "Detect" against a fake service (never the real one).
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { ConnectionInfo, DetectedAddress, HostAddressView } from '@gsp/shared';
import { panelAdapter, panelAdapterEntries } from '@gsp/adapters/panel';
import { DETECT_SERVICE } from '../src/host/address';
import { fakeStatus, friend, makePanel, ORIGIN, ownerReady, type Client, type TestPanel } from './harness';

type Json = Record<string, unknown>;

async function setup(envOver: Parameters<typeof makePanel>[0] = {}, opts: Parameters<typeof makePanel>[1] = {}) {
  const p = await makePanel(envOver, opts);
  const { client: owner } = await ownerReady(p);
  return { p, owner };
}

const info = async (c: Client, sid: string, q = ''): Promise<ConnectionInfo> => {
  const r = await c.get(`/api/servers/${sid}/connection${q}`);
  expect(r.statusCode, r.body).toBe(200);
  return r.json<ConnectionInfo>();
};

/** The default server's ini (Project Zomboid's `Server/<name>.ini`), written where its files are. */
function writeIni(p: TestPanel, text: string): void {
  const dir = path.join(p.deps.env.pzDataDir, 'Server');
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, `${p.deps.env.serverName}.ini`), text);
}

/** A file in an orchestrator-run server's data folder. */
function writeData(p: TestPanel, sid: string, rel: string, text: string): void {
  const file = path.join(p.fakes(sid).dataDir, ...rel.split('/'));
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, text);
}

/** A fake address service: what it answers, and every request it got. */
function fakeService(answer: () => Response | Promise<Response>) {
  const calls: { url: string; init: RequestInit | undefined }[] = [];
  const f = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    return answer();
  }) as unknown as typeof fetch;
  return { fetch: f, calls };
}

describe('the host address (HST-08)', () => {
  it('starts unset without DuckDNS, and only the owner reads or changes it', async () => {
    const { p, owner } = await setup();
    const view = (await owner.get('/api/host/address')).json<HostAddressView>();
    expect(view).toEqual({ public: null, publicSource: 'none', home: null, homeSource: 'none', defaults: { public: null, home: null }, detectService: DETECT_SERVICE });
    const admin = await friend(p, owner, 'bob', 'admin');
    expect((await admin.get('/api/host/address')).statusCode).toBe(403);
    expect((await admin.req('PUT', '/api/host/address', { public: 'example.duckdns.org', home: null })).statusCode).toBe(403);
    expect((await admin.post('/api/host/address/detect')).statusCode).toBe(403);
  });

  it("defaults to the DuckDNS name the panel uses for HTTPS, and to its home-network address (LAN_IP)", async () => {
    const { owner } = await setup({ origins: [ORIGIN, 'https://example.duckdns.org:8443', 'https://192.168.1.50:8443', 'https://localhost:8443'] });
    expect((await owner.get('/api/host/address')).json<HostAddressView>()).toMatchObject({
      public: 'example.duckdns.org',
      publicSource: 'duckdns',
      home: '192.168.1.50',
      homeSource: 'lan',
      defaults: { public: 'example.duckdns.org', home: '192.168.1.50' },
    });
    // DUCKDNS_SUBDOMAIN, when the environment names it, wins over the origins.
    const named = await setup({ duckdnsSubdomain: 'my-zomboid', origins: [ORIGIN, 'https://127.0.0.1:8443'] });
    expect((await named.owner.get('/api/host/address')).json<HostAddressView>()).toMatchObject({ public: 'my-zomboid.duckdns.org', publicSource: 'duckdns', home: null, homeSource: 'none' });
  });

  it('takes a DNS name or an IP address, refuses a scheme, a port or a path, and goes back to the default when cleared; every change is audited', async () => {
    const { p, owner } = await setup({ origins: [ORIGIN, 'https://example.duckdns.org:8443'] });
    const put = (body: Json) => owner.req('PUT', '/api/host/address', body);
    for (const [value, problem] of [
      ['https://203.0.113.7', 'scheme'],
      ['example.org:27015', 'port'],
      ['example.org/join', 'path'],
      ['not an address', 'invalid'],
    ] as const) {
      const r = await put({ public: value, home: null });
      expect(r.statusCode, value).toBe(400);
      expect(r.json()).toMatchObject({ error: 'invalid-address', field: 'public', problem });
    }
    expect((await put({ public: null, home: '192.168.1.500' })).json()).toMatchObject({ error: 'invalid-address', field: 'home', problem: 'invalid' });
    expect((await put({ public: 'x' })).statusCode).toBe(400);

    const saved = (await put({ public: ' Friends.Example.org ', home: '[2001:db8::5]' })).json<HostAddressView>();
    expect(saved).toMatchObject({ public: 'friends.example.org', publicSource: 'set', home: '2001:db8::5', homeSource: 'set' });
    expect((await owner.get('/api/host/address')).json<HostAddressView>()).toMatchObject({ public: 'friends.example.org', home: '2001:db8::5' });
    // Cleared: the default again.
    expect((await put({ public: '', home: null })).json<HostAddressView>()).toMatchObject({ public: 'example.duckdns.org', publicSource: 'duckdns', home: null, homeSource: 'none' });
    const entries = p.deps.audit.list({ limit: 20 }).filter((e) => e.action === 'host.address.update');
    expect(entries).toHaveLength(2);
    expect(entries.every((e) => e.serverId === null && e.ok)).toBe(true);
  });

  it('Detect asks the one fixed service over HTTPS, with nothing but the request, and saves nothing; audited (NFR-09)', async () => {
    const svc = fakeService(() => new Response('203.0.113.7\n', { status: 200 }));
    const { p, owner } = await setup({}, { detect: svc.fetch });
    expect(svc.calls).toEqual([]);
    const r = await owner.post('/api/host/address/detect');
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json<DetectedAddress>()).toEqual({ address: '203.0.113.7', service: DETECT_SERVICE });
    expect(svc.calls).toHaveLength(1);
    expect(DETECT_SERVICE.startsWith('https://')).toBe(true);
    const { url, init } = svc.calls[0]!;
    expect(url).toBe(DETECT_SERVICE);
    // A plain GET: no body, no headers of ours, no redirect followed elsewhere, a deadline.
    expect(init).toMatchObject({ method: 'GET', redirect: 'error' });
    expect(init?.body).toBeUndefined();
    expect(init?.headers).toBeUndefined();
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    // Nothing saved: the owner decides.
    expect((await owner.get('/api/host/address')).json<HostAddressView>()).toMatchObject({ public: null, publicSource: 'none' });
    expect(p.deps.audit.list({ limit: 5 }).find((e) => e.action === 'host.address.detect')).toMatchObject({ ok: true, serverId: null });
  });

  it('Detect says so when the service fails or answers something else, and audits that too', async () => {
    for (const [answer, reason] of [
      [() => Promise.reject(new TypeError('fetch failed')), 'unreachable'],
      [() => new Response('nope', { status: 503 }), 'status 503'],
      [() => new Response('<html>not an address</html>', { status: 200 }), 'not an address'],
    ] as const) {
      const svc = fakeService(answer as () => Response);
      const { p, owner } = await setup({}, { detect: svc.fetch });
      const r = await owner.post('/api/host/address/detect');
      expect(r.statusCode, reason).toBe(502);
      expect(r.json()).toMatchObject({ error: 'detect-failed', reason });
      expect(p.deps.audit.list({ limit: 5 }).find((e) => e.action === 'host.address.detect')).toMatchObject({ ok: false });
    }
    // The harness's default reaches no network at all.
    const { owner } = await setup();
    expect((await owner.post('/api/host/address/detect')).json()).toMatchObject({ error: 'detect-failed', reason: 'unreachable' });
  });
});

describe('connection info (SRV-08)', () => {
  it('everyone who sees the server gets it; the password only for those who manage it, only when asked, audited', async () => {
    const { p, owner } = await setup();
    writeIni(p, 'Password=hunter-22\nOpen=true\n');
    const viewer = await friend(p, owner, 'vera', 'viewer', 'viewer');
    const operator = await friend(p, owner, 'otto', 'operator', 'operator');
    const admin = await friend(p, owner, 'ada', 'admin', 'admin');
    const stranger = await friend(p, owner, 'sam', 'viewer', null);

    for (const c of [viewer, operator]) {
      const i = await info(c, 'default');
      expect(i.password).toEqual({ game: true, set: true, value: null, canInclude: false });
      expect((await c.get('/api/servers/default/connection?password=1')).statusCode).toBe(403);
    }
    expect((await stranger.get('/api/servers/default/connection')).json()).toMatchObject({ error: 'server-not-found' });
    for (const c of [admin, owner]) {
      expect((await info(c, 'default')).password).toEqual({ game: true, set: true, value: null, canInclude: true });
      expect((await info(c, 'default', '?password=1')).password).toEqual({ game: true, set: true, value: 'hunter-22', canInclude: true });
    }
    const audited = p.deps.audit.list({ limit: 50 }).filter((e) => e.action === 'server.connection.password');
    expect(audited).toHaveLength(2);
    expect(audited.every((e) => e.serverId === 'default')).toBe(true);
    // The audit log says who saw it, never what it is.
    expect(JSON.stringify(audited)).not.toContain('hunter-22');
    expect((await owner.get('/api/servers/default/connection?password=yes')).statusCode).toBe(400);
  });

  it('a game whose password is empty, or not written yet, says none is set', async () => {
    const { p, owner } = await setup();
    expect((await info(owner, 'default', '?password=1')).password).toEqual({ game: true, set: false, value: null, canInclude: true });
    writeIni(p, 'Password=\n');
    expect((await info(owner, 'default')).password.set).toBe(false);
  });

  it('lists this PC, then the home network and the internet as unset, saying who may set the public address', async () => {
    const { p, owner } = await setup();
    const i = await info(owner, 'default');
    expect(i.places).toEqual([
      { place: 'pc', address: '127.0.0.1', text: '127.0.0.1' },
      { place: 'home', address: null, text: null },
      { place: 'internet', address: null, text: null },
    ]);
    expect(i.publicAddress).toEqual({ set: false, canSet: true });
    const admin = await friend(p, owner, 'ada', 'admin');
    expect((await info(admin, 'default')).publicAddress).toEqual({ set: false, canSet: false });
  });

  it('uses the DuckDNS name by default, and the addresses the owner set', async () => {
    const { owner } = await setup({ origins: [ORIGIN, 'https://example.duckdns.org:8443'] });
    expect((await info(owner, 'default')).places.find((x) => x.place === 'internet')).toEqual({ place: 'internet', address: 'example.duckdns.org', text: 'example.duckdns.org' });
    await owner.req('PUT', '/api/host/address', { public: '203.0.113.7', home: '192.168.1.50' });
    const i = await info(owner, 'default');
    expect(i.places.map((x) => x.text)).toEqual(['127.0.0.1', '192.168.1.50', '203.0.113.7']);
    expect(i.publicAddress).toEqual({ set: true, canSet: true });
  });

  it("Project Zomboid: the address and the port in their own fields, UDP, both ports forwarded, the accounts step while Open is false", async () => {
    const { p, owner } = await setup();
    await owner.req('PUT', '/api/host/address', { public: 'example.duckdns.org', home: '192.168.1.50' });
    p.feed.status_ = fakeStatus({ installedInfo: { version: '42.20.4', channel: 'public', build: '24909800' } });
    writeIni(p, 'Open=false\n');
    const i = await info(owner, 'default');
    expect(i).toMatchObject({
      server: { id: 'default' },
      game: { en: 'Project Zomboid' },
      port: { id: 'game', number: 16261, proto: 'udp' },
      format: 'separate',
      defaultPort: null,
      client: { name: { en: 'Project Zomboid' }, sameVersion: true, version: '42.20.4' },
      verified: false,
    });
    expect(i.places.map((x) => x.text)).toEqual(['127.0.0.1', '192.168.1.50', 'example.duckdns.org']);
    expect(i.forwards.map((f) => [f.port, f.proto, f.typed])).toEqual([
      [16261, 'udp', true],
      [16262, 'udp', false],
    ]);
    expect(i.steps).toEqual([{ id: 'accounts', text: expect.objectContaining({ en: expect.stringMatching(/admin/) }), applies: 'yes' }]);
    writeIni(p, 'Open=true\n');
    expect((await info(owner, 'default')).steps).toEqual([]);
  });

  it("Minecraft: host:port in Direct Connection, the address alone on 25565, verified, the whitelist step from server.properties", async () => {
    const { p, owner } = await setup();
    await owner.req('PUT', '/api/host/address', { public: '2001:db8::7', home: '192.168.1.50' });
    const mk = async (id: string, game: number) => {
      const r = await owner.post('/api/servers', { id, name: id, adapter: 'minecraft', flavour: 'paper', launch: { version: '26.3', channel: 'STABLE', loaderVersion: '', memoryMb: 2048 }, eulaAccepted: true, ports: { game } });
      expect(r.statusCode, r.body).toBe(200);
    };
    await mk('mc-a', 30450);
    await mk('mc-b', 25565);
    p.fakes('mc-a').feed.status_ = fakeStatus({ state: 'running', installedInfo: { version: '26.3', channel: 'paper' } });
    writeData(p, 'mc-a', 'server.properties', 'white-list=true\nserver-port=25565\n');
    const a = await info(owner, 'mc-a');
    expect(a).toMatchObject({ format: 'host:port', defaultPort: 25565, port: { number: 30450, proto: 'tcp' }, client: { name: { en: 'Minecraft: Java Edition' }, version: '26.3' }, verified: true, password: { game: false, set: false } });
    expect(a.places.map((x) => x.text)).toEqual(['127.0.0.1:30450', '192.168.1.50:30450', '[2001:db8::7]:30450']);
    // Only the game port is published: RCON stays inside.
    expect(a.forwards.map((f) => [f.port, f.proto])).toEqual([[30450, 'tcp']]);
    expect(a.steps.map((s) => [s.id, s.applies])).toEqual([['whitelist', 'yes']]);
    writeData(p, 'mc-a', 'server.properties', 'white-list=false\n');
    expect((await info(owner, 'mc-a')).steps).toEqual([]);
    // On the client's own default port the address is enough.
    expect((await info(owner, 'mc-b')).places.map((x) => x.text)).toEqual(['127.0.0.1', '192.168.1.50', '[2001:db8::7]']);
  });

  it("says a step may apply when the server's files can't be read now", async () => {
    const { p, owner } = await setup();
    await owner.post('/api/servers', { id: 'mc-c', name: 'mc-c', adapter: 'minecraft', flavour: 'vanilla', launch: { version: '26.3', channel: 'STABLE', loaderVersion: '', memoryMb: 2048 }, eulaAccepted: true });
    const files = p.deps.servers.get('mc-c')!.files;
    files.read = async () => {
      throw new Error('agent unreachable');
    };
    const i = await info(owner, 'mc-c');
    expect(i.steps.map((s) => [s.id, s.applies])).toEqual([['whitelist', 'unknown']]);
  });

  it('Terraria: the address then the port, the launch password; tModLoader needs tModLoader, TShock may ask for an account', async () => {
    const { p, owner } = await setup();
    const mk = async (id: string, flavour: string, password: string, game: number) => {
      const r = await owner.post('/api/servers', { id, name: id, adapter: 'terraria', flavour, launch: { version: '', channel: 'stable', worldSize: 1, maxPlayers: 8, password, memoryMb: 2048 }, ports: { game } });
      expect(r.statusCode, r.body).toBe(200);
    };
    await mk('tr-v', 'vanilla', 'open-sesame', 30550);
    await mk('tr-s', 'tshock', '', 30551);
    await mk('tr-m', 'tmodloader', '', 30552);
    p.fakes('tr-m').feed.status_ = fakeStatus({ installedInfo: { version: 'v2026.07.3.0', channel: 'tmodloader' } });
    const v = await info(owner, 'tr-v', '?password=1');
    expect(v).toMatchObject({ format: 'separate', port: { number: 30550, proto: 'tcp' }, client: { name: { en: 'Terraria' } }, password: { game: true, set: true, value: 'open-sesame' }, steps: [], verified: false });
    expect(v.places[0]).toEqual({ place: 'pc', address: '127.0.0.1', text: '127.0.0.1' });
    // TShock's REST port is the agent's alone: never forwarded.
    expect(v.forwards.map((f) => [f.port, f.proto])).toEqual([[30550, 'tcp']]);
    const s = await info(owner, 'tr-s');
    expect(s.steps.map((x) => x.id)).toEqual(['tshock-account']);
    expect(s.password).toEqual({ game: true, set: false, value: null, canInclude: true });
    const m = await info(owner, 'tr-m');
    expect(m.client).toEqual({ name: { en: 'tModLoader', es: 'tModLoader' }, sameVersion: true, version: 'v2026.07.3.0' });
    expect(m.steps.map((x) => x.id)).toEqual(['same-mods']);
  });

  it('Valheim: host:port in Join IP, unverified with a note on which port, both UDP ports forwarded, steps for its public list and crossplay', async () => {
    const { owner } = await setup();
    const r = await owner.post('/api/servers', { id: 'vh', name: 'Valheim', adapter: 'valheim', launch: { serverName: 'Vikings', password: 'skal-123', public: true, crossplay: true }, ports: { game: 30152 } });
    expect(r.statusCode, r.body).toBe(200);
    const i = await info(owner, 'vh');
    expect(i).toMatchObject({ format: 'host:port', defaultPort: null, port: { id: 'game', number: 30152, proto: 'udp' }, verified: false, password: { game: true, set: true, value: null } });
    expect(i.note?.en).toMatch(/game port; if that fails, the next one/);
    expect(i.places[0]!.text).toBe('127.0.0.1:30152');
    expect(i.forwards.map((f) => [f.id, f.port, f.proto, f.typed])).toEqual([
      ['game', 30152, 'udp', true],
      ['query', 30153, 'udp', false],
    ]);
    expect(i.steps.map((s) => [s.id, s.applies])).toEqual([
      ['public-list', 'yes'],
      ['crossplay', 'yes'],
    ]);
  });

  it('Avorion: unverified, every published port forwarded (the game port on UDP and TCP), the password from server.ini', async () => {
    const { p, owner } = await setup();
    const r = await owner.post('/api/servers', { id: 'av', name: 'Avorion', adapter: 'avorion', ports: { game: 27000, query: 27003, steamquery: 27020 } });
    expect(r.statusCode, r.body).toBe(200);
    writeData(p, 'av', 'av/server.ini', '[Game]\npassword=stars\n');
    const i = await info(owner, 'av', '?password=1');
    expect(i).toMatchObject({ format: 'host:port', port: { number: 27000, proto: 'udp' }, verified: false, password: { game: true, set: true, value: 'stars' } });
    expect(i.note?.en).toMatch(/^Unverified/);
    expect(i.forwards.map((f) => `${f.port}/${f.proto}`)).toEqual(['27000/udp', '27000/tcp', '27003/udp', '27020/udp']);
  });

  it('each game says how players join, and only Minecraft is verified with a real client (D5)', () => {
    const facts = Object.fromEntries(
      panelAdapterEntries.map(({ adapter: a }) => {
        const j = a.meta.join!;
        const port = a.meta.ports.find((x) => x.id === j.port)!;
        return [a.meta.id, { port: `${port.default}/${port.proto}`, format: j.format, defaultPort: j.defaultPort ?? null, password: j.password ?? null, verified: j.verified }];
      }),
    );
    expect(facts).toEqual({
      pz: { port: '16261/udp', format: 'separate', defaultPort: null, password: { file: 'ini', key: 'Password' }, verified: false },
      minecraft: { port: '25565/tcp', format: 'host:port', defaultPort: 25565, password: null, verified: true },
      terraria: { port: '7777/tcp', format: 'separate', defaultPort: null, password: { launch: 'password' }, verified: false },
      valheim: { port: '2456/udp', format: 'host:port', defaultPort: null, password: { launch: 'password' }, verified: false },
      avorion: { port: '27000/udp', format: 'host:port', defaultPort: null, password: { file: 'server', key: 'password' }, verified: false },
    });
    expect(panelAdapter('minecraft').meta.join!.source).toMatch(/real 26\.3 server/);
  });
});
