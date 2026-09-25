import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { Writable } from 'node:stream';
import { DatabaseSync } from 'node:sqlite';
import { zstdCompressSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { INTERNAL_DIR, isFolderId, TarPacker } from '@gsp/archive';
import { Client, fakeStatus, makePanel, ownerReady, type TestPanel } from './harness';

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

/** An archive dropped into the backup folder by hand, with its sidecar. */
function placeArchive(p: TestPanel, name: string, tar: Buffer, manifest: Record<string, unknown>): void {
  mkdirSync(p.deps.env.backupDir, { recursive: true });
  writeFileSync(path.join(p.deps.env.backupDir, name), zstdCompressSync(tar));
  writeFileSync(path.join(p.deps.env.backupDir, `${name}.json`), JSON.stringify({ size: 1, sha256: '', pinned: false, manifest: { trigger: 'upload', createdAt: '2026-01-01T00:00:00Z', bytes: 1, ...manifest } }));
}

const stagingLeft = (p: TestPanel) => {
  const dir = path.join(p.deps.env.pzDataDir, INTERNAL_DIR, 'staging');
  return existsSync(dir) ? readdirSync(dir) : [];
};

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
    await c.post('/api/servers/default/backups');
    await p.srv.ops.idle();
    const { backups } = (await c.get('/api/servers/default/backups')).json() as { backups: { name: string; sha256: string; size: number; manifest: Record<string, unknown> }[] };
    expect(backups).toHaveLength(1);
    const b = backups[0]!;
    expect(b.name).toMatch(/^pz-zomboid-\d{8}T\d{6}Z-manual\.tar\.zst$/);
    expect(b.manifest).toMatchObject({ serverName: 'zomboid', mode: 'cold', trigger: 'manual', parts: ['world', 'accounts', 'configs'], files: 5 });
    const file = readFileSync(path.join(p.deps.env.backupDir, b.name));
    expect(createHash('sha256').update(file).digest('hex')).toBe(b.sha256);
    expect(await p.srv.backups.readManifest(path.join(p.deps.env.backupDir, b.name))).toMatchObject({ serverName: 'zomboid' });
  });

  it('takes a consistent hot copy of the databases while the server runs', async () => {
    const { p } = await setup();
    p.feed.status_ = fakeStatus({ state: 'running' });
    // The game holds its database open while we copy it.
    const live = new DatabaseSync(path.join(p.deps.env.pzDataDir, 'db', 'zomboid.db'));
    live.exec("INSERT INTO whitelist (username) VALUES ('while-running')");
    const info = await p.srv.flows.backupNow(null, 'manual');
    live.close();
    expect(info.manifest.mode).toBe('hot');
    // Both databases went through SQLite (the adapter's sqlite globs), not the plain-file fallback.
    expect(info.manifest.warnings).toBeUndefined();
    // The game's own save runs next to the data, in the agent's pack (the adapter's hotCopy): the panel doesn't save too.
    expect(p.agent.calls).toEqual([]);
  });

  it('keeps the newest ten manual backups and never drops pinned ones', async () => {
    const { p } = await setup();
    const first = await p.srv.backups.create({ trigger: 'manual', hot: false });
    p.srv.backups.setPinned(first.name, true);
    for (let i = 0; i < 11; i++) await p.srv.backups.create({ trigger: 'manual', hot: false });
    const names = p.srv.backups.list().map((b) => b.name);
    expect(names).toHaveLength(11);
    expect(names).toContain(first.name);
  });
});

