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
  if (args[0] === 'down' && sub !== 'clean' && !yes) {
    const dropsVolumes = args.slice(1).some((a) => a === '--volumes' || a.startsWith('--volumes=') || /^-[a-zA-Z]*v[a-zA-Z]*$/.test(a));
    if (dropsVolumes) return { error: 'down with --volumes deletes this stack\'s data; add --yes-this-stack, or use clean' };
  }
  return { args };
}
