import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { iniToRecord, parseIni } from '@gsp/formats';
import { MASK } from '../src/config/service';
import { PROPOSAL_TTL_MS } from '../src/proposals/service';
import { Client, makePanel, ownerReady } from './harness';

const fixtures = fileURLToPath(new URL('../../../fixtures/pz/b42/config/', import.meta.url));

async function setup() {
  const p = await makePanel();
  const dir = path.join(p.deps.env.pzDataDir, 'Server');
  mkdirSync(dir, { recursive: true });
  copyFileSync(path.join(fixtures, 'server.en.ini'), path.join(dir, 'zomboid.ini'));
  const { client } = await ownerReady(p);
  const iniPath = path.join(dir, 'zomboid.ini');
  return { p, c: client, iniPath, ini: () => iniToRecord(parseIni(readFileSync(iniPath, 'utf8'))) };
}

type Preview = { id: string | null; diff: ({ kind: string; text: string } | null)[]; changedKeys: string[]; reapplied: unknown[]; applies: string };

describe('proposals (AST-03)', () => {
  it('are submitted, listed with their diff, and applied only when approved', async () => {
    const { p, c, ini } = await setup();
    const r = (await c.post('/api/config/proposals', { fileId: 'ini', changes: { PVP: 'false' }, note: 'no more PvP' })).json() as Preview;
    expect(r.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(r.diff.filter((l) => l && l.kind !== 'same')).toEqual([
      { kind: 'del', text: 'PVP=true' },
      { kind: 'add', text: 'PVP=false' },
      { kind: 'del', text: 'UPnP=true' },
      { kind: 'add', text: 'UPnP=false' },
    ]);
    // Nothing is written until someone applies it.
    expect(ini().PVP).toBe('true');
    const listed = (await c.get('/api/config/proposals?status=pending')).json() as { id: string; status: string; createdBy: string; actorType: string; fileId: string; note: string }[];
    expect(listed).toMatchObject([{ id: r.id, status: 'pending', createdBy: 'alice', actorType: 'user', fileId: 'ini', note: 'no more PvP' }]);
    const one = (await c.get(`/api/config/proposals/${r.id}`)).json() as { diff: unknown[]; status: string };
    expect(one.status).toBe('pending');
    expect(one.diff).toEqual(r.diff);

    const applied = (await c.post(`/api/config/proposals/${r.id}/apply`)).json() as { applied: string; proposal: { status: string; decidedBy: string } };
    expect(applied).toMatchObject({ applied: 'next-start', proposal: { status: 'applied', decidedBy: 'alice' } });
    expect(ini().PVP).toBe('false');
    expect(p.deps.config.historyOf('ini')[0]).toMatchObject({ note: 'no more PvP', username: 'alice' });
    expect((await c.post(`/api/config/proposals/${r.id}/apply`)).json()).toMatchObject({ error: 'not-pending', status: 'applied' });
    expect(p.deps.audit.list({ action: 'config.propose' })).toHaveLength(1);
  });

  it('can be rejected, and then never applied', async () => {
    const { c, ini } = await setup();
    const { id } = (await c.post('/api/config/proposals', { fileId: 'ini', changes: { MaxPlayers: '4' } })).json() as Preview;
    expect((await c.post(`/api/config/proposals/${id}/reject`)).json()).toMatchObject({ status: 'rejected', decidedBy: 'alice' });
    expect((await c.post(`/api/config/proposals/${id}/apply`)).statusCode).toBe(409);
    expect((await c.post(`/api/config/proposals/${id}/reject`)).statusCode).toBe(409);
    expect(ini().MaxPlayers).toBe('16');
    expect((await c.get('/api/config/proposals?status=rejected')).json()).toHaveLength(1);
  });

  it('are stale when the file changed since they were made (409)', async () => {
    const { c, iniPath, ini } = await setup();
    const content = (await c.get('/api/config/files/content?id=ini')).json() as { text: string; sha256: string };
    const { id } = (await c.post('/api/config/proposals', { fileId: 'ini', text: content.text.replace('PVP=true', 'PVP=false'), baseSha256: content.sha256 })).json() as Preview;
    // The game rewrites the file (or someone edits it by hand) before the proposal is applied.
    writeFileSync(iniPath, readFileSync(iniPath, 'utf8').replace('MaxPlayers=16', 'MaxPlayers=12'));
    const r = await c.post(`/api/config/proposals/${id}/apply`);
    expect(r.statusCode).toBe(409);
    expect(r.json()).toEqual({ error: 'stale' });
    expect(ini()).toMatchObject({ PVP: 'true', MaxPlayers: '12' });
    expect((await c.get(`/api/config/proposals/${id}`)).json()).toMatchObject({ status: 'stale', result: { error: 'stale' } });
    // An editor still showing the old text can't even propose against it.
    expect((await c.post('/api/config/proposals', { fileId: 'ini', text: content.text, baseSha256: content.sha256 })).json()).toEqual({ error: 'stale' });
  });

  it('applying one makes the other pending changes to that file stale', async () => {
    const { c } = await setup();
    const a = (await c.post('/api/config/proposals', { fileId: 'ini', changes: { PVP: 'false' } })).json() as Preview;
    const b = (await c.post('/api/config/proposals', { fileId: 'ini', changes: { MaxPlayers: '8' } })).json() as Preview;
    await c.post(`/api/config/proposals/${a.id}/apply`);
    expect((await c.get(`/api/config/proposals/${b.id}`)).json()).toMatchObject({ status: 'stale' });
    expect((await c.post(`/api/config/proposals/${b.id}/apply`)).statusCode).toBe(409);
  });

  it('expire after a week', async () => {
    const { p, c } = await setup();
    const { id } = (await c.post('/api/config/proposals', { fileId: 'ini', changes: { PVP: 'false' } })).json() as Preview;
    p.deps.db.prepare('UPDATE proposals SET created_at = ? WHERE id = ?').run(new Date(Date.now() - PROPOSAL_TTL_MS - 1000).toISOString(), id);
    expect((await c.post(`/api/config/proposals/${id}/apply`)).json()).toMatchObject({ error: 'expired' });
    expect((await c.get('/api/config/proposals?status=expired')).json()).toHaveLength(1);
  });

  it('keep secrets masked in diffs and storage, and take them from disk when applied', async () => {
    const { p, c, iniPath, ini } = await setup();
    const content = (await c.get('/api/config/files/content?id=ini')).json() as { text: string; sha256: string };
    const r = (await c.post('/api/config/proposals', { fileId: 'ini', text: content.text.replace('Password=\r\n', 'Password=unirse-2026\r\n'), baseSha256: content.sha256 })).json() as Preview;
    expect(r.changedKeys).toContain('Password');
    expect(r.diff.filter((l) => l && l.kind === 'add').map((l) => l!.text)).toContain(`Password=${MASK} (changed)`);
    expect(JSON.stringify(r)).not.toContain('unirse-2026');
    const stored = p.deps.db.prepare('SELECT content FROM proposals WHERE id = ?').get(r.id) as { content: string };
    expect(stored.content).toContain(`RCONPassword=${MASK}`);
    expect(stored.content).not.toContain('<RCON_PASSWORD>');
    // The agent rotates the RCON password meanwhile: a secret-only change doesn't make the proposal stale…
    writeFileSync(iniPath, readFileSync(iniPath, 'utf8').replace('RCONPassword=<RCON_PASSWORD>', 'RCONPassword=rotated-secret'));
    expect((await c.post(`/api/config/proposals/${r.id}/apply`)).statusCode).toBe(200);
    // …and applying it keeps the new one.
    expect(ini()).toMatchObject({ Password: 'unirse-2026', RCONPassword: 'rotated-secret' });
  });

  it('change nothing when there is nothing to change', async () => {
    const { c, iniPath } = await setup();
    // As the agent leaves it after a start (the panel pins UPnP off).
    writeFileSync(iniPath, readFileSync(iniPath, 'utf8').replace('UPnP=true', 'UPnP=false'));
    expect((await c.post('/api/config/proposals', { fileId: 'ini', changes: { PVP: 'true' } })).json()).toMatchObject({ id: null, diff: [], changedKeys: [] });
    expect((await c.get('/api/config/proposals')).json()).toEqual([]);
  });

  it('take exactly one kind of change, typed values, and known files', async () => {
    const { c } = await setup();
    for (const body of [
      { fileId: 'ini' },
      { fileId: 'ini', text: 'PVP=false', changes: { PVP: 'false' } },
      { fileId: 'ini', changes: { PVP: { nested: true } } },
      { fileId: 'ini', text: 'x', baseSha256: 'not-a-hash' },
    ]) {
      expect((await c.post('/api/config/proposals', body)).json(), JSON.stringify(body)).toMatchObject({ error: 'validation' });
    }
    expect((await c.post('/api/config/proposals', { fileId: 'nope', text: 'x' })).json()).toEqual({ error: 'unknown-file' });
    expect((await c.get('/api/config/proposals/00000000-0000-0000-0000-000000000000')).statusCode).toBe(404);
    expect((await c.get('/api/config/proposals?status=bogus')).statusCode).toBe(400);
  });

  it('stay behind sign-in and the CSRF header', async () => {
    const p = await makePanel();
    expect((await new Client(p.app).get('/api/config/proposals')).statusCode).toBe(401);
    const { client } = await ownerReady(p);
    client.csrf = 'wrong';
    expect((await client.post('/api/config/proposals', { fileId: 'ini', text: 'PVP=false' })).json()).toEqual({ error: 'bad-csrf' });
  });

  it('are wired as the panel service', async () => {
    const { p } = await setup();
    const r = await p.deps.changes.propose({ fileId: 'ini', changes: { PVP: 'false' } }, 'alice', 'assistant');
    expect(p.deps.changes.list({ fileId: 'ini' })).toMatchObject([{ id: r.id, actorType: 'assistant' }]);
  });
});
