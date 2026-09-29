// The live log through the whole agent, with real captured boots replayed by
// a stand-in game (console-game.mjs) and each game's own runtime adapter:
// - CON-01: Terraria's first boot (about 30 000 world-generation lines) keeps
//   its start lines in the 5 000-event backlog, each progress run shown as
//   its latest line, every line still classified;
// - PLY-01: the players poll it answers on the console stays out of the log,
//   a person's same command doesn't;
// - Minecraft's and Project Zomboid's boots are shown line for line, as before.
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import type { RuntimeAdapter } from '@gsp/adapter-api';
import { runtimeAdapter } from '@gsp/adapters/runtime';
import { makeRedactor } from '@gsp/formats';
import { launch, makeHarness, TIME_SCALE, type Harness } from './helpers';

const GAME = fileURLToPath(new URL('./console-game.mjs', import.meta.url));
const FIXTURES = fileURLToPath(new URL('../../../fixtures/', import.meta.url));

let h: Harness | null = null;
const dirs: string[] = [];
afterEach(async () => {
  await h?.cleanup();
  h = null;
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

/** A folder for a replayed capture, removed after the test. */
function tempDir(): string {
  const d = mkdtempSync(path.join(os.tmpdir(), 'gsp-livelog-'));
  dirs.push(d);
  return d;
}

/**
 * A captured log as the game printed it: each `# … n more progress lines like
 * these …` note becomes n more copies of the line before it; what was typed
 * (`> `) and the fixture's other notes are left out.
 */
function expanded(file: string): string[] {
  const out: string[] = [];
  const lines = readFileSync(path.join(FIXTURES, file), 'utf8').split(/\r\n|\n|\r/);
  if (lines.at(-1) === '') lines.pop();
  for (const l of lines) {
    const m = /^# … (\d+) more progress lines like these/.exec(l);
    if (m) {
      const prev = out.at(-1)!;
      for (let i = 0; i < Number(m[1]); i++) out.push(prev);
    } else if (!l.startsWith('# ') && !l.startsWith('> ')) out.push(l);
  }
  return out;
}

/**
 * The adapter, with the stand-in game replaying `lines` (then answering its
 * console) in place of the installed one; `classified` counts every line its
 * `classify` reads. `strip` drops what it says about progress (for contrast).
 */
function replaying(dir: string, lines: string[], seen: { classified: number }, o: { strip?: boolean } = {}) {
  const file = path.join(dir, 'replay.log');
  writeFileSync(file, `${lines.join('\n')}\n`);
  return (a: RuntimeAdapter): RuntimeAdapter => ({
    ...a,
    installOnStart: undefined,
    prepare: async () => undefined,
    command: () => ({ argv: [process.execPath, GAME], cwd: os.tmpdir(), env: { REPLAY_FILE: file, PROMPT: '1' } }),
    channel: () => ({ kind: 'stdin' }),
    classify: (line) => {
      seen.classified++;
      const s = a.classify(line);
      if (o.strip) delete s.progress;
      return s;
    },
  });
}

/** The live log's backlog: what a browser opening the console gets, in the order of its events. */
const backlog = (x: Harness) => x.hub.since(0).events.flatMap((e) => (e.event.type === 'log' ? [e.event] : []));
/** The backlog as a console shows it: a progress run's line where the run's first line was. */
const placed = (x: Harness) =>
  x.hub
    .since(0)
    .events.flatMap((e) => (e.event.type === 'log' ? [{ place: e.event.run ?? e.seq, line: e.event.line }] : []))
    .sort((a, b) => a.place - b.place);

async function until(what: string, pred: () => boolean, timeoutMs = 20_000 * TIME_SCALE): Promise<void> {
  const end = Date.now() + timeoutMs;
  while (!pred()) {
    if (Date.now() > end) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

const TERRARIA = { adapter: 'terraria', params: { flavour: 'vanilla', world: 'world', worldSize: 1, maxPlayers: 8, memoryMb: 2048 } };

/** Vanilla Terraria's first boot of a small world as captured, up to where it is ready. */
function terrariaBoot(): string[] {
  const lines = expanded('terraria/1.4.5.8/vanilla/logs/first-boot-small.log');
  // The capture typed `exit` before the world was up: the boot ends where it would have said it started.
  expect(lines.at(-1)).toBe(': Saving before exit...');
  return [...lines.slice(0, -1), ': Server started'];
}

describe('the live log of a first boot that generates a world (CON-01)', () => {
  it('keeps the start lines in the backlog: 30 000 progress lines show as their latest line, and every line is still read', async () => {
    const lines = terrariaBoot();
    expect(lines.length).toBeGreaterThan(30_000);
    const seen = { classified: 0 };
    const dir = tempDir();
    h = await makeHarness({ adapter: 'terraria', ports: {}, logBufferLines: 5000 }, { adapter: replaying(dir, lines, seen) });
    h.agent.setLaunch(TERRARIA);
    await h.agent.start(undefined, undefined);
    // Readiness through the flood: every line reached `classify`.
    await h.waitFor((s) => s.state === 'running', 30_000 * TIME_SCALE);
    expect(seen.classified).toBeGreaterThanOrEqual(lines.length);

    const log = backlog(h);
    expect(log.length).toBeLessThan(40);
    expect(log[0]!.line).toMatch(/^Starting: /);
    // As a console shows it: each run's latest line in the place of its first line.
    const shown = placed(h).map((e) => e.line);
    const from = shown.indexOf('Creating world - Seed: 2035260465, Width: 4200, Height: 1200, Evil: -1, Difficulty: 0');
    expect(shown.slice(0, 5)).toEqual([expect.stringMatching(/^Starting: /), 'Error Logging Enabled.', '', 'Terraria Server v1.4.5.8', '']);
    expect(shown.slice(from)).toEqual([
      'Creating world - Seed: 2035260465, Width: 4200, Height: 1200, Evil: -1, Difficulty: 0',
      // Its runs: resetting objects (open all through the generation, its latest line from the end of it), the generation, loading.
      'Resetting game objects 75%',
      '100.0% - Finalizing world - 0.0%',
      'Loading world data: 13%',
      'Terraria Server v1.4.5.8',
      '',
      'Listening on port 7777',
      "Type 'help' for a list of commands.",
      '',
      'Server started',
    ]);
    expect(log.filter((e) => e.run !== undefined)).toHaveLength(3);
  });

  it('for contrast: without the progress runs the same boot pushes the start lines out of the backlog', async () => {
    const seen = { classified: 0 };
    const dir = tempDir();
    h = await makeHarness({ adapter: 'terraria', ports: {}, logBufferLines: 5000 }, { adapter: replaying(dir, terrariaBoot(), seen, { strip: true }) });
    h.agent.setLaunch(TERRARIA);
    await h.agent.start(undefined, undefined);
    await h.waitFor((s) => s.state === 'running', 30_000 * TIME_SCALE);
    const log = backlog(h);
    expect(log.length).toBeGreaterThan(4_900);
    expect(log.some((e) => /^Starting: /.test(e.line))).toBe(false);
  });
});

describe("the agent's players poll stays out of the live log (PLY-01)", () => {
  it('answers the poll on the console without a line in the log, while a person asking the same sees the reply', async () => {
    const seen = { classified: 0 };
    const dir = tempDir();
    h = await makeHarness({ adapter: 'terraria', ports: {}, playersPollMs: 100 }, { adapter: replaying(dir, ['Terraria Server v1.4.5.8', ': Server started'], seen) });
    h.agent.setLaunch(TERRARIA);
    await h.agent.start(undefined, undefined);
    await h.waitFor((s) => s.state === 'running');
    // Several polls answered: the players are known, and nothing of it is in the log.
    await h.waitFor((s) => s.players !== null && s.players.count === 0);
    const at = h.agent.status().players!.at;
    await h.waitFor((s) => s.players!.at !== at);
    expect(h.logs().filter((l) => /players? connected|playing/.test(l))).toEqual([]);

    expect(await h.agent.command('playing', 'stdin')).toEqual({ via: 'stdin', output: null });
    await until('the reply in the log', () => h!.logs().includes('No players connected.'));
    // Polls go on (after the person's reply had its time), still unseen.
    const after = h.agent.status().players!.at;
    await h.waitFor((s) => s.players!.at !== after, 10_000 * TIME_SCALE);
    expect(h.logs().filter((l) => /players? connected/.test(l))).toEqual(['No players connected.']);

    await h.agent.stop({}, undefined);
    expect(h.agent.status().state).toBe('stopped');
    expect(h.logs()).toContain('Saving before exit...');
  });
});

describe("Minecraft's and Project Zomboid's boots are unchanged (CON-01)", () => {
  const boots: [string, string][] = [
    ['pz', 'pz/b42/logs/first-boot.log'],
    ['minecraft', 'minecraft/26.3/vanilla/logs/first-boot.log'],
    ['minecraft', 'minecraft/26.3/paper/logs/first-boot.log'],
    ['minecraft', 'minecraft/26.3/fabric/logs/first-boot.log'],
    // The one capture with a percentage per step ("Preparing spawn area"): 29 lines, left as they are.
    ['minecraft', 'minecraft/1.16.5/vanilla/logs/first-boot.log'],
  ];

  it('marks no line of any of their captures as progress', () => {
    for (const [id, dir] of [
      ['pz', 'pz'],
      ['minecraft', 'minecraft'],
    ] as const) {
      const adapter = runtimeAdapter(id);
      const files = readdirSync(path.join(FIXTURES, dir), { recursive: true, encoding: 'utf8' }).filter((f) => f.endsWith('.log'));
      expect(files.length).toBeGreaterThan(3);
      for (const f of files) for (const l of expanded(path.join(dir, f))) expect(adapter.classify(l).progress, `${f}: ${l}`).toBeUndefined();
    }
  });

  it.each(boots)('%s %s: every line of the boot in the log, in order', async (id, file) => {
    const lines = expanded(file);
    const seen = { classified: 0 };
    const dir = tempDir();
    h = await makeHarness({ adapter: id, ports: {} }, { adapter: replaying(dir, lines, seen) });
    h.agent.setLaunch({ adapter: id, params: id === 'pz' ? launch : { version: '26.3', loader: 'vanilla', memoryMb: 1024 } });
    await h.agent.start(undefined, undefined);
    await until('the whole boot', () => seen.classified >= lines.length);
    // As the agent shows any line: the adapter's display, then redacted (no secret of this test is in them, only the usual patterns).
    const redact = makeRedactor([]);
    const display = (t: string) => redact(h!.adapter.display?.(t) ?? t);
    await until('the last line shown', () => backlog(h!).some((e) => e.line === display(lines.at(-1)!)));
    expect(backlog(h).filter((e) => e.stream !== 'agent').map((e) => e.line)).toEqual(lines.map(display));
    expect(backlog(h).some((e) => e.run !== undefined)).toBe(false);
  });
});
