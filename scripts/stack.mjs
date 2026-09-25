#!/usr/bin/env node
// The only way to run Docker Compose from a development worktree. Several
// worktrees and a live stack can share this machine; this refuses anything
// that could touch a stack other than this worktree's own.
//
//   node scripts/stack.mjs config               render the project (read-only)
//   node scripts/stack.mjs up -d --build        any Compose command…
//   node scripts/stack.mjs logs -f panel
//   node scripts/stack.mjs build steam steam-fake   the game servers' runtime images (build-only services)
//   node scripts/stack.mjs down                 stop and remove containers (the game servers' too)
//   node scripts/stack.mjs clean                down --volumes --rmi local, this project only
//   node scripts/stack.mjs --stack-env FILE …   use FILE instead of .env (tests, dry runs)
//
// It runs `docker compose -p <COMPOSE_PROJECT_NAME> --env-file .env -f compose.yaml <args>`
// only when .env (see scripts/worktree-env.mjs) has COMPOSE_PROJECT_NAME=gsp-s<slot>
// that isn't listed in <git common dir>/info/protected-projects, PANEL_TLS=internal,
// an empty COMPOSE_PROFILES and PUBLISH_ADDR=127.0.0.1; every published port is on
// 127.0.0.1 inside the slot's block; the orchestrator has no network and lets game
// servers publish only on 127.0.0.1 inside the slot's game ports; and no running
// container of another project publishes one of those ports. `down -v` needs
// --yes-this-stack. Never prune.
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkEnv, checkOrchestrator, checkPublished, dropsVolumes, parseDockerPs, parseEnvFile, parseNameList, planCompose, portConflicts, publishedPorts, serverCleanup, serverLabel, slotOf } from './lib/stack-guard.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));

function refuse(/** @type {string[]} */ reasons) {
  console.error('stack.mjs: refusing to run Docker Compose:');
  for (const r of reasons) console.error(`  - ${r}`);
  process.exit(1);
}

let argv = process.argv.slice(2);
let envFile = path.join(root, '.env');
if (argv[0] === '--stack-env') {
  if (!argv[1]) refuse(['--stack-env needs a file']);
  envFile = path.resolve(argv[1] ?? '');
  argv = argv.slice(2);
}
if (!existsSync(envFile)) refuse([`${envFile} does not exist; run node scripts/worktree-env.mjs --slot N first`]);
const env = parseEnvFile(readFileSync(envFile, 'utf8'));

const common = execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd: root, encoding: 'utf8' }).trim();
const protectedFile = path.join(common, 'info', 'protected-projects');
const protectedProjects = existsSync(protectedFile) ? parseNameList(readFileSync(protectedFile, 'utf8')) : [];

const envReasons = checkEnv(env, protectedProjects);
if (envReasons.length) refuse(envReasons);
const project = env.COMPOSE_PROJECT_NAME ?? '';

const plan = planCompose(argv);
if ('error' in plan) refuse([plan.error]);

// The env file must win over the caller's shell: drop every key it sets and
// every COMPOSE_* variable from the inherited environment.
/** @type {NodeJS.ProcessEnv} */
const childEnv = {};
for (const [k, v] of Object.entries(process.env)) {
  if (k in env || /^COMPOSE_/i.test(k)) continue;
  childEnv[k] = v;
}
const base = ['compose', '-p', project, '--env-file', envFile, '-f', path.join(root, 'compose.yaml')];
const docker = (/** @type {string[]} */ args) => {
  const r = spawnSync('docker', args, { cwd: root, env: childEnv, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (r.error || r.status !== 0) refuse([`docker ${args.slice(0, 2).join(' ')} … failed: ${(r.error?.message ?? r.stderr ?? '').trim().split('\n')[0]}`]);
  return r.stdout;
};

// What this project would publish, rendered read-only.
const rendered = JSON.parse(docker([...base, 'config', '--format', 'json']));
const slot = /** @type {number} */ (slotOf(project));
const ours = publishedPorts(rendered);
// The orchestrator's game servers publish too, outside Compose: their range and address are checked here.
const portReasons = [...checkPublished(ours, slot), ...checkOrchestrator(rendered, slot)];
if (portReasons.length) refuse(portReasons);
if (rendered.name !== project) refuse([`the rendered project is ${rendered.name}, expected ${project}`]);

// Who already publishes those ports.
const running = parseDockerPs(docker(['ps', '--format', '{{.Label "com.docker.compose.project"}}\t{{.Ports}}']));
const clashes = portConflicts(ours, running, project);
if (clashes.length) refuse(clashes);

const r = spawnSync('docker', [...base, ...plan.args], { cwd: root, env: childEnv, stdio: 'inherit' });

// Compose doesn't know the game servers the orchestrator created for this
// stack (label gsp.stack=<project>): down removes their containers and
// networks as well, and clean (or down -v) their volumes.
if (r.status === 0 && plan.args[0] === 'down') {
  const list = (/** @type {string[]} */ args) => docker([...args, '--filter', serverLabel(project)]).split(/\s+/).filter(Boolean);
  const found = { containers: list(['ps', '-aq']), networks: list(['network', 'ls', '-q']), volumes: list(['volume', 'ls', '-q']) };
  for (const cmd of serverCleanup(project, found, dropsVolumes(plan.args))) {
    console.log(`stack.mjs: docker ${cmd.filter((a) => /^[a-z]+$/.test(a)).join(' ')} (${project}'s game servers)`);
    docker(cmd);
  }
}
process.exit(r.status ?? 1);
