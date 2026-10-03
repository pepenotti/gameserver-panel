import { readFileSync } from 'node:fs';
import path from 'node:path';

export interface AgentConfig {
  version: string;
  token: string;
  host: string;
  port: number;
  /** Runtime adapter id (`GAME_ADAPTER`). */
  adapter: string;
  /**
   * The server's flavour (`GAME_FLAVOUR`, from its spec); null for adapters
   * without flavours. A flavour may run in another image family than its
   * adapter (`Flavour.runtime`), and installs get that family's tools.
   */
  flavour: string | null;
  /**
   * `install-job` (`GSP_AGENT_MODE`, set by the orchestrator on an install
   * job, HST-09): install, warm up, link the redirects, write the
   * shared-install marker, and never start the game. `server` otherwise.
   */
  mode: 'server' | 'install-job';
  /**
   * The install root is a shared install mounted read-only
   * (`GSP_INSTALL_SHARED=1`, set by the orchestrator, HST-09): no install,
   * update or validate; a launch that wants another install fails its start.
   */
  installShared: boolean;
  /**
   * Relocate the adapter's install and data roots (`GAME_INSTALL_DIR`,
   * `GAME_DATA_DIR`; the image, the dev loop and tests set them). Null: the
   * adapter's own `roots()` once a launch is stored.
   */
  installDir: string | null;
  dataDir: string | null;
  /** Agent state (launch params, generated secrets) lives here, outside the game's folders. */
  stateDir: string;
  /** steamcmd invocation; tests use the fake (`node tools/fake-pz/steamcmd.mjs`). */
  steamcmd: string[];
  /** HOME for tools that keep state there (steamcmd). */
  home: string;
  /**
   * Replaces the adapter's launcher (`GAME_START_COMMAND`, a JSON array):
   * tests and the dev loop start a fake server.
   */
  launcher: string[] | null;
  /** Port numbers by `PortDecl.id` (`GAME_PORT_<ID>`); the rest use the adapter's defaults. */
  ports: Record<string, number>;
  readyTimeoutMs: number;
  /** Clean-stop budget; null: the adapter's `meta.stopBudgetMs`. */
  stopTimeoutMs: number | null;
  termTimeoutMs: number;
  crashLoop: { count: number; windowMs: number };
  restartDelayMs: number;
  playersPollMs: number;
  /** Consecutive failed player polls while running before an `unresponsive` alert. */
  unresponsiveAfter: number;
  /** After the game says it's up, how long its control channel gets to say so too. */
  channelGraceMs: number;
  logBufferLines: number;
}

/** The image copies the repo's VERSION next to the bundle. */
function bundledVersion(): string {
  try {
    return readFileSync(new URL('./VERSION', import.meta.url), 'utf8').trim();
  } catch {
    return '0.0.0-dev';
  }
}

/**
 * The first of `keys` that is set. The agent's settings used to be named
 * after its first game (`PZ_*`); those names still work as fallbacks.
 */
function pick(env: NodeJS.ProcessEnv, ...keys: string[]): { key: string; value: string } | null {
  for (const key of keys) {
    const value = env[key];
    if (value !== undefined && value !== '') return { key, value };
  }
  return null;
}

function num(env: NodeJS.ProcessEnv, keys: string[], dflt: number): number {
  const v = pick(env, ...keys);
  if (!v) return dflt;
  const n = Number(v.value);
  if (!Number.isFinite(n)) throw new Error(`${v.key} must be a number`);
  return n;
}

function argv(env: NodeJS.ProcessEnv, keys: string[]): string[] | null {
  const v = pick(env, ...keys);
  if (!v) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(v.value);
  } catch {
    parsed = null;
  }
  if (!Array.isArray(parsed) || parsed.length === 0 || !parsed.every((a) => typeof a === 'string')) throw new Error(`${v.key} must be a JSON array of strings`);
  return parsed as string[];
}

