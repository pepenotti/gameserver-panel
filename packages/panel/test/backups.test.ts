import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { PassThrough, Writable } from 'node:stream';
import { DatabaseSync } from 'node:sqlite';
import { zstdCompressSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { headerFor, TarError, TarPacker, unpack } from '../src/backups/tar';
import { Client, fakeStatus, makePanel, ownerReady, type TestPanel } from './harness';

async function packToBuffer(fill: (t: TarPacker) => Promise<void>): Promise<Buffer> {
  const chunks: Buffer[] = [];
  const sink = new Writable({
    write(c: Buffer, _e, cb) {
      chunks.push(c);
      cb();
    },
  });
  const t = new TarPacker(sink);
  await fill(t);
  await t.finish();
  return Buffer.concat(chunks);
}

async function unpackAll(buf: Buffer): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  const src = new PassThrough();
  src.end(buf);
  await unpack(src, async (e) => {
    if (e.type === 'dir') {
      out[e.name] = '<dir>';
      return null;
    }
    const chunks: Buffer[] = [];
    return new Writable({
      write(c: Buffer, _e, cb) {
        chunks.push(c);
        cb();
      },
      final(cb) {
        out[e.name] = Buffer.concat(chunks).toString('utf8');
        cb();
      },
    });
  });
  return out;
}

describe('tar', () => {
  it('round-trips files, directories, long and non-ASCII names', async () => {
    const long = `data/Saves/Multiplayer/zomboid/${'chunk_'.repeat(30)}ñandú.bin`;
    const buf = await packToBuffer(async (t) => {
      await t.addDir('data/Saves/', 0);
      await t.addBuffer('manifest.json', Buffer.from('{"a":1}'), 0);
      await t.addBuffer(long, Buffer.from('x'.repeat(1025)), 0);
      await t.addBuffer('data/empty', Buffer.alloc(0), 0);
    });
    expect(await unpackAll(buf)).toEqual({ 'data/Saves/': '<dir>', 'manifest.json': '{"a":1}', [long]: 'x'.repeat(1025), 'data/empty': '' });
  });

  it('refuses links and corrupt headers', async () => {
    const good = headerFor({ name: 'evil', type: 'file', size: 0, mode: 0o644, mtime: 0 });
    const link = Buffer.from(good);
    link.write('2', 156);
    // Recompute the checksum so only the type is "wrong".
    link.write('        ', 148);
    let sum = 0;
    for (const b of link) sum += b;
    link.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148);
    await expect(unpackAll(Buffer.concat([link, Buffer.alloc(1024)]))).rejects.toThrow(/Unsupported entry type "2"/);
    const corrupt = Buffer.from(good);
    corrupt[0] = 0x41;
    await expect(unpackAll(Buffer.concat([corrupt, Buffer.alloc(1024)]))).rejects.toThrow(TarError);
    await expect(unpackAll(good)).rejects.toThrow(/Truncated/);
  });
});

/** A small but realistic world: files, a chunk folder and PZ's SQLite databases. */
function seedWorld(p: TestPanel, marker = 'v1'): void {
  const data = p.deps.env.pzDataDir;
  const world = path.join(data, 'Saves', 'Multiplayer', 'zomboid');
  mkdirSync(path.join(world, 'map', '10'), { recursive: true });
  writeFileSync(path.join(world, 'map_t.bin'), `time-${marker}`);
  writeFileSync(path.join(world, 'map', '10', '20.bin'), Buffer.alloc(70_000, marker === 'v1' ? 1 : 2));
  for (const [file, table] of [
    [path.join(world, 'players.db'), 'networkPlayers'],
    [path.join(data, 'db', 'zomboid.db'), 'whitelist'],
  ] as const) {
    mkdirSync(path.dirname(file), { recursive: true });
    rmSync(file, { force: true });
    const db = new DatabaseSync(file);
    db.exec(`CREATE TABLE ${table} (id INTEGER PRIMARY KEY, username TEXT); INSERT INTO ${table} (username) VALUES ('${marker}')`);
    db.close();
  }
  mkdirSync(path.join(data, 'Server'), { recursive: true });
  writeFileSync(path.join(data, 'Server', 'zomboid.ini'), `PublicName=${marker}\nRCONPassword=secret\n`);
}

const read = (p: TestPanel, rel: string) => readFileSync(path.join(p.deps.env.pzDataDir, rel), 'utf8');
const dbValue = (file: string, table: string) => {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    return (db.prepare(`SELECT username FROM ${table}`).get() as { username: string }).username;
  } finally {
    db.close();
  }
};

async function setup() {
  const p = await makePanel();
  seedWorld(p);
  const { client } = await ownerReady(p);
  return { p, c: client };
}

