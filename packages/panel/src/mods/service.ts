import { existsSync } from 'node:fs';
import { formatModsLine, formatWorkshopItems, getIniValue, parseIni, parseModsLine, parseWorkshopItems, parseWorkshopRef } from '@pz/formats';
import type { AgentApi } from '../agent/client';
import type { ConfigService } from '../config/service';
import { nowIso, type Db } from '../db/db';
import type { PanelEnv } from '../env';
import { HttpError } from '../http/context';
import type { AgentFeed } from '../http/deps';
import type { OpRunner } from '../ops/runner';
import type { OpState } from '../ops/bus';
import type { Settings } from '../settings';
import { itemDirs, scanItem, type ScannedMod } from './scan';
import { PZ_APP_ID, type SteamWorkshop } from './steam';

export const VANILLA_MAP = 'Muldraugh, KY';

export interface ModItem {
  workshopId: string;
  title: string;
  previewUrl: string | null;
  timeUpdated: number;
  /** Steam's time_updated when the files were last scanned; newer on Steam = update available. */
  scannedUpdated: number;
  mods: ScannedMod[];
  downloaded: boolean;
  addedAt: string;
  addedBy: string | null;
  error: string | null;
}

export interface EnabledMod {
  modId: string;
  workshopId: string;
}

export type ModIssue =
  | { kind: 'missing-dependency'; modId: string; requires: string; availableIn: string | null }
  | { kind: 'order'; modId: string; requires: string }
  | { kind: 'incompatible'; modId: string; with: string }
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
  env: PanelEnv;
  db: Db;
  agent: AgentApi;
  feed: AgentFeed;
  ops: OpRunner;
  settings: Settings;
  config: ConfigService;
  steam: SteamWorkshop;
}

