import type { EnabledMod as SourceEnabledMod, ModEntry, ModSource, Scalar } from '@gsp/adapter-api';
import type { ConfigStore } from '../config/store';
import { nowIso, type Db } from '../db/db';
import { HttpError } from '../http/context';
import type { AgentFeed } from '../http/deps';
import type { OpRunner } from '../ops/runner';
import type { OpState } from '../ops/bus';
import type { ServerHandle } from '../server/handle';
import type { Settings } from '../settings';

/** A mod source's item as the API shows it (`workshopId` is the item id, whatever the source). */
export interface ModItem {
  workshopId: string;
  title: string;
  previewUrl: string | null;
  timeUpdated: number;
  /** The source's time_updated when the files were last scanned; newer at the source = update available. */
  scannedUpdated: number;
  mods: ModEntry[];
  downloaded: boolean;
  addedAt: string;
  addedBy: string | null;
  error: string | null;
}

/** An enabled mod as stored and shown (`workshopId` is the item it comes from). */
export interface EnabledMod {
  modId: string;
  workshopId: string;
}

export type ModIssue =
  | { kind: 'missing-dependency'; modId: string; requires: string; availableIn: string | null }
  | { kind: 'order'; modId: string; requires: string }
  | { kind: 'incompatible'; modId: string; with: string }
  // The kind keeps the name today's web UI translates; the mod can't load on this game version.
  | { kind: 'not-b42'; modId: string; reason: string | null }
  | { kind: 'not-downloaded'; workshopId: string };

interface Row {
  workshop_id: string;
  title: string;
  preview_url: string | null;
  time_updated: number;
  scanned_updated: number;
  info: string;
  added_at: string;
  added_by: string | null;
  last_checked: string | null;
  error: string | null;
}

export interface ModsDeps {
  db: Db;
  feed: AgentFeed;
  ops: OpRunner;
  settings: Settings;
  config: ConfigStore;
  server: ServerHandle;
  /** The adapter's mod sources; the first one serves the (single) mod list until servers can have several. */
  sources: readonly ModSource[];
}

/** Items per add; what one catalogue lookup and download may take. */
const MAX_ITEMS = 200;

/** Stable topological sort: dependencies first, otherwise keep the given order. */
export function sortByDependencies<T extends { modId: string }>(order: T[], requiresOf: (modId: string) => string[]): T[] {
  const byId = new Map(order.map((m) => [m.modId, m]));
  const out: T[] = [];
  const state = new Map<string, 'visiting' | 'done'>();
  const visit = (m: T) => {
    if (state.get(m.modId) === 'done' || state.get(m.modId) === 'visiting') return; // cycles: keep going
    state.set(m.modId, 'visiting');
    for (const r of requiresOf(m.modId)) {
      const dep = byId.get(r);
      if (dep) visit(dep);
    }
    state.set(m.modId, 'done');
    out.push(m);
  };
  for (const m of order) visit(m);
  return out;
}

/**
 * The server's mods, over the adapter's mod source: items people added (by
 * id, link or collection), what each contains once downloaded, the enabled
 * list in load order, and the config values that list turns into.
 */
export class ModsService {
  constructor(private readonly d: ModsDeps) {}

  /** The source, or 409 when the game has no mod support. */
  private source(): ModSource {
    const s = this.d.sources[0];
    if (!s) throw new HttpError(409, 'capability-unsupported');
    return s;
  }

  get available(): boolean {
    return this.d.sources.length > 0;
  }

  private gameVersion(): string {
    return this.d.feed.status_?.gameVersion ?? '';
  }

  private rows(): Row[] {
    return this.d.db.prepare('SELECT * FROM mods ORDER BY added_at, workshop_id').all() as unknown as Row[];
  }

  private toItem(r: Row, downloaded: boolean): ModItem {
    return {
      workshopId: r.workshop_id,
      title: r.title,
      previewUrl: r.preview_url,
      timeUpdated: r.time_updated,
      scannedUpdated: r.scanned_updated,
      mods: JSON.parse(r.info) as ModEntry[],
      downloaded,
      addedAt: r.added_at,
      addedBy: r.added_by,
      error: r.error,
    };
  }

  /** Every item, with whether its files are on the server now. */
  async items(): Promise<ModItem[]> {
    const source = this.source();
    const ctx = this.d.server.ctx();
    const version = this.gameVersion();
    return Promise.all(this.rows().map(async (r) => this.toItem(r, (await source.scan(ctx, r.workshop_id, version).catch(() => null)) !== null)));
  }

  /** Item ids, without touching the server's files. */
  itemIds(): string[] {
    return this.rows().map((r) => r.workshop_id);
  }

