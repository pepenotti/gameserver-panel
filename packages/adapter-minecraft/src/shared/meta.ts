import type { AdapterMeta } from '@gsp/adapter-api';

/**
 * Minecraft: Java Edition, shared by the runtime and panel halves.
 *
 * A skeleton (M3 contract step): what the PRD settles is filled in (the
 * runtime family, the architectures, the loaders picked per server, the
 * EULA); everything about how the game behaves comes from the M3
 * fact-finding captures (D5, `fixtures/minecraft/`), and every value below
 * marked TODO is a placeholder nothing relies on. The adapter is registered
 * but not offered (`packages/adapters`) until then.
 */
export const MINECRAFT_META: AdapterMeta = {
  id: 'minecraft',
  name: { en: 'Minecraft: Java Edition', es: 'Minecraft: Java Edition' },
  // PRD §10: a JRE matched to the Minecraft version (docker/java).
  runtime: 'java',
  // PRD §7: x86-64 and ARM64 hosts; confirmed in M3 (HST-05).
  arch: ['amd64', 'arm64'],
  // PRD §7, D6, UPD-06: the loader is picked per server. Forge and NeoForge come in M4 (UPD-07).
  // TODO(M3 fact-finding): each flavour's own capabilities, once measured.
  flavours: [
    { id: 'vanilla', name: { en: 'Vanilla', es: 'Vanilla' } },
    { id: 'paper', name: { en: 'Paper', es: 'Paper' } },
    { id: 'fabric', name: { en: 'Fabric', es: 'Fabric' } },
  ],
  // TODO(M3 fact-finding): the game port (PRD §7 expects TCP 25565) and RCON's, as the captures show them.
  ports: [],
  // TODO(M3 fact-finding): placeholders until the server's memory use is measured.
  memory: { minMb: 1024, defaultMb: 2048, overheadMb: 512 },
  // D6: the owner accepts the EULA explicitly. The other capabilities come with the M3 adapter.
  capabilities: ['eula'],
  // TODO(M3 fact-finding): placeholder until a clean stop of a big world is timed.
  stopBudgetMs: 60_000,
  eula: {
    name: { en: 'Minecraft End User License Agreement (EULA)', es: 'Contrato de licencia de usuario final (EULA) de Minecraft' },
    // TODO(M3 fact-finding): confirm against the link the server's own EULA file gives.
    url: 'https://aka.ms/MinecraftEULA',
  },
};
