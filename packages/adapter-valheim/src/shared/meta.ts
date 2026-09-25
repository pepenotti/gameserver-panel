import type { AdapterMeta } from '@gsp/adapter-api';

/**
 * Valheim, shared by the runtime and panel halves.
 *
 * A skeleton (M3 contract step, for M6): what the PRD settles is filled in
 * (installed with steamcmd, so the steam family and x86-64 only); everything
 * about how the game behaves comes from the M6 fact-finding captures (D5,
 * `fixtures/valheim/`), and every value below marked TODO is a placeholder
 * nothing relies on. The adapter is registered but not offered
 * (`packages/adapters`) until then. M6 may turn it into the Steam manifest
 * plus hooks (`adapter-manifest`).
 */
export const VALHEIM_META: AdapterMeta = {
  id: 'valheim',
  name: { en: 'Valheim', es: 'Valheim' },
  // PRD §10: installed with steamcmd (docker/steam).
  runtime: 'steam',
  // PRD §7: servers installed with steamcmd need x86-64.
  arch: ['amd64'],
  flavours: [],
  // TODO(M6 fact-finding): the game ports (PRD §7 expects UDP 2456–2457), as the captures show them.
  ports: [],
  // TODO(M6 fact-finding): placeholders until the server's memory use is measured.
  memory: { minMb: 1024, defaultMb: 4096, overheadMb: 512 },
  capabilities: [],
  // TODO(M6 fact-finding): placeholder until a clean stop (a signal, then the world save) is timed.
  stopBudgetMs: 60_000,
};
