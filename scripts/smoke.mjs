#!/usr/bin/env node
// The smoke test of a running stack (M7: "create, start, back up, restore"
// on Linux and Windows; SRV-01, SRV-03, SRV-04, BAK-01, BAK-03, HST-05,
// HST-09). As the owner, through the panel's HTTPS API (the one the web
// uses, AST-01), it creates a small server, starts it and waits until it
// runs, backs it up, stops it, restores the backup, starts it again and
// checks it runs, then deletes it with its backups and the game install it
// made, so nothing is left behind. It prints a short report.
//
//   node scripts/smoke.mjs                       the stack of this checkout's .env
//   node scripts/smoke.mjs --env ~/gsp/.env      another stack's .env
//   node scripts/smoke.mjs --url https://localhost:8443
//   node scripts/smoke.mjs --help                every option
//
// Exit status: 0 when every step passed, 1 when one failed (what it made is
// still deleted), 2 on bad arguments.
//
// Signing in: on a fresh stack it signs in with PANEL_OWNER_USERNAME and
// PANEL_OWNER_PASSWORD from the .env, then sets a new random password and
// enrols 2FA through the API, as the web asks the owner to on a first
// sign-in. That password, the 2FA secret and the session are kept in
// .tmp/smoke-owner.json (by panel address; readable by its owner only) and
// reused by later runs. It never prints them. A stack whose owner enrolled
// 2FA somewhere else can't be signed in to by this script.
//
// The game: vanilla Terraria with a small world by default (a 58 MB
// download, running in seconds). Any game whose server starts without an
// agreement to accept works the same with --adapter, --flavour and
// --launch; this script never accepts a game's EULA (D6). On a development
// slot whose .env says SERVER_IMAGE_VARIANT=fake, the panel runs the fake
// game instead, and the same steps run against it.
import { createHmac, randomBytes } from 'node:crypto';
import dns from 'node:dns';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import https from 'node:https';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));

export const USAGE = `usage: node scripts/smoke.mjs [options]
  --env FILE        the stack's .env (default: this checkout's .env)
  --url URL         the panel's address (default: https://<PANEL_HOST>:<PANEL_PORT> from the .env)
  --adapter ID      the game (default: terraria)
  --flavour NAME    its flavour (default: vanilla for terraria; "" for none)
  --launch JSON     its launch settings (default for terraria: a small world, 1 GiB)
  --id ID           the server's id (default: smoke-<random>)
  --timeout MIN     the longest each step may take, minutes (default: 20)
  --state FILE      where the owner's sign-in is kept (default: .tmp/smoke-owner.json)
  --ca FILE         the certificate authority to check the panel's certificate with (PEM)
  --insecure        don't check the certificate of a panel that isn't on this computer
  --keep            don't delete the server at the end
  --json            the report as JSON
  -h, --help        this text`;

/** Server ids the panel takes (SERVER_ID_PATTERN in @gsp/shared). */
const SERVER_ID = /^[a-z][a-z0-9-]{1,23}$/;

/** Launch settings for a quick run, by adapter (anything else: the adapter's defaults). */
const QUICK_LAUNCH = { terraria: { worldSize: 1, memoryMb: 1024 } };

/**
 * The options, or an Error whose message says what is wrong.
 * @param {string[]} argv
 */