  enabled(): EnabledMod[] {
    return this.d.settings.getRaw<EnabledMod[]>('mods.enabled') ?? [];
  }

  // ------------------------------------------------------------- adding

  /**
   * Resolve refs (ids, links, collections) to the source's items, record
   * them, then download and scan in the background.
   */
  async add(refs: string[], by: string | null): Promise<{ added: string[]; op: OpState }> {
    const source = this.source();
    const ids: string[] = [];
    for (const ref of refs) {
      const id = source.parseRef(ref);
      if (!id) throw new HttpError(400, 'invalid-mod-ref', undefined, { ref });
      const children = source.expand ? await source.expand(id).catch(() => []) : [];
      ids.push(...(children.length ? children : [id]));
    }
    const unique = [...new Set(ids)].slice(0, MAX_ITEMS);
    const details = await source.details(unique);
    const bad = details.filter((x) => !x.ok);
    if (bad.length) throw new HttpError(400, 'mod-not-for-game', undefined, { ids: bad.map((x) => x.id) });
    const now = nowIso();
    const ins = this.d.db.prepare(
      'INSERT INTO mods (workshop_id, title, preview_url, time_updated, added_at, added_by, last_checked) VALUES (?,?,?,?,?,?,?) ON CONFLICT(workshop_id) DO UPDATE SET title = excluded.title, preview_url = excluded.preview_url, time_updated = excluded.time_updated, last_checked = excluded.last_checked',
    );
    for (const x of details) ins.run(x.id, x.title, x.previewUrl, x.timeUpdated, now, by, now);
    const op = this.startDownload(
      details.map((x) => x.id),
      by,
    );
    return { added: details.map((x) => x.id), op };
  }

  /** Download items onto the server (through its agent) and read what they contain. */
  startDownload(ids: string[], by: string | null): OpState {
    const source = this.source();
    return this.d.ops.start('mods', by, async (ctx) => {
      ctx.step('downloading');
      const r = await source.download(this.d.server.ctx(by), ids);
      if (!r.ok) {
        for (const id of ids) this.d.db.prepare('UPDATE mods SET error = ? WHERE workshop_id = ?').run(r.error ?? 'download failed', id);
        throw new Error(r.error ?? 'download failed');
      }
      ctx.step('scanning');
      await this.rescan(ids);
    });
  }

  /** Re-read what downloaded items contain (after the server or the agent downloaded them). */
  async rescan(ids?: string[]): Promise<void> {
    if (!this.available) return;
    const source = this.source();
    const ctx = this.d.server.ctx();
    const version = this.gameVersion();
    for (const r of this.rows()) {
      if (ids && !ids.includes(r.workshop_id)) continue;
      const mods = await source.scan(ctx, r.workshop_id, version).catch(() => null);
      if (!mods) continue;
      this.d.db.prepare('UPDATE mods SET info = ?, scanned_updated = time_updated, error = ? WHERE workshop_id = ?').run(JSON.stringify(mods), mods.length ? null : 'no mods found in this item', r.workshop_id);
      // A single-mod item is enabled on arrival (first scan only, so a later
      // rescan never re-enables something an admin turned off); multi-mod
      // items (variants) wait for a choice.
      const firstScan = r.info === '[]';
      const enabled = this.enabled();
      if (firstScan && mods.length === 1 && !enabled.some((e) => e.workshopId === r.workshop_id)) {
        await this.setEnabled([...enabled, { modId: mods[0]!.modId, workshopId: r.workshop_id }], null);
      }
    }
  }

  // ---------------------------------------------------------- enable/order

  private knownMods(): Map<string, { workshopId: string; mod: ModEntry }> {
    const m = new Map<string, { workshopId: string; mod: ModEntry }>();
    for (const r of this.rows()) for (const mod of JSON.parse(r.info) as ModEntry[]) if (!m.has(mod.modId)) m.set(mod.modId, { workshopId: r.workshop_id, mod });
    return m;
  }

  /** Save the enabled list (in load order) and write the config values it turns into. */
  async setEnabled(list: EnabledMod[], by: string | null): Promise<{ restartNeeded: boolean }> {
    const known = this.knownMods();
    const seen = new Set<string>();
    const clean: EnabledMod[] = [];
    for (const e of list) {
      const k = known.get(e.modId);
      if (!k) throw new HttpError(400, 'unknown-mod', undefined, { modId: e.modId });
      if (seen.has(e.modId)) continue;
      seen.add(e.modId);
      clean.push({ modId: e.modId, workshopId: k.workshopId });
    }
    this.d.settings.setRaw('mods.enabled', clean);
    return this.writeConfig(by);
  }

