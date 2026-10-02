import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { loadEnv, secretEnvName } from '../src/env';

const base = { AGENT_TOKEN: 'x'.repeat(40), GAME_SECRET_ADMIN_PASSWORD: 'secret' };

describe('loadEnv', () => {
  it('keeps origins exact, dropping default ports the way browsers do', () => {
    const env = loadEnv({ ...base, PANEL_ORIGINS: 'https://panel.example.net:8443, https://play.example.org:443/,https://192.168.1.50:8443' });
    expect(env.origins).toEqual(['https://panel.example.net:8443', 'https://play.example.org', 'https://192.168.1.50:8443']);
  });

  it('refuses anything that is not a bare origin', () => {
    expect(() => loadEnv({ ...base, PANEL_ORIGINS: 'https://panel.example.net:8443/panel' })).toThrow(/exact origin/);
    expect(() => loadEnv({ ...base, PANEL_ORIGINS: 'https://user@panel.example.net:8443' })).toThrow(/exact origin/);
  });

  it("reads the adapter's secrets by key from GAME_SECRET_<KEY>", () => {
    const env = loadEnv({ ...base, GAME_SECRET_RCON_TOKEN: 'tok', GAME_SECRET_EMPTY: '', GAME_SECRET_: 'x', SECRET_OTHER: 'y' });
    expect(env.secrets).toEqual({ adminPassword: 'secret', rconToken: 'tok' });
    expect(secretEnvName('adminPassword')).toBe('GAME_SECRET_ADMIN_PASSWORD');
    expect(secretEnvName('rconToken')).toBe('GAME_SECRET_RCON_TOKEN');
  });

  it('reads the described server\'s published ports from GAME_PORT_<ID> (M2)', () => {
    expect(loadEnv({ ...base, GAME_PORT_GAME: '16300', GAME_PORT_UDP: '16301', GAME_PORT_: '1' }).ports).toEqual({ game: 16300, udp: 16301 });
    expect(loadEnv(base).ports).toEqual({});
    expect(() => loadEnv({ ...base, GAME_PORT_GAME: '70000' })).toThrow(/GAME_PORT_GAME must be a port number/);
  });

  it('requires strong secrets and a safe server name', () => {
    expect(() => loadEnv({ ...base, AGENT_TOKEN: 'short' })).toThrow(/32/);
    expect(() => loadEnv({ ...base, PZ_SERVER_NAME: '../etc' })).toThrow(/PZ_SERVER_NAME/);
    expect(() => loadEnv({ AGENT_URL: 'http://pz:8081' })).toThrow(/AGENT_TOKEN must be set with AGENT_URL/);
    expect(() => loadEnv({ ...base, ORCH_SOCKET: '/run/orch/orch.sock' })).toThrow(/ORCH_SOCKET and ORCH_TOKEN must be set together/);
    expect(() => loadEnv({ ...base, ORCH_TOKEN: 'o'.repeat(40) })).toThrow(/together/);
    expect(() => loadEnv({ ...base, ORCH_SOCKET: '/run/orch/orch.sock', ORCH_TOKEN: 'short' })).toThrow(/ORCH_TOKEN/);
  });

  it('describes the default server only when told to, and the orchestrator when there is one (M2)', () => {
    // An install whose servers the orchestrator runs has no AGENT_URL/AGENT_TOKEN of its own.
    expect(loadEnv({})).toMatchObject({ agentUrl: '', agentToken: '', orchestrator: null });
    // AGENT_URL says where default's agent is; a token alone describes nothing (the orchestrator's stack).
    expect(loadEnv(base)).toMatchObject({ agentUrl: '', agentToken: base.AGENT_TOKEN });
    expect(loadEnv({ ...base, AGENT_URL: 'http://pz:8081' })).toMatchObject({ agentUrl: 'http://pz:8081', agentToken: base.AGENT_TOKEN });
    expect(loadEnv({ ...base, ORCH_SOCKET: '/run/orch/orch.sock', ORCH_TOKEN: 'o'.repeat(40) }).orchestrator).toEqual({ socket: '/run/orch/orch.sock', token: 'o'.repeat(40) });
    // Development and test slots run the fake game images.
    expect(loadEnv(base).serverImageVariant).toBeNull();
    expect(loadEnv({ ...base, SERVER_IMAGE_VARIANT: '' }).serverImageVariant).toBeNull();
    expect(loadEnv({ ...base, SERVER_IMAGE_VARIANT: 'fake' }).serverImageVariant).toBe('fake');
    expect(() => loadEnv({ ...base, SERVER_IMAGE_VARIANT: 'Fake Images' })).toThrow(/SERVER_IMAGE_VARIANT/);
  });

  it('listens on TCP by default, or on a unix socket (PANEL_LISTEN, NFR-03)', () => {
    expect(loadEnv(base).listen).toEqual({ kind: 'tcp', host: '0.0.0.0', port: 8080 });
    expect(loadEnv({ ...base, PANEL_LISTEN: 'tcp', PANEL_HOST_BIND: '127.0.0.1', PANEL_PORT_BIND: '30300' }).listen).toEqual({ kind: 'tcp', host: '127.0.0.1', port: 30300 });
    expect(loadEnv({ ...base, PANEL_LISTEN: 'unix:/run/panel/panel.sock' }).listen).toEqual({ kind: 'unix', path: '/run/panel/panel.sock' });
    expect(loadEnv({ ...base, PANEL_LISTEN: 'unix:\\\\.\\pipe\\gsp-panel' }).listen).toEqual({ kind: 'unix', path: '\\\\.\\pipe\\gsp-panel' });
    for (const bad of ['unix:', 'unix:run/panel.sock', 'udp', 'tcp:8080']) expect(() => loadEnv({ ...base, PANEL_LISTEN: bad }), bad).toThrow(/PANEL_LISTEN/);
    expect(() => loadEnv({ ...base, PANEL_PORT_BIND: 'x' })).toThrow(/PANEL_PORT_BIND/);
  });

  it('ships defaults Caddy accepts: PANEL_HOST is neither localhost nor the LAN IP', () => {
    const ex = Object.fromEntries(
      readFileSync(new URL('../../../.env.example', import.meta.url), 'utf8')
        .split(/\r?\n/)
        .map((l) => /^([A-Z0-9_]+)=(.*)$/.exec(l))
        .filter((m): m is RegExpExecArray => m !== null)
        .map((m) => [m[1], m[2]]),
    );
    // The Caddyfile already has a site for localhost and LAN_IP; a duplicate address stops Caddy.
    expect(ex.PANEL_HOST).not.toBe('localhost');
    expect(ex.PANEL_HOST).not.toBe(ex.LAN_IP);
  });

  it('reads the DuckDNS name the public address defaults to (HST-08), and refuses one that is no name', () => {
    expect(loadEnv(base).duckdnsSubdomain).toBeNull();
    expect(loadEnv({ ...base, DUCKDNS_SUBDOMAIN: '' }).duckdnsSubdomain).toBeNull();
    expect(loadEnv({ ...base, DUCKDNS_SUBDOMAIN: ' My-Zomboid ' }).duckdnsSubdomain).toBe('my-zomboid');
    expect(() => loadEnv({ ...base, DUCKDNS_SUBDOMAIN: 'my-zomboid.duckdns.org' })).toThrow(/DUCKDNS_SUBDOMAIN/);
    expect(() => loadEnv({ ...base, DUCKDNS_SUBDOMAIN: '-bad' })).toThrow(/DUCKDNS_SUBDOMAIN/);
  });
});
