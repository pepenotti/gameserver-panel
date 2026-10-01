/**
 * Which files a running backup of Valheim takes (BAK-02, the
 * `hotCopySelect` hook): only each world's newest complete save set, plus
 * everything outside the worlds (the admin, ban and allowed lists).
 *
 * Valheim 1.0 saves a world as a numbered set in `worlds_local/<world>/`
 * (measured on 1.0.16, docs/verification/valheim-1.0.16.md "Saving and
 * backups"): set <n> = the previous one + 1, written as
 * `00_00__0_<n>.chunk`, `_main.<n>.chunks`, `_main.<n>.db2`,
 * `_main.<n>.fwl2`, then the `_main.<n>.ok` marker, and only then are the
 * files of set <n-1> deleted. A set is never written again after its
 * marker, so the newest set with one is a consistent copy while the game
 * runs; a copy of the whole folder that overlaps a save could hold the new
 * set without its marker, or miss the old one's files.
 */

const WORLD_FILE = /^worlds_local\/([^/]+)\/([^/]+)$/;
const MAIN = /^_main\.(\d+)\.(ok|db2|fwl2|chunks)$/;
const CHUNK = /^(.+)_(\d+)\.chunk$/;
/** What makes a set complete: its marker, and the world's database and header it marks. */
const REQUIRED = ['ok', 'db2', 'fwl2'] as const;

/**
 * The files of `files` (data-root paths) a running copy takes. For each
 * world folder: the highest <n> whose `.ok`, `.db2` and `.fwl2` are all
 * there, its `.chunks`, and for each chunk the newest file numbered <n> or
 * less (each chunk file was rewritten with every set in the measured
 * worlds, which had one; should a chunk the save left unchanged keep an
 * older number, it is still taken). Nothing else of a world folder: no
 * half-written newer set, no leftovers of an older one, no subfolders. A
 * new world before its first save holds only `_main.0.fwl2` (its name and
 * seed, measured), which is taken. Files outside the world folders are kept.
 */
export function newestCompleteSaves(files: readonly string[]): string[] {
  const out: string[] = [];
  const worlds = new Map<string, Set<string>>();
  for (const f of files) {
    if (!f.startsWith('worlds_local/')) {
      out.push(f);
      continue;
    }
    const w = WORLD_FILE.exec(f);
    // A file right in worlds_local/ isn't a numbered save (none was seen): kept as it is. Subfolders of a world: left out.
    if (!w) {
      if (f.split('/').length === 2) out.push(f);
      continue;
    }
    const names = worlds.get(w[1]!) ?? new Set<string>();
    names.add(w[2]!);
    worlds.set(w[1]!, names);
  }
  for (const [world, names] of worlds) {
    const at = (name: string) => `worlds_local/${world}/${name}`;
    const parts = new Map<number, Set<string>>();
    for (const name of names) {
      const m = MAIN.exec(name);
      if (!m) continue;
      const n = Number(m[1]);
      const have = parts.get(n) ?? new Set<string>();
      have.add(m[2]!);
      parts.set(n, have);
    }
    const complete = [...parts].filter(([, have]) => REQUIRED.every((x) => have.has(x))).map(([n]) => n);
    if (complete.length === 0) {
      if (names.has('_main.0.fwl2')) out.push(at('_main.0.fwl2'));
      continue;
    }
    const n = Math.max(...complete);
    for (const ext of ['chunks', ...REQUIRED]) if (parts.get(n)!.has(ext)) out.push(at(`_main.${n}.${ext}`));
    const chunks = new Map<string, number>();
    for (const name of names) {
      const c = CHUNK.exec(name);
      if (!c) continue;
      const k = Number(c[2]);
      if (k <= n && (chunks.get(c[1]!) ?? -1) < k) chunks.set(c[1]!, k);
    }
    for (const [key, k] of chunks) out.push(at(`${key}_${k}.chunk`));
  }
  return out.sort();
}
