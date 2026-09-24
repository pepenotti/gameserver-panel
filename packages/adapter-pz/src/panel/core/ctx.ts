import type { ServerCtx, VersionsResponse } from '@gsp/adapter-api';

/**
 * What this adapter needs from the panel beyond `ServerCtx`. The panel's
 * ServerCtx carries these members until the contract grows them (contract
 * requests in the M1-B hand-off); this file is the only place that reads
 * them, so dropping it later is a local change.
 */
export interface PanelExtras {
  /** `POST /v1/versions` for the stored launch settings (the update check). */
  versions(): Promise<VersionsResponse>;
  /** The launch settings the panel stores for the server. */
  launchSettings(): unknown;
  /** The panel's settings service (history, managed keys) for resets and the first start. */
  config: SettingsAccess;
  /** Who the operation runs for (settings history); null for the panel itself. */
  actor: string | null;
}

/** The part of the panel's `ConfigStore` this adapter calls; its signatures are frozen for the M1 wave. */
export interface SettingsAccess {
  /** Writes the first-run settings when the server ini doesn't exist yet. */
  seedIniIfMissing(): boolean;
  /** Changes ini keys (no managed-key or busy checks), recorded in the history under `note`. */
  setIniDirect(changes: Record<string, string>, by: string | null, note: string): void;
  /** Copies a game sandbox preset onto the server's sandbox settings. */
  applyPreset(name: string, by: string | null, opts?: { force?: boolean }): unknown;
}

export function extras(ctx: ServerCtx): Partial<PanelExtras> {
  return ctx as ServerCtx & Partial<PanelExtras>;
}

export function required<K extends keyof PanelExtras>(ctx: ServerCtx, key: K): PanelExtras[K] {
  const value = extras(ctx)[key];
  if (value === undefined) throw new Error(`Project Zomboid: the panel did not provide "${key}"`);
  return value as PanelExtras[K];
}
