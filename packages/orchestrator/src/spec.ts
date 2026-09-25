import { MAX_STOP_TIMEOUT_SEC, SERVER_ID_PATTERN, SPEC_ENV_DENIED, SPEC_ENV_KEY, type PortMapping, type RuntimeFamily, type ServerSpec, type ServerSpecEnv, type StopRequest } from '@gsp/shared';
import { AGENT_PORT, imageName } from './derive';
import { badRequest, refused } from './errors';
import { FIRST_UNPRIVILEGED_PORT, formatRanges, inRanges, type Policy } from './policy';

// Strict schemas for what the panel may send (NFR-02): every key is known,
// every value checked; anything that asks for more than the allowlist gives
// is `refused`, anything malformed is a `bad-request`.

const SPEC_KEYS: ReadonlySet<string> = new Set(['id', 'runtime', 'variant', 'env', 'ports', 'memoryMb', 'cpus']);
const PORT_KEYS: ReadonlySet<string> = new Set(['container', 'host', 'proto']);
const RUNTIMES: readonly RuntimeFamily[] = ['steam', 'java', 'native'];
/** Keys the spec sets besides `GAME_*` / `GSP_*`. */
const FIXED_ENV: ReadonlySet<string> = new Set(['AGENT_TOKEN', 'GAME_ADAPTER', 'GAME_FLAVOUR', 'TZ']);
const DENIED_ENV: ReadonlySet<string> = new Set(SPEC_ENV_DENIED);

export const MIN_MEM_MB = 128;
export const MAX_PORTS = 16;
export const MAX_ENV_KEYS = 64;
export const MAX_ENV_VALUE = 4096;
const MIN_CPUS = 0.01;
const MAX_CPUS = 1024;

const AGENT_TOKEN = /^[\x21-\x7e]{32,256}$/;
const ADAPTER = /^[a-z][a-z0-9-]{0,39}$/;
const FLAVOUR = /^[a-z0-9][a-z0-9._-]{0,39}$/;
const TZ = /^[A-Za-z0-9_+-]{1,32}(\/[A-Za-z0-9_+-]{1,32}){0,2}$/;
const VARIANT = /^[a-z0-9][a-z0-9.-]{0,31}$/;
const LINE_BREAK_OR_NUL = /[\0\r\n]/;

function isObject(x: unknown): x is Record<string, unknown> {
  return typeof x === 'object' && x !== null && !Array.isArray(x);
}

/** A caller's key as it may appear in a `field` or message: printable and short, or `?`. */
const shown = (k: string) => (/^[\x21-\x7e]{1,64}$/.test(k) ? k : '?');

const isPort = (x: unknown): x is number => typeof x === 'number' && Number.isInteger(x) && x >= 1 && x <= 65535;

function parseEnv(x: unknown): ServerSpecEnv {
  if (!isObject(x)) throw badRequest('env must be an object', 'env');
  const keys = Object.keys(x);
  if (keys.length > MAX_ENV_KEYS) throw refused('env', `env may have at most ${MAX_ENV_KEYS} keys`);
  const out: Record<string, string> = {};
  for (const key of keys) {
    const field = `env.${shown(key)}`;
    if (!FIXED_ENV.has(key) && !SPEC_ENV_KEY.test(key)) throw refused(field, `${field} can't be set: only AGENT_TOKEN, GAME_ADAPTER, GAME_FLAVOUR, TZ, GAME_* and GSP_* can`);
    if (DENIED_ENV.has(key)) throw refused(field, `${field} belongs to the image and can't be set`);
    const value = x[key];
    if (typeof value !== 'string') throw badRequest(`${field} must be a string`, field);
    if (value.length > MAX_ENV_VALUE) throw refused(field, `${field} is longer than ${MAX_ENV_VALUE} characters`);
    if (LINE_BREAK_OR_NUL.test(value)) throw refused(field, `${field} must not contain NUL or line breaks`);
    out[key] = value;
  }
  const check = (key: string, re: RegExp, what: string, required: boolean) => {
    const v = out[key];
    if (v === undefined) {
      if (required) throw badRequest(`env.${key} is required`, `env.${key}`);
      return;
    }
    if (!re.test(v)) throw badRequest(`env.${key} ${what}`, `env.${key}`);
  };
  check('AGENT_TOKEN', AGENT_TOKEN, 'must be 32-256 printable characters without spaces', true);
  check('GAME_ADAPTER', ADAPTER, 'must be an adapter id (a-z first, then a-z, 0-9 and -)', true);
  check('GAME_FLAVOUR', FLAVOUR, 'must be a flavour id', false);
  check('TZ', TZ, 'must be a tz database name such as Europe/Madrid', true);
  return out as unknown as ServerSpecEnv;
}

