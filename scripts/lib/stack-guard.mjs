// Pure guard logic for scripts/stack.mjs: decides whether a Compose command
// may run for this worktree's stack. No Docker and no I/O here, so the rules
// are unit-tested; stack.mjs gathers the facts and asks.
import { portBlock } from './ports.mjs';

export const PROJECT_RE = /^gsp-s(\d)$/;

/**
 * KEY=VALUE lines of an env file (comments and blanks skipped, matching
 * single or double quotes stripped). Later keys win, like Compose.
 * @param {string} text
 * @returns {Record<string, string>}
 */
export function parseEnvFile(text) {
  /** @type {Record<string, string>} */
  const out = {};
  for (const raw of text.split(/\r?\n/)) {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/.exec(raw);
    if (!m) continue;
    let v = (m[2] ?? '').trim();
    if (v.length >= 2 && (v[0] === '"' || v[0] === "'") && v.at(-1) === v[0]) v = v.slice(1, -1);
    out[m[1] ?? ''] = v;
  }
  return out;
}

/** Names in info/protected-projects: one per line, '#' comments. */
export function parseNameList(/** @type {string} */ text) {
  return text
    .split(/\r?\n/)
    .map((l) => l.replace(/#.*/, '').trim())
    .filter(Boolean);
}

/**
 * Reasons this env must not drive Compose; empty when it may.
 * @param {Record<string, string>} env
 * @param {string[]} protectedProjects
 */
export function checkEnv(env, protectedProjects) {
  /** @type {string[]} */
  const reasons = [];
  const name = env.COMPOSE_PROJECT_NAME ?? '';
  if (!PROJECT_RE.test(name)) reasons.push(`COMPOSE_PROJECT_NAME must look like gsp-s<slot> (got ${JSON.stringify(name)}); run node scripts/worktree-env.mjs --slot N`);
  if (protectedProjects.some((p) => p.toLowerCase() === name.toLowerCase())) reasons.push(`project ${name} is protected on this machine (info/protected-projects)`);
  if (env.PANEL_TLS !== 'internal') reasons.push('PANEL_TLS must be internal (no public certificates from a worktree)');
  if ((env.COMPOSE_PROFILES ?? '') !== '') reasons.push('COMPOSE_PROFILES must be empty (no DDNS updaters from a worktree)');
  if (env.PUBLISH_ADDR !== '127.0.0.1') reasons.push('PUBLISH_ADDR must be 127.0.0.1 (worktree stacks stay on this machine)');
  if (env.COMPOSE_FILE !== undefined) reasons.push('COMPOSE_FILE must not be set; stack.mjs always uses compose.yaml');
  return reasons;
}

/** The slot a project name belongs to, e.g. gsp-s1 → 1. */
export function slotOf(/** @type {string} */ project) {
  const m = PROJECT_RE.exec(project);
  return m ? Number(m[1]) : undefined;
}

/**
 * @typedef {{ port: number; protocol: string; hostIp: string; service: string }} Published
 */

/** "30150-30152" or 30150 → [30150, 30151, 30152] */
function expandPorts(/** @type {string | number} */ spec) {
  const [a, b] = String(spec).split('-').map((s) => Number(s));
  if (!Number.isInteger(a) || (b !== undefined && !Number.isInteger(b))) return [];
  const last = b ?? a;
  return Array.from({ length: Math.max(0, last - a + 1) }, (_, i) => a + i);
}

/**
 * Host ports published by a rendered project (`docker compose config --format json`).
 * @param {{ services?: Record<string, { ports?: { published?: string | number; protocol?: string; host_ip?: string }[] }> }} config
 * @returns {Published[]}
 */
export function publishedPorts(config) {
  /** @type {Published[]} */
  const out = [];
  for (const [service, s] of Object.entries(config.services ?? {})) {
    for (const p of s.ports ?? []) {
      if (p.published === undefined || p.published === '') continue;
      for (const port of expandPorts(p.published)) out.push({ port, protocol: p.protocol ?? 'tcp', hostIp: p.host_ip ?? '', service });
    }
  }
  return out;
}

/**
 * Reasons the rendered ports are unsafe for this slot: every published port
 * must be bound to 127.0.0.1 and lie inside the slot's block.
 * @param {Published[]} ports
 * @param {number} slot
 */
export function checkPublished(ports, slot) {
  const [first, last] = portBlock(slot).range;
  /** @type {string[]} */
  const reasons = [];
  for (const p of ports) {
    if (p.hostIp !== '127.0.0.1') reasons.push(`${p.service} publishes ${p.port}/${p.protocol} on ${p.hostIp || 'every address'}, not 127.0.0.1`);
    if (p.port < first || p.port > last) reasons.push(`${p.service} publishes ${p.port}/${p.protocol}, outside slot ${slot}'s block ${first}-${last}`);
  }
  return reasons;
}

/**
 * `ORCH_HOST_PORTS` as inclusive ranges ("30150-30199,30160" → [[30150,30199],[30160,30160]]),
 * or null when it isn't a list of ports and ranges.
 * @param {string} text
 * @returns {[number, number][] | null}
 */
export function parsePortList(text) {
  /** @type {[number, number][]} */
  const out = [];
  for (const part of text.split(',').map((s) => s.trim())) {
    const m = /^(\d{1,5})(?:-(\d{1,5}))?$/.exec(part);
    if (!m) return null;
    const a = Number(m[1]);
    const b = m[2] === undefined ? a : Number(m[2]);
    if (a > b) return null;
    out.push([a, b]);
  }
  return out;
}

/**
 * Reasons the rendered orchestrator could reach outside this slot. It must
 * have no network and publish nothing itself, and the game servers it
 * creates must publish on 127.0.0.1 and only inside the slot's game ports
 * (B+50…B+99), where the rendered ports check can't see them.
 * @param {{ services?: Record<string, { network_mode?: string; networks?: unknown; ports?: unknown[]; environment?: Record<string, string | null> }> }} config
 * @param {number} slot
 */
export function checkOrchestrator(config, slot) {
  const o = config.services?.orchestrator;
  if (!o) return [];
  const games = portBlock(slot).gamePorts;
  const [first, last] = [games[0] ?? 0, games.at(-1) ?? 0];
  /** @type {string[]} */
  const reasons = [];
  if (o.network_mode !== 'none') reasons.push(`the orchestrator must have no network (network_mode: none), not ${o.network_mode ?? 'the default network'}`);
  if (o.ports?.length) reasons.push('the orchestrator must not publish ports');
  const env = o.environment ?? {};
  if (env.ORCH_PUBLISH_ADDR !== '127.0.0.1') reasons.push(`the orchestrator would publish game servers on ${env.ORCH_PUBLISH_ADDR || 'every address'}, not 127.0.0.1`);
  const ranges = parsePortList(env.ORCH_HOST_PORTS ?? '');
  if (!ranges) reasons.push(`ORCH_HOST_PORTS ${JSON.stringify(env.ORCH_HOST_PORTS ?? '')} is not a list of ports and ranges`);
  for (const [a, b] of ranges ?? []) {
    if (a < first || b > last) reasons.push(`ORCH_HOST_PORTS ${a === b ? a : `${a}-${b}`} is outside slot ${slot}'s game ports ${first}-${last}`);
  }
  return reasons;
}

/** The label the orchestrator puts on everything it creates for a stack. */
export const serverLabel = (/** @type {string} */ project) => `label=gsp.stack=${project}`;

/**
 * Docker commands that remove what the orchestrator created for `project`
 * (its game servers' containers and networks, and with `volumes` their
 * volumes): Compose doesn't know them, so `down` and `clean` do this after
 * Compose. Containers stop first, with their own stop timeout (a clean save).
 * @param {string} project
 * @param {{ containers: string[]; networks: string[]; volumes: string[] }} found  ids from `docker ps -aq` / `network ls -q` / `volume ls -q` filtered by `serverLabel`
 * @param {boolean} volumes
 * @returns {string[][]}
 */
export function serverCleanup(project, found, volumes) {
  if (!PROJECT_RE.test(project)) throw new Error(`not a slot project: ${project}`);
  const ok = (/** @type {string} */ id) => /^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(id);
  /** @type {string[][]} */
  const out = [];
  const containers = found.containers.filter(ok);
  if (containers.length) out.push(['stop', ...containers], ['rm', ...containers]);
  const networks = found.networks.filter(ok);
  if (networks.length) out.push(['network', 'rm', ...networks]);
  const vols = found.volumes.filter(ok);
  if (volumes && vols.length) out.push(['volume', 'rm', ...vols]);
  return out;
}

/** Whether Compose arguments drop volumes (`down -v`, `--volumes`). */
export const dropsVolumes = (/** @type {string[]} */ args) => args.slice(1).some((a) => a === '--volumes' || a.startsWith('--volumes=') || /^-[a-zA-Z]*v[a-zA-Z]*$/.test(a));

/**
 * Parses `docker ps --format '{{.Label "com.docker.compose.project"}}\t{{.Ports}}'`.
 * @param {string} text
 * @returns {{ project: string; ports: { port: number; protocol: string }[] }[]}
 */
export function parseDockerPs(text) {
  return text
    .split(/\r?\n/)
    .filter((l) => l.trim() !== '')
    .map((l) => {
      const tab = l.indexOf('\t');
      const project = tab >= 0 ? l.slice(0, tab).trim() : '';
      const portsText = tab >= 0 ? l.slice(tab + 1) : l;
      /** @type {{ port: number; protocol: string }[]} */
      const ports = [];
      for (const part of portsText.split(',')) {
        // 0.0.0.0:16261-16262->16261-16262/udp, [::]:8443->8443/tcp; "8081/tcp" is not published.
        const m = /:(\d+(?:-\d+)?)->[\d-]+\/(\w+)/.exec(part.trim());
        if (!m) continue;
        for (const port of expandPorts(m[1] ?? '')) ports.push({ port, protocol: m[2] ?? 'tcp' });
      }
      return { project, ports };
    });
}

/**
 * Our ports that a running container of another project already publishes.
 * @param {Published[]} ours
 * @param {{ project: string; ports: { port: number; protocol: string }[] }[]} running
 * @param {string} project
 */
export function portConflicts(ours, running, project) {
  /** @type {string[]} */
  const reasons = [];
  for (const c of running) {
    if (c.project === project) continue;
    for (const p of ours) {
      if (c.ports.some((q) => q.port === p.port && q.protocol === p.protocol)) {
        reasons.push(`${p.port}/${p.protocol} is already published by ${c.project ? `project ${c.project}` : 'a container outside Compose'}`);
      }
    }
  }
  return [...new Set(reasons)];
}

/** Compose flags that would pick another project, file, env or publish address. */
const FORBIDDEN = /^(-p|--project-name|--project-directory|--env-file|--file|--profile|--publish|--all-resources)(=|$)|^-p./;
/** Subcommands whose own -f is harmless (--follow, --force). */
const OWN_F = new Set(['logs', 'rm']);

/**
 * Turns stack.mjs arguments into Compose arguments, or refuses.
 * @param {string[]} input
 * @returns {{ args: string[] } | { error: string }}
 */
export function planCompose(input) {
  const yes = input.includes('--yes-this-stack');
  let args = input.filter((a) => a !== '--yes-this-stack');
  if (args.length === 0) return { error: 'no Compose command given (e.g. config, up -d --build, ps, logs -f, down, clean)' };
  if (args[0]?.startsWith('-')) return { error: `global Compose flags are not allowed (${args[0]}); stack.mjs sets the project, env file and compose file` };
  const sub = args[0];
  if (sub === 'clean') args = ['down', '--volumes', '--rmi', 'local', ...args.slice(1)];
  for (const a of args.slice(1)) {
    if (FORBIDDEN.test(a)) return { error: `${a} is not allowed through stack.mjs` };
    if ((a === '-f' || /^-[a-zA-Z]*f/.test(a)) && !OWN_F.has(args[0] ?? '')) return { error: `${a} is not allowed through stack.mjs` };
  }
  const rmi = args.findIndex((a) => a === '--rmi' || a.startsWith('--rmi='));
  if (rmi >= 0) {
    const value = args[rmi]?.includes('=') ? args[rmi]?.split('=')[1] : args[rmi + 1];
    if (value !== 'local') return { error: '--rmi only takes local here: images of other projects may share tags' };
  }
  if (args[0] === 'down' && sub !== 'clean' && !yes && dropsVolumes(args)) {
    return { error: 'down with --volumes deletes this stack\'s data; add --yes-this-stack, or use clean' };
  }
  return { args };
}