export function parseArgs(argv) {
  /** @type {{ envFile: string; url: string | null; adapter: string; flavour: string | null; launch: Record<string, unknown> | null; id: string; timeoutMin: number; stateFile: string; ca: string | null; insecure: boolean; keep: boolean; json: boolean; help: boolean }} */
  const o = {
    envFile: path.join(root, '.env'),
    url: null,
    adapter: 'terraria',
    flavour: null,
    launch: null,
    id: `smoke-${randomBytes(3).toString('hex')}`,
    timeoutMin: 20,
    stateFile: path.join(root, '.tmp', 'smoke-owner.json'),
    ca: null,
    insecure: false,
    keep: false,
    json: false,
    help: false,
  };
  let flavourGiven = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const value = () => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`${a} needs a value`);
      return v;
    };
    switch (a) {
      case '--env':
        o.envFile = path.resolve(value());
        break;
      case '--url': {
        const v = value();
        let u;
        try {
          u = new URL(v);
        } catch {
          throw new Error(`--url: not an address: ${v}`);
        }
        if (u.protocol !== 'https:') throw new Error('--url: the panel answers on https:// only');
        o.url = u.origin;
        break;
      }
      case '--adapter':
        o.adapter = value();
        if (!/^[a-z][a-z0-9-]{0,63}$/.test(o.adapter)) throw new Error(`--adapter: not an adapter id: ${o.adapter}`);
        break;
      case '--flavour':
        o.flavour = value() || null;
        flavourGiven = true;
        break;
      case '--launch': {
        const v = value();
        let parsed;
        try {
          parsed = JSON.parse(v);
        } catch {
          throw new Error('--launch: not JSON');
        }
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('--launch: must be a JSON object');
        o.launch = parsed;
        break;
      }
      case '--id':
        o.id = value();
        if (!SERVER_ID.test(o.id)) throw new Error(`--id: a server id is 2 to 24 lowercase letters, digits and dashes, starting with a letter: ${o.id}`);
        break;
      case '--timeout': {
        const v = value();
        const n = Number(v);
        if (!Number.isFinite(n) || n <= 0 || n > 240) throw new Error(`--timeout: minutes, more than 0 and at most 240: ${v}`);
        o.timeoutMin = n;
        break;
      }
      case '--state':
        o.stateFile = path.resolve(value());
        break;
      case '--ca':
        o.ca = path.resolve(value());
        break;
      case '--insecure':
        o.insecure = true;
        break;
      case '--keep':
        o.keep = true;
        break;
      case '--json':
        o.json = true;
        break;
      case '-h':
      case '--help':
        o.help = true;
        break;
      default:
        throw new Error(`unknown option ${a}`);
    }
  }
  if (!flavourGiven) o.flavour = o.adapter === 'terraria' ? 'vanilla' : null;
  if (o.launch === null) o.launch = (o.adapter === 'terraria' && o.flavour === 'vanilla' ? QUICK_LAUNCH.terraria : null) ?? {};
  return o;
}

/**
 * KEY=value lines of a .env file (comments and blank lines skipped; values unquoted).
 * @param {string} text
 * @returns {Record<string, string>}
 */
