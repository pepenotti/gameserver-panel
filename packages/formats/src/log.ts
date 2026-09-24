/**
 * PZ server console output (stdout/stderr), as captured from 42.20.4 in
 * fixtures/b42/logs. Header lines look like
 *   LOG  : Network      f:0 st:34,907,676> *** SERVER STARTED ****
 *   WARN : Script       f:0 st:34,865,802 at ModelScript.check     > no such model …
 * and multi-line command replies continue without a header (`* additem : …`).
 */

export type LogLevel = 'LOG' | 'WARN' | 'ERROR' | 'DEBUG' | 'TRACE';

export interface LogLine {
  level: LogLevel | null;
  category?: string;
  /** Message text after the `>` (or the whole line for headerless lines). */
  message: string;
  raw: string;
}

const HEADER = /^(LOG|WARN|ERROR|DEBUG|TRACE)\s*: (\S+)\s+f:\d+ st:[\d,]+(?: at [^>]*?)?\s*> ?(.*)$/;

export function parseLogLine(raw: string): LogLine {
  const m = HEADER.exec(raw);
  if (!m) return { level: null, message: raw, raw };
  return { level: m[1] as LogLevel, category: m[2], message: m[3]!, raw };
}

/** Markers measured on 42.20.4; each matches against `LogLine.message`. */
export const PZ_PATTERNS = {
  ready: /^\*\*\* SERVER STARTED \*\*\*\*/,
  rconListening: /^RCON: listening on port (\d+)/,
  version: /^version=(\S+) (\S+)/,
  adminPrompt: /^Enter new administrator password/,
  worldSaved: /^World saved$/,
  saveFinished: /^Saving finish$/,
  shutdownStarted: /^Shutdown handling started$/,
  shutdownFinished: /^Shutdown handling finished$/,
  optionsReloaded: /^Options reloaded$/,
  optionChanged: /^Option : (\S+) is now : (.*)$/,
  optionParseError: /^ERROR \w+ConfigOption\.parse\(\) "([^"]+)" string="(.*)"$/,
  optionRangeError: /^ERROR: \w+ConfigOption\.setValue\(\) "([^"]+)" (.*)$/,
  consoleCommand: /^command entered via server console \(System\.in\): "(.*)"$/,
  noSteam: /^\*\*\* Steam is not enabled/,
} as const;

/** Lines that mean the process is doomed even if it hasn't exited yet. */
export const FATAL_PATTERNS: RegExp[] = [/java\.lang\.OutOfMemoryError/, /^Exception in thread "main"/, /Could not reserve enough space for object heap/];

export function isFatal(raw: string): boolean {
  return FATAL_PATTERNS.some((re) => re.test(raw));
}

/**
 * `players` reply. 42.20.4 with nobody online: "Players connected (0): \n".
 * With players, earlier builds list one `-name` per line (to re-verify in M3).
 */
export function parsePlayers(body: string): { count: number; names: string[] } | null {
  const m = /Players connected \((\d+)\):/.exec(body);
  if (!m) return null;
  const names = body
    .slice(m.index + m[0].length)
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.startsWith('-'))
    .map((l) => l.slice(1).trim())
    .filter((l) => l !== '');
  return { count: Number(m[1]), names };
}

/**
 * Replaces every secret with `<redacted>`. Also blanks the value after
 * password flags, so a launch command line never leaks.
 */
export function makeRedactor(secrets: Iterable<string | undefined | null>): (line: string) => string {
  const list = [...secrets].filter((s): s is string => typeof s === 'string' && s.length >= 4).sort((a, b) => b.length - a.length);
  return (line) => {
    let out = line;
    for (const s of list) if (out.includes(s)) out = out.split(s).join('<redacted>');
    return out.replace(/(-(?:adminpassword|password)[= ])(\S+)/gi, '$1<redacted>');
  };
}

export interface SteamcmdProgress {
  kind: 'progress' | 'success' | 'error' | 'status';
  state?: string;
  percent?: number;
  message: string;
}

const ANSI = /\x1b\[[0-9;?]*[A-Za-z]/g;

/** steamcmd colours its output (`ESC[0m` before most lines); drop the codes. */
export function stripAnsi(s: string): string {
  return s.replace(ANSI, '');
}

/**
 * steamcmd lines of interest (without a TTY progress arrives in bursts and
 * uses \r, so callers split on /\r|\n/):
 *   Update state (0x61) downloading, progress: 12.34 (123 / 456)
 *   Success! App '380870' fully installed.
 *   Error! App '380870' state is 0x202 after update job.
 */
export function parseSteamcmdLine(line: string): SteamcmdProgress | null {
  const l = stripAnsi(line).trim();
  if (!l) return null;
  let m = /Update state \((0x[0-9a-f]+)\) ([\w ]+), progress: ([\d.]+)/i.exec(l);
  if (m) return { kind: 'progress', state: m[2]!.trim(), percent: Number(m[3]), message: l };
  if (/^Success! App '\d+' (fully installed|already up to date)/.test(l)) return { kind: 'success', message: l };
  m = /^Error! App '\d+' state is (0x[0-9a-f]+)/i.exec(l);
  if (m) return { kind: 'error', state: m[1], message: l };
  if (/^ERROR!|^FAILED|Failed to install app|No subscription/i.test(l)) return { kind: 'error', message: l };
  if (/^(Loading Steam API|Logging in|Connecting anonymously|Waiting for|Downloading item|Success\. Downloaded item)/.test(l)) return { kind: 'status', message: l };
  return null;
}

/**
 * Retryable steamcmd failures (network, Steam hiccups); 0x202 is disk space and is not.
 * "Missing configuration" is what a fresh steamcmd says on its first app_update
 * (fixture steamcmd-first-install.log); the second try works.
 */
export function isRetryableSteamcmdError(state: string | undefined, message: string): boolean {
  if (state === '0x202') return false;
  return state === '0x6' || state === '0x602' || /timed out|timeout|connection|no connection|missing configuration/i.test(message);
}