/** `GAME_PORT_<ID>` overrides, e.g. `GAME_PORT_RCON=27015`. */
function ports(env: NodeJS.ProcessEnv): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [key, value] of Object.entries(env)) {
    const m = /^GAME_PORT_([A-Z0-9_]+)$/.exec(key);
    if (!m || value === undefined || value === '') continue;
    const n = Number(value);
    if (!Number.isInteger(n) || n < 1 || n > 65535) throw new Error(`${key} must be a port number`);
    out[m[1]!.toLowerCase()] = n;
  }
  return out;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AgentConfig {
  const token = env.AGENT_TOKEN ?? '';
  if (token.length < 32) throw new Error('AGENT_TOKEN must be set (at least 32 characters)');
  const adapter = pick(env, 'GAME_ADAPTER')?.value ?? 'pz';
  const flavour = pick(env, 'GAME_FLAVOUR')?.value ?? null;
  if (flavour !== null && !/^[a-z0-9][a-z0-9._-]{0,39}$/.test(flavour)) throw new Error('GAME_FLAVOUR must be a flavour id');
  const mode = env.GSP_AGENT_MODE ?? '';
  if (mode !== '' && mode !== 'install-job') throw new Error('GSP_AGENT_MODE must be install-job, or unset');
  const shared = env.GSP_INSTALL_SHARED ?? '';
  if (shared !== '' && shared !== '0' && shared !== '1') throw new Error('GSP_INSTALL_SHARED must be 0 or 1');
  if (mode === 'install-job' && shared === '1') throw new Error('An install job writes its install: GSP_INSTALL_SHARED is for servers');
  const installDir = pick(env, 'GAME_INSTALL_DIR', 'PZ_INSTALL_DIR')?.value ?? null;
  const dataDir = pick(env, 'GAME_DATA_DIR', 'PZ_DATA_DIR')?.value ?? null;
  const stop = pick(env, 'GAME_STOP_TIMEOUT_MS', 'PZ_STOP_TIMEOUT_MS');
  return {
    version: env.AGENT_VERSION ?? bundledVersion(),
    token,
    host: env.AGENT_HOST ?? '0.0.0.0',
    port: num(env, ['AGENT_PORT'], 8081),
    adapter,
    flavour,
    mode: mode === 'install-job' ? 'install-job' : 'server',
    installShared: shared === '1',
    installDir,
    dataDir,
    stateDir: env.AGENT_STATE_DIR ?? path.join(dataDir ?? '/data', '.agent'),
    steamcmd: argv(env, ['STEAMCMD_COMMAND']) ?? ['/opt/steamcmd/steamcmd.sh'],
    home: env.HOME ?? '/home/node',
    launcher: argv(env, ['GAME_START_COMMAND', 'PZ_START_COMMAND']),
    ports: ports(env),
    readyTimeoutMs: num(env, ['GAME_READY_TIMEOUT_MS', 'PZ_READY_TIMEOUT_MS'], 15 * 60_000),
    stopTimeoutMs: stop ? num(env, [stop.key], 0) : null,
    termTimeoutMs: num(env, ['GAME_TERM_TIMEOUT_MS', 'PZ_TERM_TIMEOUT_MS'], 30_000),
    crashLoop: {
      count: num(env, ['GAME_CRASH_LOOP_COUNT', 'PZ_CRASH_LOOP_COUNT'], 3),
      windowMs: num(env, ['GAME_CRASH_LOOP_WINDOW_MS', 'PZ_CRASH_LOOP_WINDOW_MS'], 10 * 60_000),
    },
    restartDelayMs: num(env, ['GAME_RESTART_DELAY_MS', 'PZ_RESTART_DELAY_MS'], 10_000),
    playersPollMs: num(env, ['GAME_PLAYERS_POLL_MS', 'PZ_PLAYERS_POLL_MS'], 15_000),
    unresponsiveAfter: num(env, ['GAME_UNRESPONSIVE_AFTER', 'PZ_UNRESPONSIVE_AFTER'], 8),
    channelGraceMs: 10_000,
    logBufferLines: num(env, ['AGENT_LOG_LINES'], 5000),
  };
}
