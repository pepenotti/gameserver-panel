// The contract every runtime adapter passes (NFR-07). Two callers:
//   - the adapter's own package, with its launch params and captured output:
//       runtimeAdapterSuite(pzRuntimeAdapter, { validLaunch, captured: { boot, prompt } });
//   - the agent's tests, with a live host (the agent's process, channel and
//     steamcmd plumbing) that runs the adapter against its fake server:
//       runtimeAdapterSuite(adapter, { validLaunch, live: agentHost(…) });
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Capability, ControlHandle, InstallCtx, LineSignal, RuntimeAdapter, RuntimeCtx } from '../index';
import { metaTests } from './meta';

export interface RuntimeSuiteOptions {
  /** Launch input `parseLaunch` must accept; enables the parsing and live checks. */
  validLaunch?: () => unknown;
  /** Output captured from the real game (fixtures), which the adapter must read right. */
  captured?: {
    /** A boot that comes up: one `ready` line, then a `channelReady` one for adapters with a channel; nothing blocking or fatal. */
    boot: string[];
    /** The version the boot announces, when the game announces one. */
    bootVersion?: string;
    /** A boot that stops at a console prompt nobody will answer. */
    prompt?: string[];
    /** Lines that doom the process. */
    fatal?: string[];
  };
  /** Runs the adapter for real against its fake server; needs `validLaunch`. */
  live?: RuntimeHost;
}

/** The game as a host started it: what the agent would drive. */
export interface LiveGame {
  /** `ready` stays false until `markReady()`, as in the agent. */
  ctl: ControlHandle;
  markReady(): void;
  /** Signals of every line printed so far, in order. */
  readonly signals: readonly LineSignal[];
  /** Hears each next signal; returns an unsubscribe. */
  onSignal(listener: (s: LineSignal) => void): () => void;
  exited: Promise<{ code: number | null; signal: string | null }>;
  kill(): void;
}

/** What the agent provides an adapter at run time, for the live checks. */
export interface RuntimeHost {
  /** Fresh, empty roots, free ports and tools pointing at the fake; a steamcmd driver for `steam` adapters. */
  context(adapter: RuntimeAdapter): Promise<InstallCtx>;
  /** Spawns `adapter.command(ctx, p)` with `adapter.channel(ctx, p)`, every line through `adapter.classify`. */
  start(adapter: RuntimeAdapter, ctx: RuntimeCtx, p: unknown): Promise<LiveGame>;
  /** Kills what is left and removes what the host created. */
  dispose(): Promise<void>;
}

/** Capabilities that need a runtime method to exist. */
const NEEDS: [Capability[], keyof RuntimeAdapter, string][] = [
  [['save'], 'save', 'save()'],
  [['hotBackup'], 'hotCopy', 'hotCopy'],
  [['players'], 'listPlayers', 'listPlayers()'],
  [['branches', 'versionPin'], 'versions', 'versions()'],
];

/** Capabilities that mean the adapter talks to the game over a channel besides stdin. */
const CHANNEL_CAPS: Capability[] = ['rcon', 'restApi'];

const scale = Number(process.env.TEST_TIME_SCALE) || 1;
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, Math.max(0, ms)));

/** Every file under `dir` (relative path → content); what a second `prepare` must leave alone. */
function snapshot(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  let names: string[];
  try {
    names = readdirSync(dir, { recursive: true, encoding: 'utf8' });
  } catch {
    return out;
  }
  for (const rel of names.sort()) {
    try {
      out[rel.split(path.sep).join('/')] = readFileSync(path.join(dir, rel), 'utf8');
    } catch {
      // A folder.
    }
  }
  return out;
}

/** Index of the first signal at or after `from` that matches, or -1 after `timeoutMs`. */
function waitSignal(game: LiveGame, pred: (s: LineSignal) => boolean, timeoutMs: number, from = 0): Promise<number> {
  const hit = game.signals.findIndex((s, i) => i >= from && pred(s));
  if (hit >= 0) return Promise.resolve(hit);
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      off();
      resolve(-1);
    }, timeoutMs);
    const off = game.onSignal((s) => {
      if (!pred(s)) return;
      clearTimeout(timer);
      off();
      resolve(game.signals.lastIndexOf(s));
    });
  });
}

