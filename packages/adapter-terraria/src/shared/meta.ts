import type { AdapterMeta } from '@gsp/adapter-api';

/**
 * Terraria, shared by the runtime and panel halves.
 *
 * A skeleton (M3 contract step, for M5): what the PRD settles is filled in
 * (the runtime family of vanilla Terraria, the flavours); everything about
 * how the game behaves comes from the M5 fact-finding captures (D5,
 * `fixtures/terraria/`), and every value below marked TODO is a placeholder
 * nothing relies on. The adapter is registered but not offered
 * (`packages/adapters`) until then.
 */
export const TERRARIA_META: AdapterMeta = {
  id: 'terraria',
  name: { en: 'Terraria', es: 'Terraria' },
  // PRD §10: vanilla Terraria is a self-contained server (docker/native).
  // TODO(M5): tModLoader installs with steamcmd (the steam family): a flavour may need its own runtime.
  runtime: 'native',
  // TODO(M5 fact-finding): the architectures the server builds exist for (HST-05).
  arch: ['amd64'],
  // PRD §7: vanilla, TShock and tModLoader. TODO(M5 fact-finding): each flavour's capabilities.
  flavours: [
    { id: 'vanilla', name: { en: 'Vanilla', es: 'Vanilla' } },
    { id: 'tshock', name: { en: 'TShock', es: 'TShock' } },
    { id: 'tmodloader', name: { en: 'tModLoader', es: 'tModLoader' } },
  ],
  // TODO(M5 fact-finding): the game port (PRD §7 expects TCP 7777) and TShock's REST port, as the captures show them.
  ports: [],
  // TODO(M5 fact-finding): placeholders until the server's memory use is measured.
  memory: { minMb: 512, defaultMb: 2048, overheadMb: 256 },
  capabilities: [],
  // TODO(M5 fact-finding): placeholder until a clean stop is timed.
  stopBudgetMs: 60_000,
};
