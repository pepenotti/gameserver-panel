import { spawn } from 'node:child_process';
import { rmSync } from 'node:fs';
import path from 'node:path';
import { isRetryableSteamcmdError, parseAppInfoBranches, parseSteamcmdLine, stripAnsi, type BranchInfo } from '@pz/formats';
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

/** Run steamcmd once with the given `+command` args. Exit codes are unreliable; success is read from the output. */
export function runSteamcmd(args: string[], opts: SteamcmdOptions, successTest: (output: string) => boolean): Promise<SteamcmdRunResult> {
  return new Promise((resolve) => {
    const [file, ...pre] = opts.steamcmd;
    const child = spawn(file!, [...pre, ...args], {
      env: { ...process.env, HOME: opts.home },
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

export function installArgs(installDir: string, appId: string, branch: string, validate: boolean): string[] {
  if (!BRANCH.test(branch)) throw new Error('Invalid branch name');
  const update = ['+app_update', appId];
  if (branch !== 'public') update.push('-beta', branch);
  if (validate) update.push('validate');
  // force_install_dir must come before login.
  return ['+force_install_dir', installDir, '+login', 'anonymous', ...update, '+quit'];
}

export function installGame(opts: SteamcmdOptions & { installDir: string; appId: string; branch: string; validate: boolean; onRetry?: (n: number, e: string) => void }) {
  const args = installArgs(opts.installDir, opts.appId, opts.branch, opts.validate);
  const ok = (o: string) => new RegExp(`Success! App '${opts.appId}' (fully installed|already up to date)`).test(o);
  return withRetries(3, () => runSteamcmd(args, opts, ok), opts.onRetry);
}

export async function fetchBranches(opts: SteamcmdOptions & { appId: string }): Promise<BranchInfo[]> {
  // steamcmd serves app_info from a local cache that can be days stale; drop it first.
  rmSync(path.join(opts.home, 'Steam', 'appcache', 'appinfo.vdf'), { force: true });
  const args = ['+login', 'anonymous', '+app_info_update', '1', '+app_info_print', opts.appId, '+quit'];
  let last: SteamcmdRunResult | undefined;
  for (let i = 0; i < 2; i++) {
    last = await runSteamcmd(args, opts, (o) => o.includes(`"${opts.appId}"`));
    if (last.ok) {
      try {
        return parseAppInfoBranches(last.output, opts.appId);
      } catch {
        // Empty or truncated print happens; retry once.
      }
    }
  }
  throw new Error(last?.error ?? 'Could not read app info');
}

export function downloadWorkshopItems(opts: SteamcmdOptions & { cacheDir: string; ids: string[] }) {
  for (const id of opts.ids) if (!/^\d{5,20}$/.test(id)) throw new Error(`Invalid workshop id ${id}`);
  const args = ['+force_install_dir', opts.cacheDir, '+login', 'anonymous', ...opts.ids.flatMap((id) => ['+workshop_download_item', '108600', id]), '+quit'];
  const ok = (o: string) => opts.ids.every((id) => o.includes(`Success. Downloaded item ${id}`));
  return withRetries(2, () => runSteamcmd(args, opts, ok));
}