export function parseEnv(text) {
  /** @type {Record<string, string>} */
  const out = {};
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
    if (!m || line.trimStart().startsWith('#')) continue;
    let v = m[2] ?? '';
    if (/^(["']).*\1$/.test(v)) v = v.slice(1, -1);
    out[m[1]] = v;
  }
  return out;
}

/**
 * The panel's address: --url, else https://<PANEL_HOST>:<PANEL_PORT> from the .env.
 * @param {Record<string, string>} env
 * @param {string | null} url
 */
export function panelUrl(env, url) {
  if (url) return url;
  const host = env.PANEL_HOST || 'localhost';
  const port = env.PANEL_PORT || '8443';
  return new URL(`https://${host}:${port}`).origin;
}

/**
 * Whether a host name is this computer: localhost and its subdomains
 * (RFC 6761, which browsers resolve themselves and Windows doesn't), and
 * loopback addresses.
 * @param {string} hostname
 */
export function isLoopback(hostname) {
  const h = hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (h === 'localhost' || h.endsWith('.localhost')) return true;
  if (net.isIPv4(h)) return h.startsWith('127.');
  return h === '::1';
}

/**
 * RFC 6238 code (SHA-1, 30 s steps, 6 digits) for a base32 secret, at a step.
 * @param {string} secret
 * @param {number} step
 */
export function totp(secret, step) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = 0;
  let value = 0;
  /** @type {number[]} */
  const bytes = [];
  for (const ch of secret.toUpperCase().replace(/[\s=-]/g, '')) {
    const idx = alphabet.indexOf(ch);
    if (idx < 0) throw new Error('2FA secret: not base32');
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(step));
  const h = createHmac('sha1', Buffer.from(bytes)).update(msg).digest();
  const off = h[h.length - 1] & 0xf;
  const code = ((h[off] & 0x7f) << 24) | (h[off + 1] << 16) | (h[off + 2] << 8) | h[off + 3];
  return String(code % 1_000_000).padStart(6, '0');
}

/**
 * The step a code is made for: the current one, unless that was used last
 * (the panel refuses a code twice), then the next one, which it accepts too.
 * @param {number} nowMs
 * @param {number | null} lastUsed
 */
export function totpStep(nowMs, lastUsed) {
  const now = Math.floor(nowMs / 30_000);
  return lastUsed !== null && lastUsed >= now ? lastUsed + 1 : now;
}

/** "1 min 5 s", "3.2 s". @param {number} ms */
export function duration(ms) {
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} s`;
  const s = Math.round(ms / 1000);
  return `${Math.floor(s / 60)} min ${s % 60} s`;
}

/**
 * @typedef {{ name: string; ok: boolean; ms: number; detail: string }} Step
 * @typedef {{ url: string; adapter: string; flavour: string | null; serverId: string; steps: Step[]; ok: boolean; ms: number }} Report
 */

/**
 * The report as text: one line per step, then the verdict.
 * @param {Report} r
 */
export function formatReport(r) {
  const game = r.flavour ? `${r.adapter} ${r.flavour}` : r.adapter;
  const lines = [`Smoke test of ${r.url}: ${game}, server ${r.serverId}`];
  const width = Math.max(...r.steps.map((s) => s.name.length), 4);
  for (const s of r.steps) lines.push(`  ${s.ok ? 'ok  ' : 'FAIL'}  ${s.name.padEnd(width)}  ${duration(s.ms).padStart(10)}  ${s.detail}`.trimEnd());
  const passed = r.steps.filter((s) => s.ok).length;
  lines.push(`${r.ok ? 'PASS' : 'FAIL'}: ${passed} of ${r.steps.length} steps passed in ${duration(r.ms)}`);
  return lines.join('\n');
}

// ------------------------------------------------------------------- HTTP

class ApiError extends Error {
  /** @param {string} what @param {number} status @param {unknown} body */
  constructor(what, status, body) {
    const code = body && typeof body === 'object' && 'error' in body ? /** @type {{ error: unknown }} */ (body).error : null;
    super(`${what}: HTTP ${status}${code ? ` ${code}` : ''}`);
    this.status = status;
    this.code = typeof code === 'string' ? code : null;
    this.body = body;
  }
}

/**
 * A client of the panel's API as the web is one: the session cookie, the
 * panel's own Origin on every change, and the session's CSRF header.
 */
export class Panel {
  /** @param {string} url @param {{ ca: string | null; insecure: boolean }} tls */
  constructor(url, tls) {
    this.url = url;
    const local = isLoopback(new URL(url).hostname);
    // A panel on this computer shows Caddy's own certificate, which nothing trusts; the connection never leaves the computer.
    this.tlsChecked = Boolean(tls.ca) || (!local && !tls.insecure);
    this.agent = new https.Agent({
      keepAlive: true,
      rejectUnauthorized: this.tlsChecked,
      ca: tls.ca ? readFileSync(tls.ca) : undefined,
      // *.localhost is this computer (RFC 6761); Windows doesn't resolve it.
      lookup: (hostname, options, cb) => {
        if (!hostname.toLowerCase().endsWith('.localhost')) return dns.lookup(hostname, options, cb);
        if (options.all) return cb(null, [{ address: '127.0.0.1', family: 4 }]);
        return cb(null, '127.0.0.1', 4);
      },
    });
    /** @type {string | null} */
    this.cookie = null;
    /** @type {string | null} */
    this.csrf = null;
  }

  /**
   * @param {'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'} method
   * @param {string} p
   * @param {unknown} [body]
   * @returns {Promise<{ status: number; body: any }>}
   */
  raw(method, p, body) {
    const u = new URL(p, this.url);
    /** @type {Record<string, string>} */
    const headers = { accept: 'application/json' };
    if (this.cookie) headers.cookie = this.cookie;
    if (method !== 'GET') {
      headers.origin = this.url;
      if (this.csrf) headers['x-gsp-csrf'] = this.csrf;
    }
    const payload = method === 'GET' ? null : JSON.stringify(body ?? {});
    if (payload !== null) {
      headers['content-type'] = 'application/json';
      // Node sends a DELETE's body only with its length given.
      headers['content-length'] = String(Buffer.byteLength(payload));
    }
    return new Promise((resolve, reject) => {
      const req = https.request(u, { method, headers, agent: this.agent, timeout: 120_000 }, (res) => {
        const chunks = /** @type {Buffer[]} */ ([]);
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          for (const c of res.headers['set-cookie'] ?? []) {
            const m = /^(__Host-[^=]+)=([^;]*)/.exec(c);
            if (m) this.cookie = m[2] ? `${m[1]}=${m[2]}` : null;
          }
          const text = Buffer.concat(chunks).toString('utf8');
          let parsed;
          try {
            parsed = text ? JSON.parse(text) : null;
          } catch {
            parsed = text;
          }
          if (parsed && typeof parsed === 'object' && typeof parsed.csrf === 'string' && (res.statusCode ?? 0) < 300) this.csrf = parsed.csrf;
          resolve({ status: res.statusCode ?? 0, body: parsed });
        });
      });
      req.on('timeout', () => req.destroy(new Error(`${method} ${u.pathname}: no answer in 2 minutes`)));
      req.on('error', reject);
      if (payload !== null) req.write(payload);
      req.end();
    });
  }

  /** The answer of a call that must succeed. @param {'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'} method @param {string} p @param {unknown} [body] */
  async call(method, p, body) {
    const r = await this.raw(method, p, body);
    if (r.status >= 300) throw new ApiError(`${method} ${p}`, r.status, r.body);
    return r.body;
  }
}

// ------------------------------------------------------------- sign-in

/**
 * Waits until the panel answers through its front door; returns how long that
 * took. Right after `stack.mjs up -d` Caddy may still be making its
 * certificate (a TLS alert) or the panel still starting (connection refused,
 * a 502 from Caddy); those are retried every second. Any other answer, or the
 * same failure after `timeoutMs`, ends the wait: the caller then sees it.
 * @param {{ raw(method: 'GET', p: string): Promise<{ status: number }> }} panel
 * @param {number} [timeoutMs]
 * @param {(ms: number) => Promise<void>} [wait]
 */
export async function reachable(panel, timeoutMs = 60_000, wait = (ms) => new Promise((r) => setTimeout(r, ms))) {
  const t0 = Date.now();
  for (;;) {
    let notYet;
    try {
      const r = await panel.raw('GET', '/api/session');
      if (![502, 503, 504].includes(r.status)) return Date.now() - t0;
      notYet = new Error(`the panel answered ${r.status}`);
    } catch (e) {
      notYet = /** @type {Error & { code?: string }} */ (e);
      if (!/^(ECONNREFUSED|ECONNRESET|EPROTO|EPIPE|ERR_SSL_)/.test(notYet.code ?? '')) throw notYet;
    }
    if (Date.now() - t0 >= timeoutMs) throw new Error(`the panel didn't answer within ${duration(timeoutMs)}: ${notYet.message}`);
    await wait(1000);
  }
}

