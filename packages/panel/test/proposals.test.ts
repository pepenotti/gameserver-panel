import { describe, expect, it } from 'vitest';
import { Client, makePanel, ownerReady } from './harness';

describe('proposals (reserved)', () => {
  it('answer 501 to admins and stay behind sign-in', async () => {
    const p = await makePanel();
    expect((await new Client(p.app).get('/api/proposals')).statusCode).toBe(401);
    const { client } = await ownerReady(p);
    const list = await client.get('/api/proposals');
    expect(list.statusCode).toBe(501);
    expect(list.json()).toEqual({ error: 'not-implemented' });
    expect((await client.post('/api/proposals', { target: { kind: 'config', fileId: 'ini' }, text: 'PVP=false' })).statusCode).toBe(501);
    expect((await client.post('/api/proposals/1/apply')).statusCode).toBe(501);
  });

  it('are wired as a service that is not implemented yet', async () => {
    const p = await makePanel();
    expect(() => p.deps.changes.list()).toThrow(/not-implemented/);
    await expect(p.deps.changes.propose({ target: { kind: 'config', fileId: 'ini' }, text: '' }, null)).rejects.toThrow(/not-implemented/);
  });
});