describe('restoring', () => {
  it('puts back the chosen parts, keeps a safety copy, and can be undone', async () => {
    const { p, c } = await setup();
    const b = await p.srv.backups.create({ trigger: 'manual', hot: false });
    seedWorld(p, 'v2');

    const op = await c.post(`/api/servers/default/backups/${b.name}/restore`, { parts: ['world', 'configs'] });
    expect(op.statusCode).toBe(200);
    await p.srv.ops.idle();
    expect(p.srv.ops.last()).toMatchObject({ kind: 'restore', ok: true });

    expect(read(p, 'Saves/Multiplayer/zomboid/map_t.bin')).toBe('time-v1');
    expect(readFileSync(path.join(p.deps.env.pzDataDir, 'Saves/Multiplayer/zomboid/map/10/20.bin'))[0]).toBe(1);
    expect(read(p, 'Server/zomboid.ini')).toContain('PublicName=v1');
    // Accounts weren't selected, so they keep the newer state.
    expect(dbValue(path.join(p.deps.env.pzDataDir, 'db/zomboid.db'), 'whitelist')).toBe('v2');
    expect(p.srv.backups.list().some((x) => x.manifest.trigger === 'pre-restore')).toBe(true);
    // The agent lock was taken and released.
    expect(p.agent.calls).not.toContain('start');

    await c.post('/api/servers/default/backups/undo-restore');
    await p.srv.ops.idle();
    expect(read(p, 'Saves/Multiplayer/zomboid/map_t.bin')).toBe('time-v2');
    expect(read(p, 'Server/zomboid.ini')).toContain('PublicName=v2');
    expect((await c.post('/api/servers/default/backups/undo-restore')).json()).toEqual({ error: 'nothing-to-undo' });
  });

  it('stops a running server, restores, and starts it again', async () => {
    const { p, c } = await setup();
    const b = await p.srv.backups.create({ trigger: 'manual', hot: false });
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
    await c.post(`/api/servers/default/backups/${b.name}/restore`, { parts: ['world'] });
    await p.srv.ops.idle();
    expect(p.agent.calls.filter((x) => x === 'stop' || x === 'start')).toEqual(['stop', 'start']);
    expect(p.srv.ops.last()).toMatchObject({ ok: true });
    // Started fine, so the pre-restore files were cleaned up.
    expect(p.srv.flows.lastRestore()?.trash).toBeNull();
  });

  it('refuses a damaged archive and one from a newer game build', async () => {
    const { p, c } = await setup();
    const b = await p.srv.backups.create({ trigger: 'manual', hot: false });
    const file = path.join(p.deps.env.backupDir, b.name);
    const bytes = readFileSync(file);
    bytes[bytes.length - 5] = bytes[bytes.length - 5]! ^ 0xff;
    writeFileSync(file, bytes);
    await c.post(`/api/servers/default/backups/${b.name}/restore`, { parts: ['world'] });
    await p.srv.ops.idle();
    expect(p.srv.ops.last()).toMatchObject({ ok: false, error: expect.stringMatching(/damaged/) });
    expect(read(p, 'Saves/Multiplayer/zomboid/map_t.bin')).toBe('time-v1');

    const b2 = await p.srv.backups.create({ trigger: 'manual', hot: false });
    const side = path.join(p.deps.env.backupDir, `${b2.name}.json`);
    const meta = JSON.parse(readFileSync(side, 'utf8'));
    meta.manifest.buildId = '99999999';
    writeFileSync(side, JSON.stringify(meta));
    expect((await c.post(`/api/servers/default/backups/${b2.name}/restore`, { parts: ['world'] })).json()).toEqual({ error: 'backup-from-newer-build' });
    expect((await c.post('/api/servers/default/backups/..%2F..%2Fetc/restore', { parts: ['world'] })).statusCode).toBe(400);
  });

  it('never writes outside the staging folder, whatever the archive says', async () => {
    const { p } = await setup();
    for (const evil of ['data/Saves/Multiplayer/zomboid/../../../../escaped.txt', 'data/../escaped.txt', '/escaped.txt', 'escaped.txt']) {
      const tar = await tarOf(async (t) => {
        await t.addBuffer('manifest.json', Buffer.from(JSON.stringify({ format: 1, serverName: 'zomboid', parts: ['world'], bytes: 1 })), 0);
        await t.addBuffer('data/Saves/Multiplayer/zomboid/ok.bin', Buffer.from('ok'), 0);
        await t.addBuffer(evil, Buffer.from('pwned'), 0);
      });
      const name = 'pz-zomboid-20260101T000000Z-upload.tar.zst';
      placeArchive(p, name, tar, { serverName: 'zomboid', parts: ['world'] });
      await expect(p.srv.backups.stage(name, ['world']), evil).rejects.toThrow(/Unsafe path/);
      expect(existsSync(path.join(p.deps.env.pzDataDir, '..', 'escaped.txt'))).toBe(false);
      expect(existsSync(path.join(p.deps.env.pzDataDir, 'escaped.txt'))).toBe(false);
      // Nothing of it stays next to the data.
      expect(stagingLeft(p), evil).toEqual([]);
    }
    expect(read(p, 'Saves/Multiplayer/zomboid/map_t.bin')).toBe('time-v1');
  });

  it("restores another server's backup under this server's names", async () => {
    const { p, c } = await setup();
    // Moving from another machine, where the server had another name (BAK-05).
    const tar = await tarOf(async (t) => {
      await t.addBuffer('manifest.json', Buffer.from(JSON.stringify({ format: 1, serverName: 'oldsrv', parts: ['world', 'configs'] })), 0);
      await t.addDir('data/Saves/Multiplayer/oldsrv/', 0);
      await t.addBuffer('data/Saves/Multiplayer/oldsrv/map_t.bin', Buffer.from('time-old'), 0);
      await t.addBuffer('data/Server/oldsrv.ini', Buffer.from('PublicName=old\n'), 0);
      // Not a path of a chosen part: left out.
      await t.addBuffer('data/Server/unrelated.txt', Buffer.from('x'), 0);
    });
    const name = 'pz-oldsrv-20260101T000000Z-upload.tar.zst';
    placeArchive(p, name, tar, { serverName: 'oldsrv', parts: ['world', 'configs'] });
    await c.post(`/api/servers/default/backups/${name}/restore`, { parts: ['world', 'configs'] });
    await p.srv.ops.idle();
    expect(p.srv.ops.last()).toMatchObject({ kind: 'restore', ok: true });
    expect(read(p, 'Saves/Multiplayer/zomboid/map_t.bin')).toBe('time-old');
    // The world's other files belong to the replaced world, kept in the trash for an undo.
    expect(existsSync(path.join(p.deps.env.pzDataDir, 'Saves/Multiplayer/zomboid/map/10/20.bin'))).toBe(false);
    expect(read(p, 'Server/zomboid.ini')).toBe('PublicName=old\n');
    expect(existsSync(path.join(p.deps.env.pzDataDir, 'Server/unrelated.txt'))).toBe(false);
    expect(existsSync(path.join(p.deps.env.pzDataDir, 'Saves/Multiplayer/oldsrv'))).toBe(false);
    const last = p.srv.flows.lastRestore()!;
    expect(isFolderId(last.trash)).toBe(true);
    // A restore after it can't undo the first one any more: its trash is gone.
    await c.post(`/api/servers/default/backups/${name}/restore`, { parts: ['world'] });
    await p.srv.ops.idle();
    expect(readdirSync(path.join(p.deps.env.pzDataDir, INTERNAL_DIR, 'trash'))).toEqual([p.srv.flows.lastRestore()!.trash]);
  });

  it('treats a trash folder recorded before D11 as nothing to undo', async () => {
    const { p, c } = await setup();
    p.srv.settings.setRaw('lastRestore', { id: 'x', backup: 'b', parts: ['world'], at: '2026-01-01T00:00:00Z', trash: '/data/.trash/x' });
    expect(p.srv.flows.lastRestore()?.trash).toBeNull();
    expect((await c.post('/api/servers/default/backups/undo-restore')).json()).toEqual({ error: 'nothing-to-undo' });
  });
});

