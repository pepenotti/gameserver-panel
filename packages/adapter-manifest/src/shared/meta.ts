import type { AdapterMeta } from '@gsp/adapter-api';

/**
 * Other Steam games, described by a declarative manifest (G4, D4), shared
 * by the runtime and panel halves.
 *
 * A skeleton (M3 contract step, for M6): the manifest itself (app id,
 * launch command, ports, readiness pattern, stop method, config files,
 * backup paths; PRD §10 "Declarative adapters") and whether each manifest
 * becomes an adapter of its own come in M6, from a real game measured first
 * (D5). What the PRD settles is filled in: installed with steamcmd, so the
 * steam family and x86-64 only. Every value marked TODO is a placeholder
 * nothing relies on; the adapter is registered but not offered
 * (`packages/adapters`) until then.
 */
export const MANIFEST_META: AdapterMeta = {
  id: 'manifest',
  name: { en: 'Other Steam game (manifest)', es: 'Otro juego de Steam (manifiesto)' },
  // PRD §10: installed with steamcmd (docker/steam).
  runtime: 'steam',
  // PRD §7: servers installed with steamcmd need x86-64.
  arch: ['amd64'],
  flavours: [],
  // TODO(M6): from the manifest.
  ports: [],
  // TODO(M6): from the manifest; placeholders nothing relies on.
  memory: { minMb: 512, defaultMb: 2048, overheadMb: 256 },
  capabilities: [],
  // TODO(M6): from the manifest; placeholder.
  stopBudgetMs: 60_000,
};
