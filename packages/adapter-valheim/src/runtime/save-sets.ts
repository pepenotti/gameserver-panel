/**
 * Which files a running backup of Valheim takes (BAK-02, the
 * `hotCopySelect` hook): only each world's newest complete save, plus
 * everything outside the worlds (the admin, ban and allowed lists).
 *
 * Valheim 1.0 saves a world as a numbered set in `worlds_local/<world>/`
 * (measured on 1.0.16, docs/verification/valheim-1.0.16.md): save <n>
 * writes the chunks that changed, then `_main.<n>.chunks` (the index of
 * the world's chunk files), `_main.<n>.db2`, `_main.<n>.fwl2`, then the
 * `_main.<n>.ok` marker, and only then deletes the files save <n-1> no
 * longer needs. A chunk file is named after the chunk and its own version,
 * `00_00__0_<v>.chunk`, which goes up only when the chunk changed: in the
 * adapter check, saves 2 to 4 changed nothing and kept using
 * `00_00__0_1.chunk`, save 5 wrote `00_00__0_2.chunk` (in the
 * fact-finding every save changed it, so its version followed the save
 * number). Nothing of a set is written again after its marker, so the
 * newest set with one, with the chunk files it uses, is a consistent copy
 * while the game runs; a copy of the whole folder that overlaps a save
 * could hold the new set without its marker, or a chunk the next save is
 * still writing.
 */

const WORLD_FILE = /^worlds_local\/([^/]+)\/([^/]+)$/;
const MAIN = /^_main\.(\d+)\.(ok|db2|fwl2|chunks)$/;
const CHUNK = /^(.+)_(\d+)\.chunk$/;
/** What makes a set complete: its marker, and the world's database and header it marks. */
const REQUIRED = ['ok', 'db2', 'fwl2'] as const;

/**
 * When each file was written (its modification time, ms), or null when it
 * can't be told (it vanished): the chunk files a set uses were written
 * before its marker, a newer save's after it.
 */
export type WrittenAt = (rel: string) => number | null;

/**
 * The files of `files` (data-root paths) a running copy takes. For each
 * world folder: the highest <n> whose `.ok`, `.db2` and `.fwl2` are all
 * there, its `.chunks`, and for each chunk its newest file written no
 * later than that `.ok` (a newer one belongs to a save still in progress;
 * an older one is a leftover the game is deleting). Nothing else of a world
 * folder: no half-written newer set, no subfolders. A new world before its
 * first save holds only `_main.0.fwl2` (its name and seed, measured), which
 * is taken. Files outside the world folders are kept. A file whose time
 * can't be told is offered anyway: if it vanished, the agent notices and
 * asks again.
 *
 * The set's own index (`.chunks`) names each chunk's version (the measured
 * one-chunk worlds held it at bytes 13-16), but how it names the chunks of a
 * bigger world wasn't measured, so the times decide.
 */
export function newestCompleteSaves(files: readonly string[], writtenAt: WrittenAt): string[] {
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
    const marked = writtenAt(at(`_main.${n}.ok`)) ?? Infinity;
    const chunks = new Map<string, number>();
    for (const name of names) {
      const c = CHUNK.exec(name);
      if (!c) continue;
      const v = Number(c[2]);
      if ((writtenAt(at(name)) ?? -Infinity) > marked) continue;
      if ((chunks.get(c[1]!) ?? -1) < v) chunks.set(c[1]!, v);
    }
    for (const [key, v] of chunks) out.push(at(`${key}_${v}.chunk`));
  }
  return out.sort();
}