/**
 * @typedef {{ username?: string; password?: string; totpSecret?: string; recoveryCodes?: string[]; lastStep?: number | null; cookie?: string | null }} Saved
 */

/** @param {string} file @returns {Record<string, Saved>} */
function readState(file) {
  if (!existsSync(file)) return {};
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return {};
  }
}

/** @param {string} file @param {Record<string, Saved>} all */
function writeState(file, all) {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(all, null, 2)}\n`, { mode: 0o600 });
  chmodSync(file, 0o600);
}

/**
 * Signs in as the owner (see the top of this file); returns how.
 * @param {Panel} panel
 * @param {Record<string, string>} env
 * @param {string} stateFile
 */
export async function signIn(panel, env, stateFile) {
  const all = readState(stateFile);
  const saved = (all[panel.url] ??= {});
  const save = () => writeState(stateFile, all);
  // Fails here, before the panel changes anything, when the state can't be kept: a new password
  // or 2FA secret this script sets and then can't save would lock the owner out of the stack.
  save();
  const code = async () => {
    if (!saved.totpSecret) throw new Error('the owner has 2FA from an authenticator this script does not have; run it against a fresh stack, or keep the state file of the run that set the owner up');
    let step = totpStep(Date.now(), saved.lastStep ?? null);
    // The next step is accepted early; one further, wait for it.
    while (step > Math.floor(Date.now() / 30_000) + 1) await new Promise((r) => setTimeout(r, 1000));
    saved.lastStep = step;
    return totp(saved.totpSecret, step);
  };

  if (saved.cookie) {
    panel.cookie = saved.cookie;
    const r = await panel.raw('GET', '/api/session');
    if (r.status === 200 && r.body && r.body.pending === null) return 'session reused';
    panel.cookie = null;
    panel.csrf = null;
  }

  const username = saved.username ?? env.PANEL_OWNER_USERNAME ?? 'owner';
  const tries = [saved.password, env.PANEL_OWNER_PASSWORD].filter((p, i, a) => typeof p === 'string' && p !== '' && a.indexOf(p) === i);
  if (!tries.length) throw new Error('no owner password: PANEL_OWNER_PASSWORD is empty in the .env and none was saved');
  /** @type {any} */
  let session = null;
  let password = '';
  for (const p of tries) {
    const r = await panel.raw('POST', '/api/auth/login', { username, password: p });
    if (r.status === 200) {
      session = r.body;
      password = /** @type {string} */ (p);
      break;
    }
    if (r.status !== 401) throw new ApiError('sign in', r.status, r.body);
  }
  if (!session) throw new Error(`sign in: the panel refused the owner's saved and .env passwords for "${username}"`);
  saved.username = username;
  const how = [];
  if (session.pending === 'mfa') {
    session = await panel.call('POST', '/api/auth/mfa', { code: await code() });
    how.push('2FA');
  }
  if (session.pending === 'password') {
    const next = `Smoke-${randomBytes(18).toString('base64url')}`;
    // Kept before it is set; if setting it fails, the next run tries it, is refused, and goes on to the .env's.
    saved.password = next;
    save();
    session = await panel.call('POST', '/api/auth/password', { current: password, next });
    password = next;
    how.push('new password set');
  }
  saved.password = password;
  save();
  if (session.pending === 'enrol') {
    const setup = await panel.call('POST', '/api/auth/totp/setup');
    saved.totpSecret = setup.secret;
    saved.lastStep = null;
    save();
    const enabled = await panel.call('POST', '/api/auth/totp/enable', { code: await code() });
    saved.recoveryCodes = enabled.recoveryCodes;
    session = enabled;
    how.push('2FA enrolled');
  }
  if (session.pending) throw new Error(`sign in: the panel still asks for "${session.pending}"`);
  saved.cookie = panel.cookie;
  save();
  return how.length ? `signed in (${how.join(', ')})` : 'signed in';
}