export function runtimeAdapterSuite<P>(adapter: RuntimeAdapter<P>, opts: RuntimeSuiteOptions = {}): void {
  const caps = new Set<Capability>([...adapter.meta.capabilities, ...adapter.meta.flavours.flatMap((f) => f.capabilities ?? [])]);
  const hasChannel = CHANNEL_CAPS.some((c) => caps.has(c));

  describe(`runtime adapter contract: ${adapter.meta.id}`, () => {
    metaTests(adapter.meta);

    it('implements what its capabilities promise', () => {
      const missing = NEEDS.filter(([need, key]) => need.some((c) => caps.has(c)) && adapter[key] === undefined).map(([, , what]) => what);
      expect(missing).toEqual([]);
      if (adapter.installOnStart) expect(adapter.install, 'installOnStart() without install()').toBeDefined();
    });

    it('names its actions with safe ids', () => {
      for (const name of Object.keys(adapter.actions ?? {})) expect(name).toMatch(/^[a-z][a-z0-9-]{0,39}$/);
    });

    it('classifies any line without throwing', () => {
      for (const line of ['', ' ', '\u0000', '> > >', 'x'.repeat(20_000), 'éñ — 😀']) {
        const s = adapter.classify(line);
        expect(typeof s.message).toBe('string');
      }
    });

    if (opts.validLaunch) {
      const valid = opts.validLaunch;
      it('parses valid launch params and refuses junk', () => {
        expect(() => adapter.parseLaunch(valid())).not.toThrow();
        for (const junk of [null, undefined, 42, 'x', []]) expect(() => adapter.parseLaunch(junk)).toThrow();
      });

      it('has absolute, separate default roots', () => {
        const r = adapter.roots(adapter.parseLaunch(valid()));
        // In-container paths: the games run in Linux containers.
        expect(path.posix.isAbsolute(r.data), r.data).toBe(true);
        expect(path.posix.isAbsolute(r.install), r.install).toBe(true);
        expect(r.data).not.toBe(r.install);
      });

      it('redacts the launch secrets it names', () => {
        const secrets = adapter.secrets(adapter.parseLaunch(valid()), { controlSecret: 's'.repeat(48), gameVersion: null });
        expect(secrets).toContain('s'.repeat(48));
        for (const s of secrets) expect(typeof s).toBe('string');
      });
    }

    const captured = opts.captured;
    if (captured) {
      it('reads a captured boot: one ready line, then its channel', () => {
        const signals = captured.boot.map((l) => adapter.classify(l));
        const ready = signals.flatMap((s, i) => (s.ready ? [i] : []));
        expect(ready, 'lines marked `ready`').toHaveLength(1);
        if (hasChannel) expect(signals.findIndex((s, i) => i > ready[0]! && s.channelReady), 'a `channelReady` line after `ready`').toBeGreaterThan(ready[0]!);
        expect(signals.filter((s) => s.blockingPrompt || s.fatal)).toEqual([]);
        if (captured.bootVersion) expect([...new Set(signals.flatMap((s) => (s.version ? [s.version] : [])))]).toEqual([captured.bootVersion]);
      });

      if (captured.prompt) {
        const prompt = captured.prompt;
        it('reads a captured boot that blocks on a console prompt', () => {
          const signals = prompt.map((l) => adapter.classify(l));
          const blocking = signals.filter((s) => s.blockingPrompt);
          expect(blocking.length).toBeGreaterThan(0);
          for (const s of blocking) expect(s.blockingPrompt!.trim()).not.toBe('');
          expect(signals.some((s) => s.ready)).toBe(false);
        });
      }

      if (captured.fatal) {
        const fatal = captured.fatal;
        it('marks fatal lines', () => {
          for (const l of fatal) expect(adapter.classify(l).fatal, l).toBe(true);
        });
      }
    }

    if (opts.live && opts.validLaunch) liveTests(adapter as RuntimeAdapter, opts.live, opts.validLaunch, hasChannel);
  });
}

