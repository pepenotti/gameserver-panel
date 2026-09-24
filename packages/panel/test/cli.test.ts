import { describe, expect, it } from 'vitest';
import { runCli } from '../src/cli/commands';
import { Client, makePanel, ownerReady } from './harness';

async function run(p: Awaited<ReturnType<typeof makePanel>>, ...argv: string[]) {
  const lines: string[] = [];
  const code = await runCli(argv, { db: p.deps.db, backupDir: p.deps.env.backupDir, out: (l) => lines.push(l) });
  return { code, text: lines.join('\n') };
}

describe('panelctl', () => {
  it('lists users and explains itself', async () => {
    const p = await makePanel();
    await ownerReady(p);
    expect((await run(p, 'users')).text).toMatch(/^alice\s+owner\s+2FA on/);
    expect(await run(p)).toMatchObject({ code: 0, text: expect.stringContaining('reset-2fa') });
    expect((await run(p, 'bogus')).code).toBe(2);
    expect(await run(p, 'reset-2fa', 'nobody')).toEqual({ code: 1, text: 'No user named nobody. Run "panelctl users".' });
  });

  it('reset-2fa signs the owner out and makes them enrol again', async () => {
    const p = await makePanel();
    const { client, password } = await ownerReady(p);
    expect((await run(p, 'reset-2fa', 'alice')).code).toBe(0);
    expect((await client.get('/api/status')).statusCode).toBe(401);
    const c = new Client(p.app);
    expect((await c.post('/api/auth/login', { username: 'alice', password })).json()).toMatchObject({ pending: 'enrol' });
    expect(p.deps.audit.list({ action: 'cli.reset-2fa' })[0]).toMatchObject({ target: 'alice', username: null });
  });

  it('reset-password prints a temporary password that must be changed', async () => {
    const p = await makePanel();
    const { client } = await ownerReady(p);
    const { text } = await run(p, 'reset-password', 'alice');
    const temp = /: (\S+)$/m.exec(text)![1]!;
    expect((await client.get('/api/status')).statusCode).toBe(401);
    const c = new Client(p.app);
    const login = (await c.post('/api/auth/login', { username: 'alice', password: temp })).json() as { pending: string };
    // 2FA stays on: the second factor comes before the password change.
    expect(login.pending).toBe('mfa');
    expect(p.deps.users.byName('alice')!.must_change_password).toBe(1);
  });
});