// ------------------------------------------------------------------ steps

/** @param {number} ms */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Polls until `check` returns a value (not undefined), or fails after the timeout.
 * @template T
 * @param {() => Promise<T | undefined>} check
 * @param {number} timeoutMs
 * @param {string} what
 * @returns {Promise<T>}
 */
async function until(check, timeoutMs, what) {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const v = await check();
    if (v !== undefined) return v;
    if (Date.now() > end) throw new Error(`${what}: not within ${duration(timeoutMs)}`);
    await sleep(2000);
  }
}

/**
 * Runs the steps against a signed-in panel and returns the report.
 * @param {ReturnType<typeof parseArgs>} o
 * @param {Panel} panel
 * @param {Record<string, string>} env
 */
async function smoke(o, panel, env) {
  const timeoutMs = o.timeoutMin * 60_000;
  const s = `/api/servers/${o.id}`;
  /** @type {Report} */
  const report = { url: panel.url, adapter: o.adapter, flavour: o.flavour, serverId: o.id, steps: [], ok: true, ms: 0 };
  const t0 = Date.now();
  /** @param {string} name @param {() => Promise<string>} fn */
  const step = async (name, fn) => {
    const start = Date.now();
    try {
      const detail = await fn();
      report.steps.push({ name, ok: true, ms: Date.now() - start, detail });
      return true;
    } catch (e) {
      report.steps.push({ name, ok: false, ms: Date.now() - start, detail: /** @type {Error} */ (e).message });
      report.ok = false;
      return false;
    }
  };

  /** The server's op once it has ended (fails when it failed). @param {string} id */
  const opEnded = (id) =>
    until(
      async () => {
        const op = await panel.call('GET', `${s}/ops/current`);
        return op && op.id === id && op.done ? op : undefined;
      },
      timeoutMs,
      'the operation to end',
    ).then((op) => {
      if (!op.ok) throw new Error(`${op.kind} ${op.step}${op.error ? `: ${op.error}` : ''}`);
      return op;
    });
  /** Starts an operation; while another one runs on the server (a start waiting for its install), waits for it and asks again. @param {string} p @param {unknown} [body] */
  const startOp = async (p, body) => {
    const end = Date.now() + timeoutMs;
    for (;;) {
      const r = await panel.raw('POST', `${s}${p}`, body);
      if (r.status < 300) return opEnded(r.body.id);
      if (r.status === 409 && r.body?.error === 'busy' && Date.now() < end) {
        await opEnded(r.body.op.id).catch(() => undefined);
        continue;
      }
      throw new ApiError(`POST ${p}`, r.status, r.body);
    }
  };
  /** @param {string} want */
  const state = (want) =>
    until(
      async () => {
        const st = await panel.call('GET', `${s}/status`);
        const cur = st?.agent?.state;
        if (cur === want) return st;
        if (want === 'running' && (cur === 'crashed' || cur === 'failed')) throw new Error(`the game ${cur}${st.agent.failure ? `: ${st.agent.failure}` : ''}`);
        return undefined;
      },
      timeoutMs,
      `the server to be ${want}`,
    );
  const running = async () => {
    const st = await state('running');
    const v = st.agent?.installedInfo?.version;
    return `running${v ? `, version ${v}` : ''}`;
  };

  const installsBefore = new Set();
  let created = false;
  /** @type {any} */
  let backup = null;

  /** @type {[string, () => Promise<string>][]} */
  const steps = [
    [
      'create',
      async () => {
        const host = await panel.raw('GET', '/api/host/installs');
        if (host.status === 200) for (const i of host.body.installs ?? []) installsBefore.add(i.id);
        const body = { id: o.id, name: `Smoke ${o.id}`, adapter: o.adapter, ...(o.flavour ? { flavour: o.flavour } : {}), launch: o.launch };
        const r = await panel.call('POST', '/api/servers', body);
        created = true;
        const ports = (r.ports ?? []).map((/** @type {{ port: number; proto: string }} */ p) => `${p.proto.toUpperCase()} ${p.port}`).join(', ');
        return `ports ${ports || 'none'}${env.SERVER_IMAGE_VARIANT ? `, the ${env.SERVER_IMAGE_VARIANT} game` : ''}`;
      },
    ],
    [
      // The game's files (HST-09): downloaded once per version by an install job, then the server's container is
      // made; its Start is pressed once that container's agent answers, as a person would after the progress bar.
      'game files',
      async () => {
        const inst = await until(
          async () => {
            const v = await panel.call('GET', `${s}/install`);
            if (v.state === 'failed' || v.error) throw new Error(`the install failed: ${v.error ?? 'no reason given'}`);
            return v.waiting || (v.mode === 'shared' && v.state !== 'ready') ? undefined : v;
          },
          timeoutMs,
          'the game files',
        );
        await until(async () => ((await panel.call('GET', `${s}/status`)).agent ? true : undefined), timeoutMs, "the server's agent to answer");
        const size = inst.bytes ? `, ${(inst.bytes / 1024 / 1024).toFixed(0)} MB` : '';
        return inst.mode === 'shared' ? `version ${inst.key?.version ?? '?'}${size}, shared install${inst.sharedWith ? ` with ${inst.sharedWith} other server(s)` : ''}` : 'its own install';
      },
    ],
    ['start', async () => (await startOp('/server/start'), running())],
    [
      'back up',
      async () => {
        await startOp('/backups');
        const list = await panel.call('GET', `${s}/backups`);
        backup = (list.backups ?? []).find((/** @type {{ manifest: { trigger: string } }} */ b) => b.manifest.trigger === 'manual') ?? null;
        if (!backup) throw new Error('no manual backup listed after the backup');
        return `${backup.name}, ${(backup.size / 1024 / 1024).toFixed(1)} MB, parts ${backup.manifest.parts.join(', ')}`;
      },
    ],
    ['stop', async () => (await startOp('/server/stop', { countdownSec: 0 }), await state('stopped'), 'stopped')],
    [
      'restore',
      async () => {
        await startOp(`/backups/${encodeURIComponent(backup.name)}/restore`, { parts: backup.manifest.parts, countdownSec: 0 });
        return `${backup.name}, every part`;
      },
    ],
    ['start again', async () => (await startOp('/server/start'), running())],
  ];
  for (const [name, fn] of steps) if (!(await step(name, fn))) break;

  if (created && !o.keep) {
    await step('delete', async () => {
      const notes = [];
      // The panel removes a stopped server; one that won't stop (or can't be reached) only by force, the owner's choice.
      const st = await panel.raw('GET', `${s}/status`);
      if (st.status === 200 && st.body?.agent && st.body.agent.state !== 'stopped') {
        await startOp('/server/stop', { countdownSec: 0 })
          .then(() => state('stopped'))
          .then(
            () => notes.push('stopped'),
            (e) => notes.push(`stop failed (${e.message})`),
          );
      }
      const body = { confirm: `Smoke ${o.id}`, keepBackups: false, finalBackup: false };
      const r = await panel.raw('DELETE', s, body);
      if (r.status === 409) {
        await panel.call('DELETE', s, { ...body, force: true });
        notes.push(`removed by force after ${r.body?.error ?? 'a refusal'}`);
      } else if (r.status >= 300) throw new ApiError(`DELETE ${s}`, r.status, r.body);
      notes.push('removed with its backups');
      const host = await panel.raw('GET', '/api/host/installs');
      if (host.status === 200) {
        for (const i of host.body.installs ?? []) {
          if (installsBefore.has(i.id)) continue;
          if (!i.removable) {
            notes.push(`install ${i.id} left (still in use)`);
            continue;
          }
          await panel.call('DELETE', `/api/host/installs/${encodeURIComponent(i.id)}`);
          notes.push(`install ${i.id} removed`);
        }
      }
      return notes.join(', ');
    });
  }
  report.ms = Date.now() - t0;
  return report;
}

