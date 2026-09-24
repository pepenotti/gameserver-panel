import { readFileSync } from 'node:fs';
import path from 'node:path';

export interface AgentConfig {
  version: string;
  token: string;
  host: string;
  port: number;
  /** Game install (steamcmd force_install_dir). Never edited by us. */
  installDir: string;
  /** PZ `-cachedir`: Server/, Saves/, db/, Logs/. */
  dataDir: string;
  /** Agent state (launch params, RCON secret) lives here, outside PZ's folders. */
  stateDir: string;
  /** steamcmd invocation; tests use the fake (`node tools/fake-pz/steamcmd.mjs`). */
  steamcmd: string[];
  appId: string;
  gamePort: number;
  udpPort: number;
  rconPort: number;
  /**
   * Command that starts the game. Default: the install's start-server.sh.
   * Tests point it at the fake server (`node tools/fake-pz/server.mjs`).
   */
  startCommand: string[];
  readyTimeoutMs: number;
  stopTimeoutMs: number;
  termTimeoutMs: number;
  crashLoop: { count: number; windowMs: number };
  restartDelayMs: number;
  playersPollMs: number;
  /** Consecutive failed RCON polls while running before an `unresponsive` alert. */
  unresponsiveAfter: number;
  logBufferLines: number;
  /** Extra JVM flags always passed (English comments in generated files). */
  baseJvmArgs: string[];
}

/** The image copies the repo's VERSION next to the bundle. */
function bundledVersion(): string {
  try {
    return readFileSync(new URL('./VERSION', import.meta.url), 'utf8').trim();
  } catch {
    return '0.0.0-dev';
  }
}

function num(env: NodeJS.ProcessEnv, key: string, dflt: number): number {
  const v = env[key];
  if (v === undefined || v === '') return dflt;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error(`${key} must be a number`);
  return n;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AgentConfig {
  const token = env.AGENT_TOKEN ?? '';
  if (token.length < 32) throw new Error('AGENT_TOKEN must be set (at least 32 characters)');
  const installDir = env.PZ_INSTALL_DIR ?? '/opt/pz';
  const dataDir = env.PZ_DATA_DIR ?? '/data';
  return {
    version: env.AGENT_VERSION ?? bundledVersion(),
    token,
    host: env.AGENT_HOST ?? '0.0.0.0',
    port: num(env, 'AGENT_PORT', 8081),
    installDir,
    dataDir,
    stateDir: env.AGENT_STATE_DIR ?? path.join(dataDir, '.agent'),
    steamcmd: env.STEAMCMD_COMMAND ? (JSON.parse(env.STEAMCMD_COMMAND) as string[]) : ['/opt/steamcmd/steamcmd.sh'],
    appId: env.PZ_APP_ID ?? '380870',
    gamePort: num(env, 'PZ_GAME_PORT', 16261),
    udpPort: num(env, 'PZ_UDP_PORT', 16262),
    rconPort: num(env, 'PZ_RCON_PORT', 27015),
    startCommand: env.PZ_START_COMMAND ? (JSON.parse(env.PZ_START_COMMAND) as string[]) : [path.join(installDir, 'start-server.sh')],
    readyTimeoutMs: num(env, 'PZ_READY_TIMEOUT_MS', 15 * 60_000),
    stopTimeoutMs: num(env, 'PZ_STOP_TIMEOUT_MS', 180_000),
    termTimeoutMs: num(env, 'PZ_TERM_TIMEOUT_MS', 30_000),
    crashLoop: { count: num(env, 'PZ_CRASH_LOOP_COUNT', 3), windowMs: num(env, 'PZ_CRASH_LOOP_WINDOW_MS', 10 * 60_000) },
    restartDelayMs: num(env, 'PZ_RESTART_DELAY_MS', 10_000),
    playersPollMs: num(env, 'PZ_PLAYERS_POLL_MS', 15_000),
    unresponsiveAfter: num(env, 'PZ_UNRESPONSIVE_AFTER', 8),
    logBufferLines: num(env, 'AGENT_LOG_LINES', 5000),
    baseJvmArgs: ['-Duser.language=en', '-Duser.country=US'],
  };
}
