// The smoke test's own parts (M7, HST-05): its options, where it finds the
// panel, its 2FA codes and its report. The run against a real stack is
// recorded in docs/verification/smoke.md.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { duration, formatReport, isLoopback, panelUrl, parseArgs, parseEnv, reachable, signIn, totp, totpStep } from './smoke.mjs';

describe('the smoke test’s options (M7, HST-05)', () => {
  it('defaults to a small vanilla Terraria server with a fresh id, from this checkout’s .env', () => {
    const o = parseArgs([]);
    expect(o).toMatchObject({ adapter: 'terraria', flavour: 'vanilla', launch: { worldSize: 1, memoryMb: 1024 }, url: null, timeoutMin: 20, keep: false, json: false, insecure: false, ca: null });
    expect(o.id).toMatch(/^smoke-[0-9a-f]{6}$/);
    expect(parseArgs([]).id).not.toBe(o.id);
    expect(path.basename(o.envFile)).toBe('.env');
    expect(o.stateFile.split(path.sep).slice(-2)).toEqual(['.tmp', 'smoke-owner.json']);
  });

  it('takes another game, address, id and limits', () => {
    const o = parseArgs(['--adapter', 'valheim', '--url', 'https://example.duckdns.org:8443/whatever', '--id', 'smoke-vh', '--timeout', '45', '--launch', '{"memoryMb":2048}', '--keep', '--json', '--insecure']);
    expect(o).toMatchObject({ adapter: 'valheim', flavour: null, url: 'https://example.duckdns.org:8443', id: 'smoke-vh', timeoutMin: 45, launch: { memoryMb: 2048 }, keep: true, json: true, insecure: true });
    // Another Terraria flavour keeps its own defaults; "" is no flavour.
    expect(parseArgs(['--flavour', 'tshock'])).toMatchObject({ flavour: 'tshock', launch: {} });
    expect(parseArgs(['--adapter', 'pz', '--flavour', ''])).toMatchObject({ flavour: null });
    expect(parseArgs(['--env', 'x/.env', '--state', 'y.json', '--ca', 'root.crt'])).toMatchObject({ envFile: path.resolve('x/.env'), stateFile: path.resolve('y.json'), ca: path.resolve('root.crt') });
    expect(parseArgs(['-h']).help).toBe(true);
  });

  it('refuses what it can’t use, saying why', () => {
    expect(() => parseArgs(['--what'])).toThrow('unknown option --what');
    expect(() => parseArgs(['--id'])).toThrow('--id needs a value');
    expect(() => parseArgs(['--id', 'Smoke_1'])).toThrow(/--id: a server id is/);
    expect(() => parseArgs(['--id', `s${'x'.repeat(24)}`])).toThrow(/--id/);
    expect(() => parseArgs(['--url', 'http://localhost:8443'])).toThrow('https:// only');
    expect(() => parseArgs(['--url', 'not a url'])).toThrow('not an address');
    expect(() => parseArgs(['--launch', '{oops'])).toThrow('--launch: not JSON');
    expect(() => parseArgs(['--launch', '[1]'])).toThrow('must be a JSON object');
    expect(() => parseArgs(['--timeout', '0'])).toThrow(/--timeout/);
    expect(() => parseArgs(['--timeout', 'soon'])).toThrow(/--timeout/);
    expect(() => parseArgs(['--adapter', 'Bad Game'])).toThrow(/--adapter/);
  });
});

describe('where the smoke test finds the panel', () => {
  it('reads the stack’s .env', () => {
    const env = parseEnv('# comment\nPANEL_HOST=wt5.localhost\nPANEL_PORT=30543\n\nPANEL_OWNER_PASSWORD="with spaces"\r\nEMPTY=\n  # PANEL_PORT=1\n');
    expect(env).toEqual({ PANEL_HOST: 'wt5.localhost', PANEL_PORT: '30543', PANEL_OWNER_PASSWORD: 'with spaces', EMPTY: '' });
    expect(panelUrl(env, null)).toBe('https://wt5.localhost:30543');
    expect(panelUrl({}, null)).toBe('https://localhost:8443');
    expect(panelUrl({ PANEL_HOST: 'example.duckdns.org', PANEL_PORT: '443' }, null)).toBe('https://example.duckdns.org');
    expect(panelUrl(env, 'https://192.168.1.20:8443')).toBe('https://192.168.1.20:8443');
  });

  it('knows which addresses are this computer (their certificate is Caddy’s own)', () => {
    for (const h of ['localhost', 'wt5.localhost', 'LOCALHOST', '127.0.0.1', '127.1.2.3', '[::1]', '::1']) expect(isLoopback(h), h).toBe(true);
    for (const h of ['example.duckdns.org', '192.168.1.20', 'localhost.example.org', '10.0.0.1', '::2']) expect(isLoopback(h), h).toBe(false);
  });
});

describe('the smoke test’s 2FA codes', () => {
  it('are RFC 6238 codes', () => {
    // RFC 6238 appendix B: the ASCII secret "12345678901234567890" (base32 below), SHA-1; the last 6 of its 8 digits.
    const secret = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';
    expect(totp(secret, Math.floor(59 / 30))).toBe('287082');
    expect(totp(secret, Math.floor(1111111109 / 30))).toBe('081804');
    expect(totp(secret, Math.floor(20000000000 / 30))).toBe('353130');
    expect(() => totp('not base32!', 1)).toThrow('not base32');
  });

  it('never uses one step twice', () => {
    const now = 1_000 * 30_000 + 5_000;
    expect(totpStep(now, null)).toBe(1000);
    expect(totpStep(now, 999)).toBe(1000);
    expect(totpStep(now, 1000)).toBe(1001);
    expect(totpStep(now, 1001)).toBe(1002);
  });
});

