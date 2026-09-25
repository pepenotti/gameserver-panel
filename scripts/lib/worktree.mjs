// Pure parts of scripts/worktree-env.mjs: what a slot's .env and .env.dev
// contain, and how to read Windows' reserved port ranges.
import { MAX_FAKE_CONTROL, portBlock } from './ports.mjs';

export const projectName = (/** @type {number} */ slot) => `gsp-s${slot}`;
// Never plain localhost: the Caddyfile already has a localhost site, and a duplicate address stops Caddy.
export const devHost = (/** @type {number} */ slot) => `wt${slot}.localhost`;

/** The slot's game ports (B+50…B+99): where its servers publish, as ORCH_HOST_PORTS. */
export const slotGamePorts = (/** @type {number} */ slot) => {
  const g = portBlock(slot).gamePorts;
  return `${g[0]}-${g.at(-1)}`;
};

/**
 * Values a slot's .env must carry on top of .env.example. They keep the
 * slot's stack on 127.0.0.1, inside its port block (its game servers too),
 * under its own project name and image tag, and away from public
 * certificates and DDNS updaters.
 * @param {number} slot
 * @returns {Record<string, string>}
 */
export function slotOverrides(slot) {
  const b = portBlock(slot);
  return {
    COMPOSE_PROJECT_NAME: projectName(slot),
    IMAGE_TAG: `s${slot}`,
    PUBLISH_ADDR: '127.0.0.1',
    PANEL_TLS: 'internal',
    COMPOSE_PROFILES: '',
    PANEL_HOST: devHost(slot),
    LAN_IP: '127.0.0.1',
    PANEL_MEM_LIMIT: '512m',
    PANEL_PORT: String(b.stackHttps),
    PZ_GAME_PORT: String(b.gamePorts[11]),
    PZ_UDP_PORT: String(b.gamePorts[12]),
    ORCH_HOST_PORTS: slotGamePorts(slot),
    ORCH_MAX_MEM_MB: '4096',
    ORCH_MAX_SERVERS: '4',
    ORCH_ALLOW_FAKE: '1',
    BACKUP_DIR: './.tmp/backups',
    VITEST_MAX_WORKERS: '3',
    TEST_TIME_SCALE: '2',
  };
}

/** Contents of a slot's .env.dev, read by scripts/dev.mjs. */
export function devEnvText(/** @type {number} */ slot) {
  const b = portBlock(slot);
  return [
    `# Worktree slot ${slot}: written by scripts/worktree-env.mjs, read by scripts/dev.mjs.`,
    `DEV_HOST=${devHost(slot)}`,
    `DEV_PANEL_PORT=${b.devPanel}`,
    `DEV_AGENT_PORT=${b.devAgents[0]}`,
    `DEV_WEB_PORT=${b.devWeb}`,
    `DEV_RCON_PORT=${b.fakeControl(0)}`,
    // The fake orchestrator: agents of the servers it runs, their inside-the-container ports, their game ports.
    `DEV_ORCH_AGENT_PORTS=${b.devAgents[1]}-${b.devAgents.at(-1)}`,
    `DEV_ORCH_CONTROL_PORTS=${b.fakeControl(1)}-${b.fakeControl(MAX_FAKE_CONTROL)}`,
    `DEV_ORCH_HOST_PORTS=${slotGamePorts(slot)}`,
    'DEV_STATE_DIR=.tmp/dev',
    '',
  ].join('\n');
}

/**
 * Why an existing .env must not be replaced for `slot`, or undefined.
 * Only a .env written for this very slot is replaced without --force.
 * @param {string} current
 * @param {number} slot
 */
export function envConflict(current, slot) {
  const m = /^COMPOSE_PROJECT_NAME=(.*)$/m.exec(current);
  const name = m?.[1]?.trim();
  if (name === projectName(slot)) return undefined;
  if (name) return `.env belongs to project ${name}, not ${projectName(slot)}`;
  return '.env exists and was not written for a worktree slot (no COMPOSE_PROJECT_NAME)';
}

/**
 * Parses `netsh interface ipv4 show excludedportrange protocol=tcp|udp`.
 * @param {string} text
 * @returns {[number, number][]}
 */
export function parseExcludedRanges(text) {
  /** @type {[number, number][]} */
  const out = [];
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*(\d+)\s+(\d+)\s*\*?\s*$/.exec(line);
    if (m) out.push([Number(m[1]), Number(m[2])]);
  }
  return out;
}

/** Ranges that overlap [first, last]. */
export function overlapping(/** @type {[number, number][]} */ ranges, /** @type {number} */ first, /** @type {number} */ last) {
  return ranges.filter(([a, b]) => a <= last && b >= first);
}