function parsePorts(x: unknown, policy: Policy): PortMapping[] {
  if (!Array.isArray(x)) throw badRequest('ports must be an array', 'ports');
  if (x.length > MAX_PORTS) throw refused('ports', `at most ${MAX_PORTS} ports`);
  const hosts = new Set<string>();
  const containers = new Set<string>();
  return x.map((p: unknown, i): PortMapping => {
    const f = `ports[${i}]`;
    if (!isObject(p)) throw badRequest(`${f} must be an object`, f);
    for (const k of Object.keys(p)) if (!PORT_KEYS.has(k)) throw refused(`${f}.${shown(k)}`, `${f}.${shown(k)} is not part of a port mapping (container, host, proto)`);
    const { container, host, proto } = p;
    if (proto !== 'tcp' && proto !== 'udp') throw badRequest(`${f}.proto must be tcp or udp`, `${f}.proto`);
    if (!isPort(container)) throw badRequest(`${f}.container must be a port number`, `${f}.container`);
    if (!isPort(host)) throw badRequest(`${f}.host must be a port number`, `${f}.host`);
    if (container === AGENT_PORT && proto === 'tcp') throw refused(`${f}.container`, `the agent's port ${AGENT_PORT}/tcp is never published`);
    if (host < FIRST_UNPRIVILEGED_PORT) throw refused(`${f}.host`, `host port ${host} is below ${FIRST_UNPRIVILEGED_PORT}`);
    if (!inRanges(host, policy.hostPorts)) throw refused(`${f}.host`, `host port ${host} is outside the ports servers may use here (${formatRanges(policy.hostPorts)})`);
    const hk = `${host}/${proto}`;
    const ck = `${container}/${proto}`;
    if (hosts.has(hk)) throw badRequest(`${f}.host: ${hk} is listed twice`, `${f}.host`);
    if (containers.has(ck)) throw badRequest(`${f}.container: ${ck} is listed twice`, `${f}.container`);
    hosts.add(hk);
    containers.add(ck);
    return { container, host, proto };
  });
}

/**
 * `PUT /v1/servers/:id`: the spec, checked against the contract and this
 * host's policy. Throws `refused` or `bad-request` naming the field. Port
 * clashes with other containers and the host's CPU count are checked by the
 * backend, which can see them.
 */
export function parseSpec(body: unknown, pathId: string, policy: Policy): ServerSpec {
  if (!isObject(body)) throw badRequest('The spec must be a JSON object');
  for (const k of Object.keys(body)) {
    if (!SPEC_KEYS.has(k)) throw refused(shown(k), `"${shown(k)}" is not part of a server spec: the orchestrator derives everything else itself`);
  }
  const { id, runtime, variant, env, ports, memoryMb, cpus } = body;
  if (typeof id !== 'string' || !SERVER_ID_PATTERN.test(id)) throw badRequest('id must be 2-24 characters: a-z first, then a-z, 0-9 and -', 'id');
  if (id !== pathId) throw badRequest('id must equal the id in the path', 'id');
  if (typeof runtime !== 'string' || !(RUNTIMES as readonly string[]).includes(runtime)) throw refused('runtime', 'runtime must be steam, java or native');
  if (variant !== undefined && (typeof variant !== 'string' || !VARIANT.test(variant))) throw badRequest('variant must be a short lowercase name', 'variant');
  imageName(runtime as RuntimeFamily, variant, policy.allowFake);
  const specEnv = parseEnv(env);
  const specPorts = parsePorts(ports, policy);
  if (typeof memoryMb !== 'number' || !Number.isInteger(memoryMb) || memoryMb < MIN_MEM_MB) throw badRequest(`memoryMb must be a whole number of MiB, at least ${MIN_MEM_MB}`, 'memoryMb');
  if (memoryMb > policy.maxMemMb) throw refused('memoryMb', `memoryMb is above this host's limit of ${policy.maxMemMb} MiB per server`);
  if (cpus !== undefined && (typeof cpus !== 'number' || !Number.isFinite(cpus) || cpus < MIN_CPUS || cpus > MAX_CPUS)) throw badRequest(`cpus must be ${MIN_CPUS}-${MAX_CPUS} cores`, 'cpus');
  const spec: ServerSpec = { id, runtime: runtime as RuntimeFamily, env: specEnv, ports: specPorts, memoryMb };
  if (variant !== undefined) spec.variant = variant;
  if (cpus !== undefined) spec.cpus = cpus;
  return spec;
}

/** `POST …/stop` and `…/restart`. */
export function parseStop(body: unknown): StopRequest {
  if (body === undefined) return {};
  if (!isObject(body)) throw badRequest('The body must be a JSON object');
  for (const k of Object.keys(body)) if (k !== 'timeoutSec') throw badRequest(`"${shown(k)}" is not part of a stop request`, shown(k));
  const t = body.timeoutSec;
  if (t === undefined) return {};
  if (typeof t !== 'number' || !Number.isInteger(t) || t < 0 || t > MAX_STOP_TIMEOUT_SEC) throw badRequest(`timeoutSec must be a whole number of seconds, 0-${MAX_STOP_TIMEOUT_SEC}`, 'timeoutSec');
  return { timeoutSec: t };
}

/** `POST …/start` takes no options: nothing, or `{}`. */
export function parseEmpty(body: unknown): void {
  if (body === undefined) return;
  if (!isObject(body) || Object.keys(body).length > 0) throw badRequest('This request takes no body (or {})');
}