  async autoSort(by: string | null): Promise<EnabledMod[]> {
    const known = this.knownMods();
    const sorted = sortByDependencies(this.enabled(), (id) => known.get(id)?.mod.require ?? []);
    await this.setEnabled(sorted, by);
    return sorted;
  }

  async remove(workshopId: string, by: string | null): Promise<{ restartNeeded: boolean }> {
    const r = this.d.db.prepare('DELETE FROM mods WHERE workshop_id = ?').run(workshopId);
    if (Number(r.changes) === 0) throw new HttpError(404, 'not-found');
    this.d.settings.setRaw(
      'mods.enabled',
      this.enabled().filter((e) => e.workshopId !== workshopId),
    );
    return this.writeConfig(by);
  }

  /** The config file and values the enabled list turns into (the source decides both). */
  configValues(): { fileId: string; values: Record<string, Scalar> } {
    const known = this.knownMods();
    const entries = new Map([...known].map(([id, k]) => [id, k.mod]));
    const enabled: SourceEnabledMod[] = this.enabled().map((e) => ({ modId: e.modId, itemId: e.workshopId }));
    return this.source().toConfig(enabled, entries);
  }

  /** Write the list into the source's config file (first-run files are created first); a running server needs a restart. */
  private async writeConfig(by: string | null): Promise<{ restartNeeded: boolean }> {
    const { fileId, values } = this.configValues();
    await this.d.config.seedIfMissing();
    await this.d.config.setDirect(fileId, values, by, 'mod list');
    const running = ['running', 'starting'].includes(this.d.feed.status_?.state ?? '');
    if (running) this.d.config.markPendingPublic(['Mods']);
    return { restartNeeded: running };
  }

  /**
   * First look: adopt mods already in the config (written by hand, or from a
   * restored backup) so the panel doesn't silently drop them.
   */
  async importFromConfig(): Promise<void> {
    if (!this.available || this.d.settings.getRaw('mods.imported')) return;
    this.d.settings.setRaw('mods.imported', true);
    const source = this.source();
    if (!source.fromConfig) return;
    const { fileId } = source.toConfig([], new Map());
    const current = await this.d.config.values(fileId);
    if (current.missing) return;
    const { items, enabled } = source.fromConfig(current.values);
    const now = nowIso();
    for (const id of items) this.d.db.prepare('INSERT OR IGNORE INTO mods (workshop_id, title, added_at, added_by) VALUES (?, ?, ?, ?)').run(id, id, now, null);
    await this.rescan();
    const known = this.knownMods();
    this.d.settings.setRaw(
      'mods.enabled',
      enabled.filter((m) => known.has(m)).map((m) => ({ modId: m, workshopId: known.get(m)!.workshopId })),
    );
  }

  // ------------------------------------------------------------- health

  issues(items: ModItem[]): ModIssue[] {
    const known = this.knownMods();
    const enabled = this.enabled();
    const pos = new Map(enabled.map((e, i) => [e.modId, i]));
    const out: ModIssue[] = [];
    for (const item of items) if (!item.downloaded && enabled.some((e) => e.workshopId === item.workshopId)) out.push({ kind: 'not-downloaded', workshopId: item.workshopId });
    for (const e of enabled) {
      const k = known.get(e.modId);
      if (!k) continue;
      if (!k.mod.compatible) out.push({ kind: 'not-b42', modId: e.modId, reason: k.mod.reason });
      for (const r of k.mod.require) {
        if (!pos.has(r)) out.push({ kind: 'missing-dependency', modId: e.modId, requires: r, availableIn: known.get(r)?.workshopId ?? null });
        else if (pos.get(r)! > pos.get(e.modId)!) out.push({ kind: 'order', modId: e.modId, requires: r });
      }
      for (const x of k.mod.incompatible) if (pos.has(x)) out.push({ kind: 'incompatible', modId: e.modId, with: x });
    }
    return out;
  }

  /** Ask the source for current update times; returns items newer there than what was scanned. */
  async checkUpdates(): Promise<string[]> {
    const rows = this.rows();
    if (rows.length === 0 || !this.available) return [];
    const details = await this.source().details(rows.map((r) => r.workshop_id));
    const now = nowIso();
    for (const x of details) {
      if (!x.ok) continue;
      this.d.db.prepare('UPDATE mods SET title = ?, preview_url = ?, time_updated = ?, last_checked = ? WHERE workshop_id = ?').run(x.title, x.previewUrl, x.timeUpdated, now, x.id);
    }
    return this.rows()
      .filter((r) => r.scanned_updated > 0 && r.time_updated > r.scanned_updated)
      .map((r) => r.workshop_id);
  }
}