/** Stable topological sort: dependencies first, otherwise keep the given order. */
export function sortByDependencies(order: EnabledMod[], requiresOf: (modId: string) => string[]): EnabledMod[] {
  const byId = new Map(order.map((m) => [m.modId, m]));
  const out: EnabledMod[] = [];
  const state = new Map<string, 'visiting' | 'done'>();
  const visit = (m: EnabledMod) => {
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

export class ModsService {
  constructor(private readonly d: ModsDeps) {}

  private gameVersion(): string {
    return this.d.feed.status_?.gameVersion ?? '42.20.4';
  }

  private rows(): Row[] {
    return this.d.db.prepare('SELECT * FROM mods ORDER BY added_at, workshop_id').all() as unknown as Row[];
  }

  private toItem(r: Row): ModItem {
    const downloaded = itemDirs(this.d.env.pzInstallDir, this.d.env.pzDataDir, r.workshop_id).some((dir) => existsSync(dir));
    return {
      workshopId: r.workshop_id,
      title: r.title,
      previewUrl: r.preview_url,
      timeUpdated: r.time_updated,
      scannedUpdated: r.scanned_updated,
      mods: JSON.parse(r.info) as ScannedMod[],
      downloaded,
      addedAt: r.added_at,
      addedBy: r.added_by,
      error: r.error,
    };
  }

  items(): ModItem[] {
    return this.rows().map((r) => this.toItem(r));
  }

  enabled(): EnabledMod[] {
    return this.d.settings.getRaw<EnabledMod[]>('mods.enabled') ?? [];
  }

  // ------------------------------------------------------------- adding

  /**
   * Resolve refs (ids, URLs, collections) to PZ workshop items, record them,
   * then download and scan in the background.
   */
  async add(refs: string[], by: string | null): Promise<{ added: string[]; op: OpState }> {
    const ids: string[] = [];
    for (const ref of refs) {
      const id = parseWorkshopRef(ref);
      if (!id) throw new HttpError(400, 'invalid-workshop-ref', undefined, { ref });
      const children = await this.d.steam.collectionChildren(id).catch(() => []);
      ids.push(...(children.length ? children : [id]));
    }
    const unique = [...new Set(ids)].slice(0, 200);
    const details = await this.d.steam.details(unique);
    const bad = details.filter((x) => !x.ok || x.appId !== PZ_APP_ID);
    if (bad.length) throw new HttpError(400, 'not-a-pz-mod', undefined, { ids: bad.map((x) => x.id) });
    const now = nowIso();
    const ins = this.d.db.prepare('INSERT INTO mods (workshop_id, title, preview_url, time_updated, added_at, added_by, last_checked) VALUES (?,?,?,?,?,?,?) ON CONFLICT(workshop_id) DO UPDATE SET title = excluded.title, preview_url = excluded.preview_url, time_updated = excluded.time_updated, last_checked = excluded.last_checked');
    for (const x of details) ins.run(x.id, x.title, x.previewUrl, x.timeUpdated, now, by, now);
    const op = this.startDownload(details.map((x) => x.id), by);
    return { added: details.map((x) => x.id), op };
  }

  /** Download items with the agent's steamcmd and read their mod.info files. */
  startDownload(ids: string[], by: string | null): OpState {
    return this.d.ops.start('mods', by, async (ctx) => {
      ctx.step('downloading');
      const r = await this.d.agent.downloadWorkshop(ids);
      if (!r.ok) {
        for (const id of ids) this.d.db.prepare('UPDATE mods SET error = ? WHERE workshop_id = ?').run(r.error ?? 'download failed', id);
        throw new Error(r.error ?? 'download failed');
      }
      ctx.step('scanning');
      this.rescan(ids);
    });
  }

  /** Re-read mod.info for items (after the server or steamcmd downloaded them). */
  rescan(ids?: string[]): void {
    const version = this.gameVersion();
    for (const r of this.rows()) {
      if (ids && !ids.includes(r.workshop_id)) continue;
      const dir = itemDirs(this.d.env.pzInstallDir, this.d.env.pzDataDir, r.workshop_id).find((x) => existsSync(x));
      if (!dir) continue;
      const mods = scanItem(dir, version);
      this.d.db.prepare('UPDATE mods SET info = ?, scanned_updated = time_updated, error = ? WHERE workshop_id = ?').run(JSON.stringify(mods), mods.length ? null : 'no mods found in this item', r.workshop_id);
      // A single-mod item is enabled on arrival (first scan only, so a later
      // rescan never re-enables something an admin turned off); multi-mod
      // items (variants) wait for a choice.
      const firstScan = r.info === '[]';
      const enabled = this.enabled();
      if (firstScan && mods.length === 1 && !enabled.some((e) => e.workshopId === r.workshop_id)) {
        this.setEnabled([...enabled, { modId: mods[0]!.modId, workshopId: r.workshop_id }], null);
      }
    }
  }

  // ---------------------------------------------------------- enable/order

  private knownMods(): Map<string, { workshopId: string; mod: ScannedMod }> {
    const m = new Map<string, { workshopId: string; mod: ScannedMod }>();
    for (const item of this.items()) for (const mod of item.mods) if (!m.has(mod.modId)) m.set(mod.modId, { workshopId: item.workshopId, mod });
    return m;
  }

  /** Save the enabled list (in load order) and write it to the ini. */
  setEnabled(list: EnabledMod[], by: string | null): { restartNeeded: boolean } {
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
    return this.writeIni(by);
  }

  autoSort(by: string | null): EnabledMod[] {
    const known = this.knownMods();
    const sorted = sortByDependencies(this.enabled(), (id) => known.get(id)?.mod.require ?? []);
    this.setEnabled(sorted, by);
    return sorted;
  }

  remove(workshopId: string, by: string | null): { restartNeeded: boolean } {
    const r = this.d.db.prepare('DELETE FROM mods WHERE workshop_id = ?').run(workshopId);
    if (Number(r.changes) === 0) throw new HttpError(404, 'not-found');
    this.d.settings.setRaw('mods.enabled', this.enabled().filter((e) => e.workshopId !== workshopId));
    return this.writeIni(by);
  }

  /** Mods, WorkshopItems and Map lines, derived from the enabled list. */
  iniLines(): Record<'Mods' | 'WorkshopItems' | 'Map', string> {
    const known = this.knownMods();
    const enabled = this.enabled();
    const workshop = [...new Set(enabled.map((e) => e.workshopId))];
    const maps = enabled.flatMap((e) => known.get(e.modId)?.mod.maps ?? []);
    return {
      Mods: formatModsLine(enabled.map((e) => e.modId)),
      WorkshopItems: formatWorkshopItems(workshop),
      // Map mods go before the vanilla map.
      Map: [...new Set([...maps, VANILLA_MAP])].join(';'),
    };
  }

  private writeIni(by: string | null): { restartNeeded: boolean } {
    const lines = this.iniLines();
    this.d.config.seedIniIfMissing();
    this.d.config.setIniDirect(lines, by, 'mod list');
    const running = ['running', 'starting'].includes(this.d.feed.status_?.state ?? '');
    if (running) this.d.config.markPendingPublic(['Mods']);
    return { restartNeeded: running };
  }

  /**
   * First look: adopt mods already listed in the ini (hand-written, or from a
   * restored backup) so the panel doesn't silently drop them.
   */
  importFromIni(): void {
    if (this.d.settings.getRaw('mods.imported')) return;
    this.d.settings.setRaw('mods.imported', true);
    const text = this.d.config.read('ini');
    if (!text) return;
    const doc = parseIni(text);
    const workshop = parseWorkshopItems(getIniValue(doc, 'WorkshopItems') ?? '');
    const mods = parseModsLine(getIniValue(doc, 'Mods') ?? '');
    const now = nowIso();
    for (const id of workshop) {
      this.d.db.prepare('INSERT OR IGNORE INTO mods (workshop_id, title, added_at, added_by) VALUES (?, ?, ?, ?)').run(id, id, now, null);
    }
    this.rescan();
    const known = this.knownMods();
    this.d.settings.setRaw(
      'mods.enabled',
      mods.filter((m) => known.has(m)).map((m) => ({ modId: m, workshopId: known.get(m)!.workshopId })),
    );
  }

  // ------------------------------------------------------------- health

  issues(): ModIssue[] {
    const known = this.knownMods();
    const enabled = this.enabled();
    const pos = new Map(enabled.map((e, i) => [e.modId, i]));
    const out: ModIssue[] = [];
    for (const item of this.items()) if (!item.downloaded && enabled.some((e) => e.workshopId === item.workshopId)) out.push({ kind: 'not-downloaded', workshopId: item.workshopId });
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

  /** Ask Steam for current update times; returns items with a newer version than scanned. */
  async checkUpdates(): Promise<string[]> {
    const rows = this.rows();
    if (rows.length === 0) return [];
    const details = await this.d.steam.details(rows.map((r) => r.workshop_id));
    const now = nowIso();
    for (const x of details) {
      if (!x.ok) continue;
      this.d.db.prepare('UPDATE mods SET title = ?, preview_url = ?, time_updated = ?, last_checked = ? WHERE workshop_id = ?').run(x.title, x.previewUrl, x.timeUpdated, now, x.id);
    }
    return this.items()
      .filter((i) => i.scannedUpdated > 0 && i.timeUpdated > i.scannedUpdated)
      .map((i) => i.workshopId);
  }
}