describe('creating backups', () => {
  it('archives world, accounts and configs with a manifest and checksum', async () => {
    const { p, c } = await setup();
    await c.post('/api/backups');
    await p.deps.ops.idle();
    const { backups } = (await c.get('/api/backups')).json() as { backups: { name: string; sha256: string; size: number; manifest: Record<string, unknown> }[] };
    expect(backups).toHaveLength(1);
    const b = backups[0]!;
    expect(b.name).toMatch(/^pz-zomboid-\d{8}T\d{6}Z-manual\.tar\.zst$/);
    expect(b.manifest).toMatchObject({ serverName: 'zomboid', mode: 'cold', trigger: 'manual', parts: ['world', 'accounts', 'configs'], files: 5 });
    const file = readFileSync(path.join(p.deps.env.backupDir, b.name));
    expect(createHash('sha256').update(file).digest('hex')).toBe(b.sha256);
    expect(await p.deps.backups.readManifest(path.join(p.deps.env.backupDir, b.name))).toMatchObject({ serverName: 'zomboid' });
  });

  it('takes a consistent hot copy of the databases while the server runs', async () => {
    const { p } = await setup();
    p.feed.status_ = fakeStatus({ state: 'running' });
    // The game holds its database open while we copy it.
    const live = new DatabaseSync(path.join(p.deps.env.pzDataDir, 'db', 'zomboid.db'));
    live.exec("INSERT INTO whitelist (username) VALUES ('while-running')");
    p.agent.command = async (cmd) => {
      p.agent.calls.push(`command:${cmd}`);
      p.feed.emit({ type: 'log', stream: 'out', line: 'LOG  : General      f:0 st:1> Saving finish' });
      return { via: 'rcon', output: 'World saved' };
    };
    const info = await p.deps.flows.backupNow(null, 'manual');
    live.close();
    expect(info.manifest.mode).toBe('hot');
    // Both databases went through SQLite, not the plain-file fallback.
    expect(info.manifest.warnings).toBeUndefined();
    expect(p.agent.calls).toContain('command:save');
  });

  it('keeps the newest ten manual backups and never drops pinned ones', async () => {
    const { p } = await setup();
    const first = await p.deps.backups.create({ trigger: 'manual', hot: false });
    p.deps.backups.setPinned(first.name, true);
    for (let i = 0; i < 11; i++) await p.deps.backups.create({ trigger: 'manual', hot: false });
    const names = p.deps.backups.list().map((b) => b.name);
    expect(names).toHaveLength(11);
    expect(names).toContain(first.name);
  });
});