describe('the smoke test’s report', () => {
  const steps = [
    { name: 'sign in', ok: true, ms: 1200, detail: 'session reused; certificate not checked (this computer)' },
    { name: 'create', ok: true, ms: 800, detail: 'ports TCP 30550' },
    { name: 'start', ok: true, ms: 74_500, detail: 'running, version 1.4.5.8' },
    { name: 'back up', ok: false, ms: 3000, detail: 'backup failed: disk full' },
    { name: 'delete', ok: true, ms: 2100, detail: 'backups deleted, install i-1 removed' },
  ];

  it('is one line per step, then the verdict', () => {
    const text = formatReport({ url: 'https://wt5.localhost:30543', adapter: 'terraria', flavour: 'vanilla', serverId: 'smoke-ab12cd', steps, ok: false, ms: 81_600 });
    expect(text.split('\n')).toEqual([
      'Smoke test of https://wt5.localhost:30543: terraria vanilla, server smoke-ab12cd',
      '  ok    sign in       1.2 s  session reused; certificate not checked (this computer)',
      '  ok    create        0.8 s  ports TCP 30550',
      '  ok    start    1 min 15 s  running, version 1.4.5.8',
      '  FAIL  back up       3.0 s  backup failed: disk full',
      '  ok    delete        2.1 s  backups deleted, install i-1 removed',
      'FAIL: 4 of 5 steps passed in 1 min 22 s',
    ]);
  });

  it('passes only when every step did', () => {
    const ok = steps.map((s) => ({ ...s, ok: true }));
    expect(formatReport({ url: 'https://localhost:8443', adapter: 'pz', flavour: null, serverId: 'smoke-1', steps: ok, ok: true, ms: 5000 }).split('\n').at(-1)).toBe('PASS: 5 of 5 steps passed in 5.0 s');
    expect(duration(59_949)).toBe('59.9 s');
    expect(duration(60_000)).toBe('1 min 0 s');
  });
});

describe('the smoke test waits for a stack that is still starting', () => {
  const failing = (code: string) => Object.assign(new Error(`write ${code}`), { code });
  /** A panel whose answers are scripted, one per call; then 200. */
  const scripted = (answers: (number | Error)[]) => {
    const calls: string[] = [];
    return {
      calls,
      raw: async (_m: 'GET', p: string) => {
        calls.push(p);
        const a = answers.shift() ?? 200;
        if (a instanceof Error) throw a;
        return { status: a };
      },
    };
  };
  const clock = () => {
    let now = 0;
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(now);
    return async (ms: number) => {
      now += ms;
      vi.setSystemTime(now);
    };
  };
  afterEach(() => vi.useRealTimers());

  it('retries while Caddy makes its certificate or the panel starts, then goes on', async () => {
    const panel = scripted([failing('ECONNREFUSED'), failing('EPROTO'), failing('ERR_SSL_TLSV1_ALERT_INTERNAL_ERROR'), 502, 401]);
    expect(await reachable(panel, 60_000, clock())).toBe(4000);
    expect(panel.calls).toEqual(Array(5).fill('/api/session'));
  });

  it('does not wait for a panel that already answers', async () => {
    expect(await reachable(scripted([200]), 60_000, clock())).toBe(0);
  });

  it('gives up after its time, saying what it last saw', async () => {
    const panel = scripted(Array(100).fill(failing('ECONNREFUSED')));
    await expect(reachable(panel, 5000, clock())).rejects.toThrow("the panel didn't answer within 5.0 s: write ECONNREFUSED");
    expect(panel.calls).toHaveLength(6);
  });

  it('does not retry what waiting cannot fix', async () => {
    const panel = scripted([failing('ENOTFOUND')]);
    await expect(reachable(panel, 60_000, clock())).rejects.toThrow('write ENOTFOUND');
    expect(panel.calls).toHaveLength(1);
  });
});

describe('the smoke test keeps what it sets on a stack', () => {
  it('stops before the panel changes anything when it cannot save its state', async () => {
    // A state file under a file can't be written on any system.
    const dir = mkdtempSync(path.join(tmpdir(), 'gsp-smoke-'));
    try {
      const blocker = path.join(dir, 'not-a-folder');
      writeFileSync(blocker, '');
      const calls: string[] = [];
      const panel = {
        cookie: null,
        csrf: null,
        raw: async (m: string, p: string) => {
          calls.push(`${m} ${p}`);
          return { status: 200, body: { pending: 'password' } };
        },
        call: async (m: string, p: string) => {
          calls.push(`${m} ${p}`);
          return { pending: null };
        },
      };
      await expect(signIn(panel as never, { PANEL_OWNER_PASSWORD: 'from-the-env' }, path.join(blocker, 'smoke-owner.json'))).rejects.toThrow();
      expect(calls).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('saves a new password before setting it', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'gsp-smoke-'));
    try {
      const file = path.join(dir, 'smoke-owner.json');
      let savedWhenSet: string | undefined;
      const panel = {
        url: 'https://wt7.localhost:30743',
        cookie: null,
        csrf: null,
        raw: async () => ({ status: 200, body: { pending: 'password' } }),
        call: async (_m: string, p: string, body: { next?: string }) => {
          if (p === '/api/auth/password') {
            savedWhenSet = JSON.parse(readFileSync(file, 'utf8'))['https://wt7.localhost:30743'].password;
            expect(savedWhenSet).toBe(body.next);
            throw new Error('the panel failed');
          }
          return { pending: null };
        },
      };
      await expect(signIn(panel as never, { PANEL_OWNER_PASSWORD: 'from-the-env' }, file)).rejects.toThrow('the panel failed');
      expect(savedWhenSet).toMatch(/^Smoke-/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
