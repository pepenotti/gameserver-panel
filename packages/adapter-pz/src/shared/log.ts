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
