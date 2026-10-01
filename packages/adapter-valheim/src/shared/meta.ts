import type { AdapterMeta } from '@gsp/adapter-api';
import { loadManifest, manifestMeta, type SteamGameManifest } from '@gsp/adapter-manifest/shared';
import valheimJson from '../../manifest/valheim.json';

/**
 * Valheim as a Steam manifest plus hooks (M6, D4: "Valheim runs via
 * manifest plus hooks"): `manifest/valheim.json` says everything the
 * manifest format can (app 896660, the launch, its lines, ports, settings
 * and their rules, the stop signal, autosaves, list files, backups, notes),
 * from the dedicated server 1.0.16 as measured
 * (docs/verification/valheim-1.0.16.md, fixtures/valheim/1.0.16). It is
 * checked against the manifest schema when this module loads.
 */
export const VALHEIM: SteamGameManifest = loadManifest(valheimJson);

/** Shared by the runtime and panel halves (one object, as the adapter list expects). */
export const VALHEIM_META: AdapterMeta = manifestMeta(VALHEIM);