function liveTests(adapter: RuntimeAdapter, host: RuntimeHost, validLaunch: () => unknown, hasChannel: boolean): void {
  const waitMs = 15_000 * scale;
  const testMs = 60_000 * scale;

  describe('live, against the fake server', () => {
    let ctx: InstallCtx;
    let p: unknown;
    let game: LiveGame | null = null;

    beforeAll(async () => {
      ctx = await host.context(adapter);
      p = adapter.parseLaunch(validLaunch());
    });
    afterAll(async () => {
      game?.kill();
      await host.dispose();
    });

    it('finds nothing installed in empty roots', () => {
      expect(adapter.installed(ctx)).toBeNull();
      if (adapter.installOnStart) expect(adapter.installOnStart(ctx, p)).toBe('required');
    });

    it.runIf(adapter.install !== undefined)(
      'installs, then reports what is installed',
      async () => {
        expect(await adapter.install!(ctx, p, { validate: false })).toMatchObject({ ok: true });
        expect(adapter.installed(ctx)).not.toBeNull();
        if (adapter.installOnStart) expect(adapter.installOnStart(ctx, p)).not.toBe('required');
      },
      testMs,
    );

    it.runIf(adapter.versions !== undefined)(
      'lists versions, and what is installed',
      async () => {
        const r = await adapter.versions!(ctx, p);
        expect(r.versions.length).toBeGreaterThan(0);
        for (const v of r.versions) expect(v.id.trim()).not.toBe('');
        expect(r.installed).toEqual(adapter.installed(ctx));
      },
      testMs,
    );

    it('redacts its channel credentials and prepares idempotently', async () => {
      const channel = adapter.channel(ctx, p);
      const secrets = adapter.secrets(p, ctx.state);
      if (channel.kind === 'rcon') expect(secrets).toContain(channel.password);
      if (channel.kind === 'rest') expect(secrets).toContain(channel.token);
      expect(channel.kind === 'rcon' || channel.kind === 'rest').toBe(hasChannel);
      await adapter.prepare(ctx, p);
      const first = snapshot(ctx.roots.data);
      await adapter.prepare(ctx, p);
      expect(snapshot(ctx.roots.data)).toEqual(first);
    });

    it('launches through the host launcher', () => {
      const cmd = adapter.command(ctx, p);
      const launcher = ctx.tools.launcher ?? [];
      expect(cmd.argv.slice(0, launcher.length)).toEqual(launcher);
      expect(cmd.argv.length).toBeGreaterThan(launcher.length);
      for (const a of cmd.argv) expect(/[\r\n\0]/.test(a), a).toBe(false);
      expect(cmd.cwd.trim()).not.toBe('');
    });

    it(
      'starts and says when it is ready, then when its channel is',
      async () => {
        game = await host.start(adapter, ctx, p);
        const ready = await waitSignal(game, (s) => !!s.ready, waitMs);
        expect(ready, 'a line with `ready`').toBeGreaterThanOrEqual(0);
        if (hasChannel) expect(await waitSignal(game, (s) => !!s.channelReady, waitMs, ready), 'a `channelReady` line after `ready`').toBeGreaterThan(ready);
        expect(game.ctl.ready).toBe(false);
        game.markReady();
        expect(game.ctl.ready).toBe(true);
      },
      testMs,
    );

    it.runIf(adapter.listPlayers !== undefined)('lists who is online', async () => {
      const r = await adapter.listPlayers!(game!.ctl);
      expect(r, 'a reply it understands').not.toBeNull();
      expect(Number.isInteger(r!.count) && r!.count >= 0).toBe(true);
      for (const n of r!.names) expect(n.trim()).not.toBe('');
    });

    it.runIf(adapter.save !== undefined)(
      'saves, and waits for the game to finish',
      async () => {
        await expect(adapter.save!(game!.ctl)).resolves.toBeUndefined();
      },
      testMs,
    );

    it.runIf(adapter.hotCopy !== undefined)(
      'makes the files consistent for a hot copy, then undoes it',
      async () => {
        await adapter.hotCopy!.before(game!.ctl);
        await adapter.hotCopy!.after(game!.ctl);
      },
      testMs,
    );

    it(
      'stops cleanly within its budget',
      async () => {
        const budgetMs = Math.min(adapter.meta.stopBudgetMs, waitMs);
        const t0 = Date.now();
        await adapter.stop(game!.ctl, { budgetMs });
        const exit = await Promise.race([game!.exited, sleep(budgetMs - (Date.now() - t0)).then(() => null)]);
        expect(exit, 'the game exited without signals').not.toBeNull();
        expect(exit!.signal).toBeNull();
        game = null;
      },
      testMs,
    );

    it(
      'asks a game that is still starting to stop without throwing',
      async () => {
        game = await host.start(adapter, ctx, p);
        await expect(adapter.stop(game.ctl, { budgetMs: waitMs })).resolves.toBeUndefined();
        game.kill();
        await game.exited;
        game = null;
      },
      testMs,
    );
  });
}
