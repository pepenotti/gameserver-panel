// The agent's file and archive routes (D11): the panel reaches a server's
// files only through them. The whole ServerFiles contract runs against them
// in panel/test/server-files.test.ts; these are the agent's own rules.
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import type http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { PassThrough, Writable } from 'node:stream';
import { afterEach, describe, expect, it } from 'vitest';
import { headerFor, TarPacker, unpack } from '@gsp/archive';
import type { RuntimeAdapter } from '@gsp/adapter-api';
import { FS_WRITE_MAX_BYTES } from '@gsp/shared';
import { createAgentServer } from '../src/http';
import { envelope, makeHarness, TIME_SCALE, type Harness } from './helpers';

let h: Harness | null = null;
let server: http.Server | null = null;
let base = '';
const extraDirs: string[] = [];

afterEach(async () => {
  server?.closeAllConnections();
  await new Promise((r) => (server ? server.close(r) : r(undefined)));
  await h?.cleanup();
  for (const d of extraDirs.splice(0)) rmSync(d, { recursive: true, force: true });
  h = server = null;
});

async function setup(overrides: Parameters<typeof makeHarness>[0] = {}, adapter?: (a: RuntimeAdapter) => RuntimeAdapter): Promise<Harness> {
  h = await makeHarness(overrides, { adapter });
  mkdirSync(h.cfg.dataDir!, { recursive: true });
  server = createAgentServer(h.agent, h.hub, h.cfg.token);
  await new Promise<void>((r) => server!.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return h;
}

const auth = () => ({ authorization: `Bearer ${h!.cfg.token}` });
const post = (p: string, body: unknown, o: RequestInit = {}) => fetch(`${base}${p}`, { method: 'POST', headers: { ...auth(), 'content-type': 'application/json' }, body: JSON.stringify(body), ...o });
const write = (root: string, rel: string, body: Buffer | string, type = 'application/octet-stream') =>
  fetch(`${base}/v1/fs/write?root=${encodeURIComponent(root)}&rel=${encodeURIComponent(rel)}`, { method: 'PUT', headers: { ...auth(), 'content-type': type }, body });

async function tarOf(fill: (t: TarPacker) => Promise<void>): Promise<Buffer> {
  const chunks: Buffer[] = [];
  const t = new TarPacker(
    new Writable({
      write(c: Buffer, _e, cb) {
        chunks.push(c);
        cb();
      },
    }),
  );
  await fill(t);
  await t.finish();
  return Buffer.concat(chunks);
}

async function names(body: ArrayBuffer | Buffer): Promise<string[]> {
  const src = new PassThrough();
  src.end(Buffer.from(body as ArrayBuffer));
  const out: string[] = [];
  await unpack(src, async (e) => {
    out.push(e.name);
    return null;
  });
  return out;
}

/** The PZ adapter with its hot-copy steps recorded (and `before` optionally failing). */
function spying(calls: string[], o: { failBefore?: boolean } = {}) {
  return (a: RuntimeAdapter): RuntimeAdapter => ({
    ...a,
    hotCopy: {
      sqlite: a.hotCopy?.sqlite,
      before: async (ctl) => {
        calls.push('before');
        if (o.failBefore) throw new Error('no save');
        await a.hotCopy!.before(ctl);
      },
      after: async (ctl) => {
        await a.hotCopy!.after(ctl);
        calls.push('after');
      },
    },
  });
}

async function until(pred: () => boolean, what: string): Promise<void> {
  const end = Date.now() + 8_000 * TIME_SCALE;
  while (!pred()) {
    if (Date.now() > end) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

describe('agent file routes', () => {
  it('need the token, like every other route', async () => {
    await setup();
    for (const p of ['/v1/fs/stat', '/v1/fs/list', '/v1/fs/read', '/v1/fs/remove', '/v1/archive/pack', '/v1/archive/stage', '/v1/archive/swap', '/v1/archive/undo', '/v1/archive/purge']) {
      expect((await fetch(`${base}${p}`, { method: 'POST', body: '{}' })).status, p).toBe(401);
    }
    expect((await fetch(`${base}/v1/fs/write?root=data&rel=a`, { method: 'PUT', body: 'x' })).status).toBe(401);
  });

  it('read, write, list and remove inside the roots; the install root is read-only', async () => {
    const hh = await setup();
    expect(await (await write('data', 'Server/a.ini', 'A=1\n')).json()).toEqual({ ok: true });
    const r = await post('/v1/fs/read', { root: 'data', rel: 'Server/a.ini' });
    expect(r.headers.get('content-type')).toBe('application/octet-stream');
    expect(await r.text()).toBe('A=1\n');
    expect(await (await post('/v1/fs/stat', { root: 'data', rel: 'Server/a.ini' })).json()).toMatchObject({ stat: { kind: 'file', size: 4 } });
    expect(await (await post('/v1/fs/list', { root: 'data', rel: 'Server' })).json()).toMatchObject({ entries: [{ name: 'a.ini', kind: 'file' }] });
    expect(await (await post('/v1/fs/remove', { root: 'data', rels: ['Server'] })).json()).toEqual({ ok: true });
    expect(await (await post('/v1/fs/stat', { root: 'data', rel: 'Server' })).json()).toEqual({ stat: null });

    mkdirSync(hh.cfg.installDir!, { recursive: true });
    writeFileSync(path.join(hh.cfg.installDir!, 'start.sh'), '#!/bin/sh\n');
    expect(await (await post('/v1/fs/read', { root: 'install', rel: 'start.sh' })).text()).toBe('#!/bin/sh\n');
    const ro = await write('install', 'start.sh', 'rm -rf /');
    expect(ro.status).toBe(403);
    expect(await ro.json()).toMatchObject({ code: 'bad-request', reason: 'outside-root' });
    expect((await post('/v1/fs/remove', { root: 'install', rels: ['start.sh'] })).status).toBe(403);
  });

  it('answer every refusal with its reason', async () => {
    await setup();
    const cases: [Promise<Response>, number, Record<string, unknown>][] = [
      [post('/v1/fs/read', { root: 'data', rel: '../../etc/passwd' }), 400, { code: 'bad-request', reason: 'invalid-path' }],
      [post('/v1/fs/read', { root: 'data', rel: '/etc/passwd' }), 400, { reason: 'invalid-path' }],
      [post('/v1/fs/stat', { root: 'data', rel: 'Server/NUL' }), 400, { reason: 'invalid-path' }],
      [post('/v1/fs/list', { root: 'backups', rel: '' }), 404, { code: 'not-found', reason: 'unknown-root' }],
      [post('/v1/fs/read', { root: 'data', rel: 'missing.txt' }), 404, { code: 'not-found' }],
      [post('/v1/fs/read', { root: 'data', rel: 1 }), 400, { code: 'bad-request' }],
      [write('data', 'a.txt', 'x', 'text/plain'), 415, { code: 'bad-request' }],
      [write('data', 'big.bin', Buffer.alloc(FS_WRITE_MAX_BYTES + 1)), 413, { reason: 'too-large' }],
      [post('/v1/archive/swap', { stagingId: 'not-an-id', rels: ['a'] }), 400, { reason: 'invalid-path' }],
    ];
    for (const [res, status, body] of cases) {
      const r = await res;
      expect(r.status).toBe(status);
      const j = (await r.json()) as Record<string, unknown>;
      expect(j).toMatchObject(body);
      if (!('reason' in body)) expect(j).not.toHaveProperty('reason');
    }
    // Nothing of the refused write was kept.
    expect(await (await post('/v1/fs/list', { root: 'data', rel: '' })).json()).toEqual({ entries: [] });
  });

  it('never reaches its own state folder, even when it lies inside the data root', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'gsp-agent-state-'));
    extraDirs.push(dir);
    await setup({ dataDir: path.join(dir, 'data'), stateDir: path.join(dir, 'data', '.agent') });
    // The stored launch holds the admin password.
    await fetch(`${base}/v1/launch`, { method: 'PUT', headers: { ...auth(), 'content-type': 'application/json' }, body: JSON.stringify(envelope()) });
    await write('data', 'world.bin', 'w');
    for (const [route, body] of [
      ['/v1/fs/read', { root: 'data', rel: '.agent/state.json' }],
      ['/v1/fs/stat', { root: 'data', rel: '.agent' }],
      ['/v1/fs/list', { root: 'data', rel: '.agent' }],
      ['/v1/fs/remove', { root: 'data', rels: ['.agent'] }],
      ['/v1/archive/pack', { root: 'data', rels: ['.agent'] }],
    ] as const) {
      const r = await post(route, body);
      expect(r.status, route).toBe(403);
      expect(await r.json(), route).toMatchObject({ reason: 'outside-root' });
    }
    expect(((await (await post('/v1/fs/list', { root: 'data', rel: '' })).json()) as { entries: { name: string }[] }).entries.map((e) => e.name)).toEqual(['world.bin']);
    const staged = await fetch(`${base}/v1/archive/stage?allow=.agent`, { method: 'POST', headers: { ...auth(), 'content-type': 'application/x-tar' }, body: await tarOf(async (t) => t.addBuffer('.agent/state.json', Buffer.from('{}'), 0)) });
    expect(staged.status).toBe(403);
  });

  it('answers a refused archive while it is still arriving, and keeps nothing of it', async () => {
    const hh = await setup();
    const bad = await tarOf(async (t) => {
      await t.addBuffer('Saves/w/a.bin', Buffer.from('ok'), 0);
      await t.addBuffer('Server/evil.ini', Buffer.alloc(4 << 20, 1), 0);
      await t.addBuffer('Saves/w/b.bin', Buffer.alloc(4 << 20, 2), 0);
    });
    const r = await fetch(`${base}/v1/archive/stage?allow=Saves/w`, { method: 'POST', headers: { ...auth(), 'content-type': 'application/x-tar' }, body: bad });
    expect(r.status).toBe(403);
    expect(await r.json()).toMatchObject({ reason: 'outside-root', error: expect.stringMatching(/Server\/evil\.ini/) });
    const link = Buffer.concat([headerFor({ name: 'Saves/w/l', type: 'file', size: 0, mode: 0o644, mtime: 0 }), Buffer.alloc(1024)]);
    link.write('2', 156);
    link.write('        ', 148);
    let sum = 0;
    for (const b of link.subarray(0, 512)) sum += b;
    link.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148);
    const linked = await fetch(`${base}/v1/archive/stage?allow=Saves/w`, { method: 'POST', headers: { ...auth(), 'content-type': 'application/x-tar' }, body: link });
    expect(linked.status).toBe(400);
    expect(await linked.json()).toMatchObject({ code: 'bad-request', error: expect.stringMatching(/Unsupported entry type/) });
    expect(readdirSync(path.join(hh.cfg.dataDir!, '.gsp-files', 'staging'))).toEqual([]);
    // The connection still serves requests.
    expect((await post('/v1/fs/stat', { root: 'data', rel: '' })).status).toBe(200);
  });

  it(
    'packs hot while the game runs: before, SQLite snapshots, after, even when the reader hangs up; no swaps under it',
    async () => {
      const calls: string[] = [];
      const hh = await setup({}, spying(calls));
      await post('/v1/start', { launch: envelope() });
      await hh.waitFor((s) => s.state === 'running');

      const full = await post('/v1/archive/pack', { root: 'data', rels: ['Saves', 'db'], sqlite: ['**/*.db'], prefix: 'data/' });
      expect(full.status).toBe(200);
      expect(full.headers.get('content-type')).toBe('application/x-tar');
      expect(await names(await full.arrayBuffer())).toEqual(expect.arrayContaining(['data/Saves/', 'data/Saves/Multiplayer/testsrv/map_t.bin', 'data/db/testsrv.db']));
      await until(() => calls.length === 2, 'after');
      expect(calls).toEqual(['before', 'after']);
      // PZ's step is a save the game confirms.
      expect(hh.logs().some((l) => l.includes('World saved'))).toBe(true);

      // A reader that goes away still gets the game's files switched back on.
      writeFileSync(path.join(hh.cfg.dataDir!, 'Saves', 'big.bin'), Buffer.alloc(8 << 20, 7));
      const ctrl = new AbortController();
      const partial = await post('/v1/archive/pack', { root: 'data', rels: ['Saves'] }, { signal: ctrl.signal });
      await partial.body!.getReader().read();
      ctrl.abort();
      await until(() => calls.length === 4, 'after, once the reader left');
      expect(calls).toEqual(['before', 'after', 'before', 'after']);

      const swap = await post('/v1/archive/swap', { stagingId: '00000000-0000-4000-8000-000000000000', rels: ['Saves'] });
      expect(swap.status).toBe(409);
      expect(await swap.json()).toMatchObject({ code: 'conflict' });
      expect((await post('/v1/archive/undo', { trashId: '00000000-0000-4000-8000-000000000000' })).status).toBe(409);
    },
    60_000 * TIME_SCALE,
  );

  it(
    'answers a failed hot-copy step as JSON, after running after',
    async () => {
      const calls: string[] = [];
      const hh = await setup({}, spying(calls, { failBefore: true }));
      await post('/v1/start', { launch: envelope() });
      await hh.waitFor((s) => s.state === 'running');
      const r = await post('/v1/archive/pack', { root: 'data', rels: ['Saves'] });
      expect(r.status).toBe(503);
      expect(await r.json()).toMatchObject({ code: 'unavailable', error: expect.stringMatching(/could not prepare its files for a copy: no save/) });
      expect(calls).toEqual(['before', 'after']);
    },
    60_000 * TIME_SCALE,
  );
});