describe('download and upload', () => {
  it('lets admins download and the owner upload; not operators', async () => {
    const { p, c } = await setup();
    const b = await p.srv.backups.create({ trigger: 'manual', hot: false });
    const dl = await c.get(`/api/servers/default/backups/${b.name}/download`);
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
      url: '/api/servers/default/backups/upload',
      headers: { origin: 'https://panel.test:8443', cookie: `__Host-gspsid=${c.cookie}`, 'x-gsp-csrf': c.csrf!, 'content-type': `multipart/form-data; boundary=${boundary}` },
      payload: body,
    });
    expect(up.statusCode).toBe(200);
    expect(up.json()).toMatchObject({ name: expect.stringMatching(/-upload\.tar\.zst$/), manifest: { trigger: 'upload', serverName: 'zomboid' } });

    await c.post('/api/users', { username: 'op1', password: 'Temporal-12345', role: 'operator' });
    const op = new Client(p.app);
    await op.post('/api/auth/login', { username: 'op1', password: 'Temporal-12345' });
    await op.post('/api/auth/password', { current: 'Temporal-12345', next: 'Operador-propio-1' });
    expect((await op.get(`/api/servers/default/backups/${b.name}/download`)).statusCode).toBe(403);
    expect((await op.get('/api/servers/default/backups')).statusCode).toBe(200);
    expect((await op.post('/api/servers/default/backups')).statusCode).toBe(200);
    await p.srv.ops.idle();
  });
});
