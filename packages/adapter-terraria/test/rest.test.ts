// TShock through its REST API (CON-04, PLY-01, PLY-03, CON-03), against the
// fake TShock server set up by `prepare` exactly as a real one would be: the
// API on the agent's port with the agent's token, never retried, every
// change read back (a ban answers 500 while players are online, yet stores it).
import { type ChildProcess, spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ControlHandle } from '@gsp/adapter-api';
import { terrariaRuntimeAdapter as tr } from '../src/runtime';
import { INSTALL_MARKER, parseTerrariaLaunch, type InstallMarker } from '../src/shared';
import { freePort, testCtx, TIME_SCALE, type TestCtx } from './helpers';

const p = parseTerrariaLaunch({ flavour: 'tshock', world: 'w', worldSize: 1, maxPlayers: 8, memoryMb: 2048 });
let ctx: TestCtx;
let child: ChildProcess;
const out: string[] = [];
/** The actions only need to know the game runs. */
const running = {} as ControlHandle;
const act = (name: string, input: unknown) => tr.actions![name]!.run(ctx, running, tr.actions![name]!.parse(input));

beforeAll(async () => {
  ctx = testCtx({ ports: { game: await freePort(), rest: await freePort() } });
  // TShock as installed (the fake stands in for its app host).
  mkdirSync(path.join(ctx.roots.install, 'tshock-v6.2.1'), { recursive: true });
  writeFileSync(path.join(ctx.roots.install, 'tshock-v6.2.1', 'TShock.Server'), '');
  const marker: InstallMarker = { schema: 1, flavour: 'tshock', version: 'v6.2.1', terraria: '1.4.5.8', channel: 'stable', folder: 'tshock-v6.2.1', sha256: '0'.repeat(64), verified: true, installedAt: '2026-09-29T00:00:00.000Z' };
  writeFileSync(path.join(ctx.roots.install, INSTALL_MARKER), JSON.stringify(marker));
  await tr.prepare(ctx, p);
  const cmd = tr.command(ctx, p);
  child = spawn(cmd.argv[0]!, cmd.argv.slice(1), { cwd: cmd.cwd, env: { ...process.env, ...cmd.env, FAKE_TERRARIA_BOOT_MS: '30', FAKE_TERRARIA_PLAYERS: 'alice,bob' }, stdio: ['pipe', 'pipe', 'pipe'] });
  child.stdout!.on('data', (c: Buffer) => out.push(...c.toString('utf8').split('\n')));
  await new Promise<void>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`the fake did not start:\n${out.join('\n')}`)), 20_000 * TIME_SCALE);
    const check = setInterval(() => {
      if (out.some((l) => tr.classify(l).ready)) {
        clearInterval(check);
        clearTimeout(t);
        resolve();
      }
    }, 20);
  });
}, 60_000 * TIME_SCALE);

afterAll(async () => {
  child?.kill('SIGKILL');
  await new Promise((r) => setTimeout(r, 200));
  ctx?.cleanup();
});

