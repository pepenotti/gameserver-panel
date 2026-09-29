/**
 * Terraria's console output, as captured from vanilla 1.4.5.8, TShock 6.2.1
 * and tModLoader v2026.07.3.0 (fixtures/terraria/1.4.5.8/*\/logs,
 * docs/verification/terraria-1.4.5.8.md). Lines have no header. The console
 * prints its prompt `: ` without a newline, so the next line it prints
 * starts with it (`: Server started`), and vanilla's first line starts with
 * two byte-order marks.
 */
import type { PlayerList } from '@gsp/adapter-api';

/** A console line without the byte-order marks and `: ` prompts in front of it. */
export function bare(line: string): string {
  return line.replace(/^(?:\uFEFF|: )+/, '');
}

/** Markers measured on the three flavours; each matches a `bare` line. */
export const TR_PATTERNS = {
  /** Up and taking players (never `Listening on port`, printed even when the port is taken). */
  ready: /^Server started$/,
  /** The game version (tModLoader's is the Terraria it is built on). */
  version: /^Terraria Server v(\d+(?:\.\d+){3})$/,
  /** TShock adds `<name> has joined. IP: <ip>`, which this leaves out. */
  join: /^(.+) has joined\.$/,
  leave: /^(.+) has left\.$/,
  /** The end of a save: the `.wld` is complete (tModLoader writes its `.twld` next). */
  saved: /^(?:Backing up world file|Saving modded world data)$/,
  /** The world menu: the game got no world and waits for a choice nobody will type. */
  worldMenu: /^n\t\tNew World$/,
  /** vanilla and tModLoader `playing`: one line per player, then the count. */
  playingPlayer: /^(.+) \(([^()\s]+):(\d+)\)$/,
  playingCount: /^(?:No players connected\.|(\d+) players? connected\.)$/,
  /** TShock `playing`: none, or a count and the names on the next line. */
  tshockNobody: /^There are currently no players online\.$/,
  tshockOnline: /^Online Players \((\d+)\/\d+\)$/,
  /** TShock's first-run setup code (whoever types it in game becomes superadmin): a secret. */
  setupCode: /(\/setup )\d+/g,
} as const;

/**
 * Lines after which the process is doomed or useless. Several failures end
 * in a silent exit 0 (a corrupt world prints `Load failed!`), and without a
 * writable save folder the game says it started but created no world.
 */
export const FATAL: readonly RegExp[] = [
  /^Load failed!/,
  /FATAL UNHANDLED EXCEPTION/,
  /^Failed to create the file: .*favorites\.json/,
  /^You must install \.NET to run this application\./,
  /^Failure processing application bundle\./,
  /^Process terminated\. Couldn't find a valid ICU package/,
  /^tModLoader v\S+ Fatal Error$/,
  /^Unhandled exception\./,
];

/** What people see of a line: without the prompt and byte-order marks, TShock's setup code hidden. */
export function display(text: string): string {
  return bare(text).replace(TR_PATTERNS.setupCode, '$1<hidden>');
}

/**
 * The reply to `playing`, from the lines printed since it was sent (other
 * output may be among them): vanilla's and tModLoader's list, or TShock's.
 * Null until a whole reply is there.
 */
export function parsePlaying(lines: readonly string[]): PlayerList | null {
  const all = lines.map(bare);
  const names: string[] = [];
  for (let i = 0; i < all.length; i++) {
    const l = all[i]!;
    const p = TR_PATTERNS.playingPlayer.exec(l);
    if (p) {
      names.push(p[1]!);
      continue;
    }
    const c = TR_PATTERNS.playingCount.exec(l);
    if (c) return { count: c[1] === undefined ? 0 : Number(c[1]), names: c[1] === undefined ? [] : names };
    if (TR_PATTERNS.tshockNobody.test(l)) return { count: 0, names: [] };
    const t = TR_PATTERNS.tshockOnline.exec(l);
    if (t) {
      const next = all[i + 1];
      if (next === undefined) return null;
      return { count: Number(t[1]), names: next.split(', ').map((n) => n.trim()).filter((n) => n !== '') };
    }
  }
  return null;
}

/** Whether `lines` hold a whole `playing` reply yet (`ControlHandle.waitForLines`). */
export const playingDone = (lines: readonly string[]): boolean => parsePlaying(lines) !== null;
