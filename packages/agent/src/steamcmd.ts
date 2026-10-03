import { spawn } from 'node:child_process';
import { rmSync } from 'node:fs';
import path from 'node:path';
import type { JobResult, SteamCmd, VersionInfo } from '@gsp/adapter-api';
import { isRetryableSteamcmdError, parseAppInfoBranches, parseSteamcmdLine, stripAnsi } from '@gsp/formats';
import { lineSplitter } from './process';

export interface SteamcmdRunResult {
  ok: boolean;
  output: string;
  error?: string;
  retryable: boolean;
}

export interface SteamcmdOptions {
  steamcmd: string[];
  home: string;
  onLine?: (line: string) => void;
  onProgress?: (percent: number, state: string) => void;
  signal?: AbortSignal;
}

const BRANCH = /^[A-Za-z0-9._-]{1,64}$/;
const APP_ID = /^\d{1,10}$/;
const WORKSHOP_ID = /^\d{5,20}$/;

/** steamcmd's environment: ours minus the agent's token, with its own HOME. */
function steamcmdEnv(home: string): NodeJS.ProcessEnv {
  const { AGENT_TOKEN: _token, ...env } = process.env;
  return { ...env, HOME: home };
}

/** Run steamcmd once with the given `+command` args. Exit codes are unreliable; success is read from the output. */
export function runSteamcmd(args: string[], opts: SteamcmdOptions, successTest: (output: string) => boolean): Promise<SteamcmdRunResult> {
  return new Promise((resolve) => {
    const [file, ...pre] = opts.steamcmd;
    const child = spawn(file!, [...pre, ...args], {
      env: steamcmdEnv(opts.home),
      stdio: ['ignore', 'pipe', 'pipe'],
      signal: opts.signal,
    });
    let output = '';
    let lastError: { state?: string; message: string } | undefined;
    const onLine = (raw: string) => {
      const line = stripAnsi(raw);
      output += `${line}\n`;
      if (output.length > 2_000_000) output = output.slice(-1_000_000);
      opts.onLine?.(line);
      const p = parseSteamcmdLine(line);
      if (p?.kind === 'progress' && p.percent !== undefined) opts.onProgress?.(p.percent, p.state ?? '');
      if (p?.kind === 'error') lastError = { state: p.state, message: p.message };
    };
    const out = lineSplitter(onLine);
    const err = lineSplitter(onLine);
    child.stdout.on('data', (c: Buffer) => out.push(c));
    child.stderr.on('data', (c: Buffer) => err.push(c));
    child.on('error', (e) => resolve({ ok: false, output, error: e.message, retryable: false }));
    child.on('close', () => {
      out.flush();
      err.flush();
      if (successTest(output)) resolve({ ok: true, output, retryable: false });
      else {
        const message = lastError?.message ?? 'steamcmd did not report success';
        resolve({ ok: false, output, error: message, retryable: isRetryableSteamcmdError(lastError?.state, message) || !lastError });
      }
    });
  });
}

async function withRetries(attempts: number, fn: () => Promise<SteamcmdRunResult>, onRetry?: (n: number, error: string) => void): Promise<SteamcmdRunResult> {
  let last: SteamcmdRunResult | undefined;
  for (let i = 1; i <= attempts; i++) {
    last = await fn();
    if (last.ok || !last.retryable || i === attempts) return last;
    onRetry?.(i, last.error ?? 'failed');
    await new Promise((r) => setTimeout(r, 5_000 * i));
  }
  return last!;
}

/**
 * `+app_update` arguments; a null branch is Steam's default (`public`) one.
 * The branch is always named, `public` too: without `-beta`, steamcmd keeps
 * an install on the beta branch it was installed from and says it is up to
 * date (measured: docs/verification/shared-installs.md, "Branch switches").
 */
export function installArgs(installDir: string, appId: string, branch: string | null, validate: boolean): string[] {
  if (!APP_ID.test(appId)) throw new Error('Invalid app id');
  if (branch !== null && !BRANCH.test(branch)) throw new Error('Invalid branch name');
  const update = ['+app_update', appId, '-beta', branch ?? 'public'];
  if (validate) update.push('validate');
  // force_install_dir must come before login.
  return ['+force_install_dir', installDir, '+login', 'anonymous', ...update, '+quit'];
}

export function workshopArgs(cacheDir: string, workshopAppId: string, ids: string[]): string[] {
  if (!APP_ID.test(workshopAppId)) throw new Error('Invalid workshop app id');
  for (const id of ids) if (!WORKSHOP_ID.test(id)) throw new Error(`Invalid workshop id ${id}`);
  return ['+force_install_dir', cacheDir, '+login', 'anonymous', ...ids.flatMap((id) => ['+workshop_download_item', workshopAppId, id]), '+quit'];
}

export interface SteamcmdDriverOptions extends SteamcmdOptions {
  /** `app_update` target: the server's install root. */
  installDir: string;
  /** Workshop cache (`force_install_dir` of downloads), inside the data root. */
  workshopDir: string;
  /** Agent log lines (retries). */
  log?: (line: string) => void;
}

/**
 * The agent's steamcmd driver (`InstallCtx.steam`): retries, progress and
 * output lines for the running job. Adapters pass their own app ids.
 */
export class SteamcmdDriver implements SteamCmd {
  constructor(private readonly o: SteamcmdDriverOptions) {}

  async appUpdate(req: { appId: string; branch: string | null; validate: boolean }): Promise<JobResult> {
    const args = installArgs(this.o.installDir, req.appId, req.branch, req.validate);
    const ok = (out: string) => new RegExp(`Success! App '${req.appId}' (fully installed|already up to date)`).test(out);
    const r = await withRetries(3, () => runSteamcmd(args, this.o, ok), (n, e) => this.o.log?.(`steamcmd attempt ${n} failed (${e}); retrying`));
    return r.ok ? { ok: true } : { ok: false, error: r.error };
  }

  async branches(req: { appId: string }): Promise<VersionInfo[]> {
    if (!APP_ID.test(req.appId)) throw new Error('Invalid app id');
    // steamcmd serves app_info from a local cache that can be days stale; drop it first.
    rmSync(path.join(this.o.home, 'Steam', 'appcache', 'appinfo.vdf'), { force: true });
    const args = ['+login', 'anonymous', '+app_info_update', '1', '+app_info_print', req.appId, '+quit'];
    let last: SteamcmdRunResult | undefined;
    for (let i = 0; i < 2; i++) {
      last = await runSteamcmd(args, this.o, (out) => out.includes(`"${req.appId}"`));
      if (last.ok) {
        try {
          const branches = parseAppInfoBranches(last.output, req.appId);
          return branches.map((b) => ({ id: b.name, build: b.buildId, timeUpdated: b.timeUpdated, description: b.description, passwordRequired: b.passwordRequired }));
        } catch {
          // Empty or truncated print happens; retry once.
        }
      }
    }
    throw new Error(last?.error ?? 'Could not read app info');
  }

  async workshopDownload(req: { workshopAppId: string; ids: string[] }): Promise<JobResult> {
    const args = workshopArgs(this.o.workshopDir, req.workshopAppId, req.ids);
    const ok = (out: string) => req.ids.every((id) => out.includes(`Success. Downloaded item ${id}`));
    const r = await withRetries(2, () => runSteamcmd(args, this.o, ok));
    return r.ok ? { ok: true } : { ok: false, error: r.error };
  }
}
