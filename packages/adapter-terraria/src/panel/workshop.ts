/**
 * tModLoader's mods from the Steam Workshop (MOD-03), through the shared
 * Workshop source (`@gsp/source-workshop`, as Project Zomboid's): Steam's
 * Workshop API for titles and update times, the agent's steamcmd for
 * downloads (anonymous for app 1281930, measured). What is tModLoader's own
 * lives here, as measured (docs/verification/terraria-1.4.5.8.md, "Mods and
 * plugins"; fixtures/terraria/1.4.5.8/tmodloader):
 *   - an item holds one folder per tModLoader version it was built for
 *     (`2022.9`, `2025.6`, `2025.9`, `2026.7`), each with `<ModName>.tmod`;
 *     the mod's name is the file's;
 *   - tModLoader takes the newest folder its own version accepts: not one
 *     built for a newer tModLoader ("a newer version exists" for the others),
 *     and not one of the 1.4.3 line (`2022.9` and older: "a different
 *     Terraria version/LTS release stream");
 *   - the enabled mods are `Mods/enabled.json`, a JSON array of names;
 *   - it runs without Steam (`-nosteam`) and reads only what is on disk, so
 *     the panel downloads missing and updated items before a start
 *     (`serverFetches: false`).
 */
import type { ModEntry, ModSource, RootId, ServerCtx } from '@gsp/adapter-api';
import { createWorkshopSource } from '@gsp/source-workshop';
import { TML_WORKSHOP_APP_ID } from '../shared/meta';

/** tModLoader's last 1.4.3 release line (`v2022.09.48.2`, "1.4.3-Legacy"): folders up to it are another Terraria version's. */
export const TML_LEGACY_LAST: TmlVersion = [2022, 9];
/** The version mods are checked against until the agent reports the installed one: the measured stable. */
export const TML_FALLBACK = '2026.7';

/** A tModLoader version as its Workshop folders name it: year and month. */
export type TmlVersion = [number, number];

/** `2026.7`, `v2026.07.3.0` or `2026.7.3.0` as [year, month]; null for anything else. */
export function tmlVersionOf(s: string | null | undefined): TmlVersion | null {
  const m = /^v?(\d{4})\.(\d{1,2})(?:\.\d+)*$/.exec(s ?? '');
  if (!m) return null;
  const month = Number(m[2]);
  return month >= 1 && month <= 12 ? [Number(m[1]), month] : null;
}

const cmp = (a: TmlVersion, b: TmlVersion) => a[0] - b[0] || a[1] - b[1];

/** One mod in a Workshop item. */
export interface TmlMod extends ModEntry {
  /** The version folder tModLoader will load it from, or null when none fits. */
  versionFolder: string | null;
}

/**
 * The folder tModLoader `tml` loads an item from: the newest one built for
 * it or an older tModLoader of its Terraria line. Otherwise why none fits:
 * `needs-newer-game` (built only for newer tModLoaders), `no-matching-folder`
 * (only for the 1.4.3 line, or no version folder at all).
 */
export function pickVersionFolder(folders: readonly string[], tml: TmlVersion): { folder: string | null; reason: string | null; newest: string | null } {
  const versions = folders.flatMap((f) => {
    const v = /^\d{4}\.\d{1,2}$/.test(f) ? tmlVersionOf(f) : null;
    return v ? [{ f, v }] : [];
  });
  versions.sort((a, b) => cmp(b.v, a.v));
  const newest = versions[0]?.f ?? null;
  const fits = versions.find((x) => cmp(x.v, tml) <= 0 && cmp(x.v, TML_LEGACY_LAST) > 0);
  if (fits) return { folder: fits.f, reason: null, newest };
  const newer = versions.some((x) => cmp(x.v, tml) > 0);
  return { folder: null, reason: newer ? 'needs-newer-game' : 'no-matching-folder', newest };
}

/** The installed tModLoader (the agent's `installedInfo.build`, its release tag), else the pinned one, else the measured stable. */
function tmlOf(ctx: ServerCtx): TmlVersion {
  const build = ctx.status()?.installedInfo?.build;
  const pinned = (ctx.launchSettings() as { version?: unknown } | null)?.version;
  return tmlVersionOf(build) ?? tmlVersionOf(typeof pinned === 'string' ? pinned : null) ?? tmlVersionOf(TML_FALLBACK)!;
}

async function entries(ctx: ServerCtx, root: RootId, rel: string) {
  try {
    return await ctx.files.list(root, rel);
  } catch {
    // Not a folder, or a name the file API refuses.
    return [];
  }
}

/** The mods of a downloaded item, from the version folder tModLoader will load (or its newest, marked as not loading). */
export async function scanTmlItem(ctx: ServerCtx, root: RootId, itemRel: string): Promise<TmlMod[]> {
  const folders = (await entries(ctx, root, itemRel)).filter((e) => e.kind === 'dir').map((e) => e.name);
  const pick = pickVersionFolder(folders, tmlOf(ctx));
  const from = pick.folder ?? pick.newest;
  if (from === null) return [];
  const names = (await entries(ctx, root, `${itemRel}/${from}`)).filter((e) => e.kind === 'file' && /^[A-Za-z0-9_.-]+\.tmod$/.test(e.name)).map((e) => e.name.slice(0, -'.tmod'.length));
  return names.sort().map((name) => ({ modId: name, name, require: [], incompatible: [], compatible: pick.folder !== null, reason: pick.reason, versionFolder: pick.folder }));
}

/**
 * `Mods/enabled.json` as tModLoader writes it (measured: two-space indent,
 * no final newline).
 */
export function enabledJson(names: readonly string[]): string {
  return JSON.stringify([...names], null, 2);
}

/** The Workshop as tModLoader's mod source; `fetch` is replaceable for tests. */
export function createTmlWorkshopSource(o: { fetch?: typeof fetch } = {}): ModSource<TmlMod> {
  return createWorkshopSource<TmlMod>({
    appId: TML_WORKSHOP_APP_ID,
    fetch: o.fetch,
    scan: (ctx, root, itemRel) => scanTmlItem(ctx, root, itemRel),
    fallbackGameVersion: TML_FALLBACK,
    // The list is the enabled mods' names, in load order; the file isn't key/values.
    toConfig: (enabled) => ({ fileId: 'tml-mods', values: {}, text: enabledJson([...new Set(enabled.map((e) => e.modId))]) }),
    serverFetches: false,
  });
}