describe('restoring', () => {
  it('puts back the chosen parts, keeps a safety copy, and can be undone', async () => {
    const { p, c } = await setup();
    const b = await p.deps.backups.create({ trigger: 'manual', hot: false });
    seedWorld(p, 'v2');

    const op = await c.post(`/api/backups/${b.name}/restore`, { parts: ['world', 'configs'] });
    expect(op.statusCode).toBe(200);
    await p.deps.ops.idle();
    expect(p.deps.bus.currentOp()).toMatchObject({ kind: 'restore', ok: true });

    expect(read(p, 'Saves/Multiplayer/zomboid/map_t.bin')).toBe('time-v1');
    expect(readFileSync(path.join(p.deps.env.pzDataDir, 'Saves/Multiplayer/zomboid/map/10/20.bin'))[0]).toBe(1);
    expect(read(p, 'Server/zomboid.ini')).toContain('PublicName=v1');
    // Accounts weren't selected, so they keep the newer state.
    expect(dbValue(path.join(p.deps.env.pzDataDir, 'db/zomboid.db'), 'whitelist')).toBe('v2');
    expect(p.deps.backups.list().some((x) => x.manifest.trigger === 'pre-restore')).toBe(true);
    // The agent lock was taken and released.
    expect(p.agent.calls).not.toContain('start');

    await c.post('/api/backups/undo-restore');
    await p.deps.ops.idle();
    expect(read(p, 'Saves/Multiplayer/zomboid/map_t.bin')).toBe('time-v2');
    expect(read(p, 'Server/zomboid.ini')).toContain('PublicName=v2');
    expect((await c.post('/api/backups/undo-restore')).json()).toEqual({ error: 'nothing-to-undo' });
  });

  it('stops a running server, restores, and starts it again', async () => {
    const { p, c } = await setup();
    const b = await p.deps.backups.create({ trigger: 'manual', hot: false });
    p.feed.status_ = fakeStatus({ state: 'running' });
    p.agent.start = async () => {
      p.agent.calls.push('start');
      setTimeout(() => {
        p.feed.status_ = fakeStatus({ state: 'running', readyAt: new Date().toISOString() });
        p.feed.emit({ type: 'state', status: p.feed.status_ });
      }, 20);
      return fakeStatus({ state: 'starting' });
    };
    p.agent.stop = async () => {
      p.agent.calls.push('stop');
      p.feed.status_ = fakeStatus({ state: 'stopped' });
      return p.feed.status_;
    };
    await c.post(`/api/backups/${b.name}/restore`, { parts: ['world'] });
    await p.deps.ops.idle();
    expect(p.agent.calls.filter((x) => x === 'stop' || x === 'start')).toEqual(['stop', 'start']);
    expect(p.deps.bus.currentOp()).toMatchObject({ ok: true });
    // Started fine, so the pre-restore files were cleaned up.
    expect(p.deps.flows.lastRestore()?.trash).toBeNull();
  });

  it('refuses a damaged archive and one from a newer game build', async () => {
    const { p, c } = await setup();
    const b = await p.deps.backups.create({ trigger: 'manual', hot: false });
    const file = path.join(p.deps.env.backupDir, b.name);
    const bytes = readFileSync(file);
    bytes[bytes.length - 5] = bytes[bytes.length - 5]! ^ 0xff;
    writeFileSync(file, bytes);
    await c.post(`/api/backups/${b.name}/restore`, { parts: ['world'] });
    await p.deps.ops.idle();
    expect(p.deps.bus.currentOp()).toMatchObject({ ok: false, error: expect.stringMatching(/damaged/) });
    expect(read(p, 'Saves/Multiplayer/zomboid/map_t.bin')).toBe('time-v1');

    const b2 = await p.deps.backups.create({ trigger: 'manual', hot: false });
    const side = path.join(p.deps.env.backupDir, `${b2.name}.json`);
    const meta = JSON.parse(readFileSync(side, 'utf8'));
    meta.manifest.buildId = '99999999';
    writeFileSync(side, JSON.stringify(meta));
    expect((await c.post(`/api/backups/${b2.name}/restore`, { parts: ['world'] })).json()).toEqual({ error: 'backup-from-newer-build' });
    expect((await c.post('/api/backups/..%2F..%2Fetc/restore', { parts: ['world'] })).statusCode).toBe(400);
  });

  it('never writes outside the staging folder, whatever the archive says', async () => {
    const { p } = await setup();
    const evilTar = await packToBuffer(async (t) => {
      await t.addBuffer('manifest.json', Buffer.from(JSON.stringify({ format: 1, serverName: 'zomboid', parts: ['world'], bytes: 1 })), 0);
      await t.addBuffer('data/Saves/Multiplayer/zomboid/../../../../escaped.txt', Buffer.from('pwned'), 0);
    });
    mkdirSync(p.deps.env.backupDir, { recursive: true });
    const name = 'pz-zomboid-20260101T000000Z-upload.tar.zst';
    writeFileSync(path.join(p.deps.env.backupDir, name), zstdCompressSync(evilTar));
    writeFileSync(path.join(p.deps.env.backupDir, `${name}.json`), JSON.stringify({ size: 1, sha256: '', pinned: false, manifest: { serverName: 'zomboid', parts: ['world'], trigger: 'upload', createdAt: '2026-01-01T00:00:00Z', bytes: 1 } }));
    const staging = path.join(p.deps.env.pzDataDir, '.staging', 'evil');
    await expect(p.deps.backups.extract(name, ['world'], staging)).rejects.toThrow(/Unsafe path/);
    expect(existsSync(path.join(p.deps.env.pzDataDir, '..', 'escaped.txt'))).toBe(false);
  });
});

describe('download and upload', () => {
  it('lets admins download and the owner upload; not operators', async () => {
    const { p, c } = await setup();
    const b = await p.deps.backups.create({ trigger: 'manual', hot: false });
    const dl = await c.get(`/api/backups/${b.name}/download`);
    expect(dl.statusCode).toBe(200);
    expect(dl.headers['content-disposition']).toContain(b.name);
    expect(dl.rawPayload.length).toBe(b.size);

    const boundary = '----pzboundary';
    const body = Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="x.tar.zst"\r\nContent-Type: application/zstd\r\n\r\n`),
      dl.rawPayload,
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]);
    const up = await p.app.inject({
      method: 'POST',
      url: '/api/backups/upload',
      headers: { origin: 'https://panel.test:8443', cookie: `__Host-pzsid=${c.cookie}`, 'x-pz-csrf': c.csrf!, 'content-type': `multipart/form-data; boundary=${boundary}` },
      payload: body,
    });
    expect(up.statusCode).toBe(200);
    expect(up.json()).toMatchObject({ name: expect.stringMatching(/-upload\.tar\.zst$/), manifest: { trigger: 'upload', serverName: 'zomboid' } });

    await c.post('/api/users', { username: 'op1', password: 'Temporal-12345', role: 'operator' });
    const op = new Client(p.app);
    await op.post('/api/auth/login', { username: 'op1', password: 'Temporal-12345' });
    await op.post('/api/auth/password', { current: 'Temporal-12345', next: 'Operador-propio-1' });
    expect((await op.get(`/api/backups/${b.name}/download`)).statusCode).toBe(403);
    expect((await op.get('/api/backups')).statusCode).toBe(200);
    expect((await op.post('/api/backups')).statusCode).toBe(200);
    await p.deps.ops.idle();
  });
});
