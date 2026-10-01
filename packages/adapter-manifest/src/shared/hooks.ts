/**
 * Code a game adds to its manifest where the manifest can't say everything
 * (D4: "Valheim runs via manifest plus hooks"). Each hook is optional; the
 * adapters the manifest makes call them at the points named here, and the
 * last two take the finished adapter and return it changed (they must keep
 * its `meta`: both halves share it).
 */
import type { PanelAdapter, PlayerList, RuntimeAdapter, RuntimeCtx } from '@gsp/adapter-api';
import type { ManifestLaunch, ManifestSettings } from './settings';

export interface ManifestRuntimeHooks {
  /**
   * `RuntimeAdapter.hotCopy.select` (BAK-02): narrows a running backup to a
   * consistent set of files (Valheim: its newest complete save set). The
   * agent copies the picks as they are and asks again, once, when one
   * vanished. With it, `copy-between-saves` neither waits out the game's
   * own save in progress nor fails a copy one overlaps: the picks are
   * files such a save doesn't touch.
   */
  hotCopySelect?(ctx: RuntimeCtx, files: string[]): Promise<string[]>;
  /**
   * Who is online from Steam's server queries (A2S) on the port
   * `players.steamQuery` names, while its condition holds (PLY-01). Without
   * it, a manifest's `steamQuery` falls back to its join and leave lines.
   */
  steamQuery?(ctx: RuntimeCtx, port: number): Promise<PlayerList | null>;
  /** The runtime adapter the manifest made, changed or completed. */
  runtime?(a: RuntimeAdapter<ManifestLaunch>): RuntimeAdapter<ManifestLaunch>;
}

export interface ManifestPanelHooks {
  /** The panel adapter the manifest made, changed or completed. */
  panel?(a: PanelAdapter<ManifestSettings>): PanelAdapter<ManifestSettings>;
}

export type ManifestHooks = ManifestRuntimeHooks & ManifestPanelHooks;
