/**
 * Minecraft server console output and RCON replies, as captured from 26.3
 * (fixtures/minecraft/26.3/*\/logs, docs/verification/minecraft-26.3.md).
 * Header lines look like
 *   [19:32:53] [Server thread/INFO]: Done (4.945s)! For help, type "help"     vanilla, Fabric
 *   [19:43:29 INFO]: Done (17.555s)! For help, type "help"                    Paper
 * Stack traces, the JVM's own messages and some multi-line output have no header.
 */
import type { PlayerList } from '@gsp/adapter-api';

export interface LogLine {
  /** False for lines without the game's header (stack traces, the JVM, Fabric's mod list). */
  header: boolean;
  /** The header is Paper's `[time LEVEL]:` rather than `[time] [thread/LEVEL]:`. */
  paper: boolean;
  thread: string | null;
  level: string | null;
  /** The text after the header, or the whole line. */
  message: string;
}

const HEADER = /^\[\d\d:\d\d:\d\d(?:\] \[([^\]\r\n]+)\/([A-Z]+)\]| ([A-Z]+)\]): (.*)$/s;

export function parseLogLine(raw: string): LogLine {
  const m = HEADER.exec(raw);
  if (!m) return { header: false, paper: false, thread: null, level: null, message: raw };
  const paper = m[3] !== undefined;
  return { header: true, paper, thread: m[1] ?? null, level: (paper ? m[3] : m[2]) ?? null, message: m[4]! };
}

/** A player name as Minecraft accounts have them; chat lines (`<name> text`) can't pass for one. */
const NAME = '[A-Za-z0-9_]{1,16}';

/** Markers measured on 26.3; each matches a `LogLine.message` unless it says raw. */
export const MC_PATTERNS = {
  /** The server is up (thread `Server thread`). */
  ready: /^Done \(\d+(?:\.\d+)?s\)! For help, type "help"$/,
  /** RCON listens: right after the ready line on vanilla and Fabric, just before it on Paper. */
  rconUp: /^RCON running on \S+:\d+$/,
  version: /^Starting minecraft server version (\S+)$/,
  /** 26.3 prefixes game messages on the console with `System chat: `. */
  join: new RegExp(`^(?:System chat: )?(${NAME}) joined the game$`),
  leave: new RegExp(`^(?:System chat: )?(${NAME}) left the game$`),
  /** The end of a save: console feedback, or RCON's feedback echoed to the log (`[Rcon: …]`). */
  saved: /^(?:System chat: )?(?:\[Rcon: )?Saved the game\]?$/,
  /** `save-off` took effect (or saving was already off). */
  savingOff: /^(?:System chat: )?(?:\[Rcon: )?(?:Automatic saving is now disabled|Saving is already turned off)\]?$/,
  /** `save-on` took effect (or saving was already on). */
  savingOn: /^(?:System chat: )?(?:\[Rcon: )?(?:Automatic saving is now enabled|Saving is already turned on)\]?$/,
  /** The game port is taken: a crash report follows and the process exits 0. */
  bindFailed: /^\*\*\*\* FAILED TO BIND TO PORT!$/,
  /** The server's main loop died (a crash report follows, exit 0). */
  crashed: /^Encountered an unexpected exception$/,
  /** Started without `eula=true`: the server exits 0 right after. */
  eulaRefused: /^You need to agree to the EULA in order to run the server/,
  /** Raw lines (the JVM and Fabric's launcher print them without a header). */
  wrongJava: /UnsupportedClassVersionError/,
  badJar: /^Error: (?:Invalid or corrupt jarfile|Unable to access jarfile) /,
  fabricNoGameJar: /^The Minecraft server \.JAR is missing /,
  /** `list` (trimmed): `There are 2 of a max of 20 players online: a, b`; nothing after the colon when empty. */
  list: /^There are (\d+) of a max of \d+ players online:(.*)$/s,
} as const;

/** The `list` reply; null when it isn't one. */
export function parsePlayerList(reply: string): PlayerList | null {
  const m = MC_PATTERNS.list.exec(reply.trim());
  if (!m) return null;
  const names = m[2]!
    .split(/[,\n]/)
    .map((n) => n.trim())
    .filter((n) => n !== '');
  return { count: Number(m[1]), names };
}