async function main() {
  let o;
  try {
    o = parseArgs(process.argv.slice(2));
  } catch (e) {
    console.error(`smoke: ${/** @type {Error} */ (e).message}\n${USAGE}`);
    process.exit(2);
  }
  if (o.help) {
    console.log(USAGE);
    return;
  }
  const env = existsSync(o.envFile) ? parseEnv(readFileSync(o.envFile, 'utf8')) : {};
  if (!existsSync(o.envFile) && !o.url) {
    console.error(`smoke: ${o.envFile} does not exist; give --env or --url`);
    process.exit(2);
  }
  const panel = new Panel(panelUrl(env, o.url), { ca: o.ca, insecure: o.insecure });
  /** @type {Report} */
  let report;
  const t0 = Date.now();
  try {
    const waited = await reachable(panel);
    const how = await signIn(panel, env, o.stateFile);
    const notes = [how, waited >= 1000 ? `the panel answered after ${duration(waited)}` : '', panel.tlsChecked ? '' : 'certificate not checked (this computer)'];
    const signedIn = { name: 'sign in', ok: true, ms: Date.now() - t0, detail: notes.filter(Boolean).join('; ') };
    report = await smoke(o, panel, env);
    report.steps.unshift(signedIn);
    report.ms += signedIn.ms;
  } catch (e) {
    report = { url: panel.url, adapter: o.adapter, flavour: o.flavour, serverId: o.id, steps: [{ name: 'sign in', ok: false, ms: Date.now() - t0, detail: /** @type {Error} */ (e).message }], ok: false, ms: Date.now() - t0 };
  }
  panel.agent.destroy();
  console.log(o.json ? JSON.stringify(report, null, 2) : formatReport(report));
  process.exit(report.ok ? 0 : 1);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) await main();
