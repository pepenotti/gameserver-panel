// What the agent does for the adapter contract's M6 additions (D4):
// - SRV-01: a port that follows another (`PortDecl.follows`) gets its base's
//   number plus its offset when the environment doesn't name it;
// - BAK-02: a running backup an adapter narrows (`hotCopy.select`) copies
//   the picked files as they were picked (hard links), lists and picks again
//   once when a pick vanished, and fails as JSON when one vanishes again;
// - CON-02: a typed console line goes to stdin as the adapter wants it
//   (`consoleLine`);
// - a run's warnings (`LineSignal.warning`) are said once in the log.
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import type http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { unpack } from '@gsp/archive';
import type { PortDecl, RuntimeAdapter, RuntimeCtx } from '@gsp/adapter-api';
import { portNumbers } from '../src/agent';
import { linkSelection, listFiles } from '../src/hot-select';
import { createAgentServer } from '../src/http';
import { envelope, makeHarness, TIME_SCALE, type Harness } from './helpers';

const GAME = fileURLToPath(new URL('./console-game.mjs', import.meta.url));

let h: Harness | null = null;
let server: http.Server | null = null;
let base = '';
const dirs: string[] = [];

afterEach(async () => {
  server?.closeAllConnections();
  await new Promise((r) => (server ? server.close(r) : r(undefined)));
  await h?.cleanup();
  h = server = null;
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

async function setup(adapter: (a: RuntimeAdapter) => RuntimeAdapter, overrides: Parameters<typeof makeHarness>[0] = {}): Promise<Harness> {
  h = await makeHarness(overrides, { adapter });
  mkdirSync(h.cfg.dataDir!, { recursive: true });
  server = createAgentServer(h.agent, h.hub, h.cfg.token);
  await new Promise<void>((r) => server!.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return h;
}

const post = (p: string, body: unknown) => fetch(`${base}${p}`, { method: 'POST', headers: { authorization: `Bearer ${h!.cfg.token}`, 'content-type': 'application/json' }, body: JSON.stringify(body) });

/** An archive's files, with their contents. */
async function filesOf(body: ArrayBuffer): Promise<Record<string, string>> {
  const src = new PassThrough();
  src.end(Buffer.from(body));
  const out: Record<string, string> = {};
  await unpack(src, async (e) => {
    if (e.type !== 'file') return null;
    const chunks: Buffer[] = [];
    const sink = new PassThrough();
    sink.on('data', (c: Buffer) => chunks.push(c));
    sink.on('end', () => (out[e.name] = Buffer.concat(chunks).toString('utf8')));
    return sink;
  });
  return out;
}

async function until(pred: () => boolean, what: string): Promise<void> {
  const end = Date.now() + 8_000 * TIME_SCALE;
  while (!pred()) {
    if (Date.now() > end) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

const label = { en: 'x', es: 'x' };

describe('ports that follow another (SRV-01)', () => {
  const decls: PortDecl[] = [
    { id: 'game', proto: 'udp', default: 2456, publish: true, sameInsideOut: true, label },
    { id: 'query', proto: 'udp', default: 2457, publish: true, sameInsideOut: true, follows: { id: 'game', offset: 1 }, label },
    { id: 'gametcp', proto: 'tcp', default: 2456, publish: true, sameInsideOut: true, follows: { id: 'game', offset: 0 }, label },
    { id: 'rcon', proto: 'tcp', default: 27015, publish: false, sameInsideOut: false, label },
  ];

  it('take their base number plus the offset, unless the environment names them', () => {
    expect(portNumbers(decls, {})).toEqual({ game: 2456, query: 2457, gametcp: 2456, rcon: 27015 });
    expect(portNumbers(decls, { game: 30550 })).toEqual({ game: 30550, query: 30551, gametcp: 30550, rcon: 27015 });
    expect(portNumbers(decls, { game: 30550, query: 30560 })).toEqual({ game: 30550, query: 30560, gametcp: 30550, rcon: 27015 });
  });

  it("reach the adapter's context that way", async () => {
    const seen: RuntimeCtx[] = [];
    const hh = await setup(
      (a) => ({
        ...a,
        meta: { ...a.meta, ports: [...a.meta.ports, { id: 'query', proto: 'udp', default: 16263, publish: true, sameInsideOut: true, follows: { id: 'game', offset: 2 }, label }] },
        prepare: async (ctx, p) => {
          seen.push(ctx);
          await a.prepare(ctx, p);
        },
      }),
      { ports: { game: 30770 } },
    );
    await post('/v1/start', { launch: envelope() });
    await hh.waitFor((s) => s.state === 'running');
    expect(seen[0]!.ports).toMatchObject({ game: 30770, query: 30772 });
  });
});

describe('a running backup an adapter narrows (BAK-02, hotCopy.select)', () => {
  /** The Project Zomboid adapter, with a selection: what it was offered, and a choice that may delete a file first. */
  function selecting(offered: string[][], choose: (files: string[], call: number) => string[], calls: string[]) {
    return (a: RuntimeAdapter): RuntimeAdapter => ({
      ...a,
      hotCopy: {
        sqlite: a.hotCopy?.sqlite,
        before: async (ctl) => {
          calls.push('before');
          await a.hotCopy!.before(ctl);
        },
        after: async (ctl) => {
          await a.hotCopy!.after(ctl);
          calls.push('after');
        },
        select: async (ctx, files) => {
          calls.push('select');
          offered.push(files);
          expect(ctx.roots.data).toBe(h!.cfg.dataDir);
          return choose(files, offered.length);
        },
      },
    });
  }

  it(
    'copies only the picked files, after `before`; a stopped server is copied whole without asking',
    async () => {
      const offered: string[][] = [];
      const calls: string[] = [];
      // A pick of the map files, plus paths nobody offered (never copied).
      const hh = await setup(selecting(offered, (files) => [...files.filter((f) => f.endsWith('.bin')), '../escape', 'db/other.db'], calls));
      await post('/v1/start', { launch: envelope() });
      await hh.waitFor((s) => s.state === 'running');
      writeFileSync(path.join(hh.cfg.dataDir!, 'Saves', 'notes.txt'), 'not picked');

      const r = await post('/v1/archive/pack', { root: 'data', rels: ['Saves', 'db'], prefix: 'data/' });
      expect(r.status).toBe(200);
      const got = await filesOf(await r.arrayBuffer());
      expect(Object.keys(got).length).toBeGreaterThan(0);
      expect(Object.keys(got).every((n) => n.startsWith('data/Saves/') && n.endsWith('.bin'))).toBe(true);
      expect(offered[0]).toEqual(expect.arrayContaining(['Saves/notes.txt', 'db/testsrv.db']));
      await until(() => calls.at(-1) === 'after', 'after');
      expect(calls).toEqual(['before', 'select', 'after']);
      // Nothing of the links is left behind, and they never show in the data root's listing.
      expect(readdirSync(path.join(hh.cfg.dataDir!, '.gsp-files', 'selected'))).toEqual([]);

      await post('/v1/stop', {});
      await hh.waitFor((s) => s.state === 'stopped');
      const whole = await post('/v1/archive/pack', { root: 'data', rels: ['Saves'], prefix: 'data/' });
      expect(Object.keys(await filesOf(await whole.arrayBuffer()))).toContain('data/Saves/notes.txt');
      expect(calls).toEqual(['before', 'select', 'after']);
    },
    60_000 * TIME_SCALE,
  );

  it(
    'picks again, once, when a picked file vanished before it was taken (a save moved on)',
    async () => {
      const offered: string[][] = [];
      const calls: string[] = [];
      let gone = '';
      const hh = await setup(
        selecting(
          offered,
          (files, call) => {
            const pick = files.filter((f) => f.endsWith('.bin'));
            // The game deletes the oldest set while the first pick is taken.
            if (call === 1) {
              gone = pick[0]!;
              unlinkSync(path.join(h!.cfg.dataDir!, ...gone.split('/')));
            }
            return pick;
          },
          calls,
        ),
      );
      await post('/v1/start', { launch: envelope() });
      await hh.waitFor((s) => s.state === 'running');
      for (const n of ['set.1.bin', 'set.2.bin']) writeFileSync(path.join(hh.cfg.dataDir!, 'Saves', n), n);
      const r = await post('/v1/archive/pack', { root: 'data', rels: ['Saves'], prefix: 'data/' });
      expect(r.status).toBe(200);
      const got = await filesOf(await r.arrayBuffer());
      expect(offered).toHaveLength(2);
      expect(offered[1]).not.toContain(gone);
      expect(Object.keys(got)).not.toContain(`data/${gone}`);
      expect(Object.keys(got).length).toBeGreaterThan(0);
      await until(() => calls.at(-1) === 'after', 'after');
      expect(calls).toEqual(['before', 'select', 'select', 'after']);
      expect(hh.logs().some((l) => l.includes(`Backup: ${gone} vanished while the backup picked its files; picking the files again.`))).toBe(true);
    },
    60_000 * TIME_SCALE,
  );

  it(
    'fails the backup as JSON when a pick vanishes again, after running `after`',
    async () => {
      const calls: string[] = [];
      const hh = await setup(
        selecting(
          [],
          (files) => {
            const pick = files.filter((f) => f.endsWith('.bin'));
            unlinkSync(path.join(h!.cfg.dataDir!, ...pick[0]!.split('/')));
            return pick;
          },
          calls,
        ),
      );
      await post('/v1/start', { launch: envelope() });
      await hh.waitFor((s) => s.state === 'running');
      for (const n of ['set.1.bin', 'set.2.bin']) writeFileSync(path.join(hh.cfg.dataDir!, 'Saves', n), n);
      const r = await post('/v1/archive/pack', { root: 'data', rels: ['Saves'] });
      expect(r.status).toBe(503);
      expect(await r.json()).toMatchObject({ code: 'unavailable', error: expect.stringMatching(/files could not be picked for a copy: .* vanished while the backup picked its files/) });
      expect(calls).toEqual(['before', 'select', 'select', 'after']);
      expect(readdirSync(path.join(hh.cfg.dataDir!, '.gsp-files', 'selected'))).toEqual([]);
      // A bad path is refused before the game is asked anything.
      const bad = await post('/v1/archive/pack', { root: 'data', rels: ['../x'] });
      expect(bad.status).toBe(400);
      expect(calls).toHaveLength(4);
    },
    60_000 * TIME_SCALE,
  );

  it('keeps a picked file as it was picked, whatever the game does to it afterwards', async () => {
    const data = path.join(os.tmpdir(), `gsp-select-${process.pid}-${Date.now()}`);
    dirs.push(data);
    mkdirSync(path.join(data, 'world', 'sets'), { recursive: true });
    mkdirSync(path.join(data, '.agent'), { recursive: true });
    writeFileSync(path.join(data, 'world', 'sets', 'a.1'), 'one');
    writeFileSync(path.join(data, 'world', 'sets', 'a.2'), 'two');
    writeFileSync(path.join(data, 'world', 'keep.txt'), 'keep');
    writeFileSync(path.join(data, '.agent', 'state.json'), '{}');
    expect(await listFiles(data, ['world', '.agent'], [path.join(data, '.agent')])).toEqual(['world/keep.txt', 'world/sets/a.1', 'world/sets/a.2']);
    const dir = await linkSelection({ data, hidden: [], rels: ['world'], select: async (files) => files.filter((f) => f.endsWith('.2')) });
    // The game deletes the set and writes a new one under the same name, through a rename.
    unlinkSync(path.join(data, 'world', 'sets', 'a.2'));
    writeFileSync(path.join(data, 'world', 'sets', 'a.2.tmp'), 'three');
    rmSync(path.join(data, 'world', 'sets', 'a.1'));
    expect(readFileSync(path.join(dir, 'world', 'sets', 'a.2'), 'utf8')).toBe('two');
    expect(existsSync(path.join(dir, 'world', 'sets', 'a.1'))).toBe(false);
    expect(path.dirname(path.dirname(dir))).toBe(path.join(data, '.gsp-files'));
  });
});

describe('typed console lines and warnings', () => {
  /** The stand-in console game in place of the installed one: it echoes what it is sent. */
  const consoleGame =
    (more: Partial<RuntimeAdapter> = {}) =>
    (a: RuntimeAdapter): RuntimeAdapter => ({
      ...a,
      installOnStart: undefined,
      prepare: async () => undefined,
      command: () => ({ argv: [process.execPath, GAME], cwd: os.tmpdir() }),
      channel: () => ({ kind: 'stdin' }),
      classify: (line) => ({ message: line, ...(line === 'up' ? { ready: true } : {}), ...(line.startsWith('echo: warn') ? { warning: { en: 'The game runs without Steam.', es: 'El juego funciona sin Steam.' } } : {}) }),
      ...more,
    });

  it('sends a typed line to stdin as the adapter wants it (CON-02)', async () => {
    const hh = await setup(consoleGame({ consoleLine: (c) => (c.startsWith('/') ? c : `/${c}`) }));
    await post('/v1/start', { launch: envelope() });
    await hh.waitFor((s) => s.state === 'running');
    await hh.agent.command('players', undefined);
    await until(() => hh.logs().includes('echo: /players'), 'the prefixed line');
    await hh.agent.command('/seed', undefined);
    await until(() => hh.logs().includes('echo: /seed'), 'the line as typed');
  });

  it('says a warning once per run, in the log', async () => {
    const hh = await setup(consoleGame());
    await post('/v1/start', { launch: envelope() });
    await hh.waitFor((s) => s.state === 'running');
    await hh.agent.command('warn 1', 'stdin');
    await hh.agent.command('warn 2', 'stdin');
    await until(() => hh.logs().includes('echo: warn 2'), 'the second warning line');
    expect(hh.logs().filter((l) => l === 'Warning: The game runs without Steam.')).toHaveLength(1);
  });
});