describe("TShock's REST API (CON-04)", () => {
  it('is on because prepare turned it on with the agent\'s token (no setup code was needed)', async () => {
    expect(out.some((l) => l.includes('/setup'))).toBe(false);
    expect(await act('tshock-players', {})).toEqual({
      players: [
        { name: 'alice', account: null, group: 'guest', active: true },
        { name: 'bob', account: null, group: 'guest', active: true },
      ],
    });
  });

  it('lists who is online for the agent quietly, over REST (PLY-01)', async () => {
    const before = out.length;
    expect(await tr.listPlayers!(running, ctx, p)).toEqual({ count: 2, names: ['alice', 'bob'] });
    // Nothing typed on the console, so nothing in TShock's logs.
    expect(out.slice(before).some((l) => l.includes('Server executed'))).toBe(false);
  });

  it('kicks, and says when nobody has that name (PLY-03)', async () => {
    expect(await act('tshock-kick', { name: 'bob', reason: 'Bye' })).toEqual({ ok: true, message: 'Player bob was kicked' });
    expect(await act('tshock-kick', { name: 'nobody' })).toEqual({ ok: false, reason: 'player-not-found', message: 'Player nobody was not found' });
  });

  it('bans by name despite the 500 TShock answers while players are online, kicks the player, and reads it back (PLY-03)', async () => {
    const r = (await act('tshock-ban', { target: { kind: 'name', value: 'alice' }, reason: 'Griefing' })) as { ok: boolean; ticket: number; kicked: string[] };
    expect(r).toMatchObject({ ok: true, kicked: ['alice'] });
    expect(r.ticket).toBeGreaterThan(0);
    expect(await act('tshock-ban', { target: { kind: 'name', value: 'alice' } })).toEqual({ ok: false, reason: 'no-change', message: `Already banned (ticket ${r.ticket})` });
    expect(await act('tshock-ban', { target: { kind: 'ip', value: '192.0.2.77' } })).toMatchObject({ ok: true, kicked: [] });
    const bans = (await act('tshock-bans', {})) as { bans: { ticket: number; kind: string; value: string; reason: string; until: string | null }[] };
    expect(bans.bans.map((b) => [b.kind, b.value, b.until])).toEqual([
      ['name', 'alice', null],
      ['ip', '192.0.2.77', null],
    ]);
    expect(bans.bans[0]!.reason).toBe('Griefing');
  });

  it('unbans by who or by ticket, deleting the ban; unknown tickets change nothing (PLY-03)', async () => {
    expect(await act('tshock-unban', { target: { kind: 'name', value: 'alice' } })).toMatchObject({ ok: true });
    const left = (await act('tshock-bans', {})) as { bans: { ticket: number }[] };
    expect(left.bans).toHaveLength(1);
    expect(await act('tshock-unban', { ticket: left.bans[0]!.ticket })).toMatchObject({ ok: true });
    expect(await act('tshock-bans', {})).toEqual({ bans: [] });
    expect(await act('tshock-unban', { ticket: 999 })).toEqual({ ok: false, reason: 'no-change', message: 'Not banned' });
  });

  it('broadcasts to players (CON-03)', async () => {
    expect(await act('tshock-broadcast', { message: 'Restart in 5 minutes ☃' })).toEqual({ ok: true, message: 'The message was broadcasted successfully' });
    await new Promise((r) => setTimeout(r, 100));
    expect(out).toContain('(Server Broadcast) Restart in 5 minutes ☃');
  });

  it('refuses bad input before it reaches TShock', () => {
    const parse = (name: string, x: unknown) => () => tr.actions![name]!.parse(x);
    expect(parse('tshock-kick', { name: 'a\nb' })).toThrow(/name/);
    expect(parse('tshock-kick', {})).toThrow(/name/);
    expect(parse('tshock-ban', { target: { kind: 'steam', value: '1' } })).toThrow(/target.kind/);
    expect(parse('tshock-ban', { target: { kind: 'ip', value: 'not-an-ip' } })).toThrow(/IP address/);
    expect(parse('tshock-unban', { ticket: 'x' })).toThrow(/ticket/);
    expect(parse('tshock-broadcast', { message: '' })).toThrow(/message/);
    expect(parse('tshock-broadcast', { message: 'x'.repeat(501) })).toThrow(/message/);
    expect(parse('tshock-players', [])).toThrow();
  });

  it('works only while the game runs, only with the right token, and only where TShock is', async () => {
    const a = tr.actions!['tshock-players']!;
    await expect(a.run(ctx, null, {})).rejects.toThrow(/not running/);
    const wrongToken = { ...ctx, state: { ...ctx.state, controlSecret: 'not-the-token' } };
    await expect(a.run(wrongToken, running, {})).rejects.toThrow(/refused the agent's token/);
    const noRest = { ...ctx, ports: { ...ctx.ports, rest: await freePort() } };
    await expect(a.run(noRest, running, {})).rejects.toThrow(/did not answer .*only TShock servers have it/);
  });
});
