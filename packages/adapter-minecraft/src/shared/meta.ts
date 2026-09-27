import type { AdapterMeta } from '@gsp/adapter-api';

/**
 * Minecraft: Java Edition, shared by the runtime and panel halves. Every
 * value is measured on real 26.3 servers (D5, docs/verification/minecraft-26.3.md).
 *
 * The capabilities: the runtime half's (M3 phase 2: RCON and the console,
 * saves and running backups, players and their history, pinned versions,
 * loaders, the EULA) and the panel half's (phase 3: broadcasts, kick, ban,
 * the whitelist, operator levels, settings forms and presets, update
 * checks). Not `liveReload`: nothing re-reads server.properties while the
 * game runs (the whitelist file is re-read on its own).
 */
export const MINECRAFT_META: AdapterMeta = {
  id: 'minecraft',
  name: { en: 'Minecraft: Java Edition', es: 'Minecraft: Java Edition' },
  // PRD §10: Temurin 25, 21 and 17, picked per server from its version (docker/java).
  runtime: 'java',
  // PRD §7: the server jars are Java with ARM64 natives; ARM64 is confirmed in M7 (HST-05).
  arch: ['amd64', 'arm64'],
  // PRD §7, D6, UPD-06: the loader is picked per server. Forge and NeoForge come in M4 (UPD-07).
  flavours: [
    { id: 'vanilla', name: { en: 'Vanilla', es: 'Vanilla' } },
    { id: 'paper', name: { en: 'Paper', es: 'Paper' } },
    { id: 'fabric', name: { en: 'Fabric', es: 'Fabric' } },
  ],
  ports: [
    // A client joined through a different published port: the game port inside need not match.
    { id: 'game', proto: 'tcp', default: 25565, publish: true, sameInsideOut: false, label: { en: 'Game port', es: 'Puerto del juego' } },
    { id: 'rcon', proto: 'tcp', default: 25575, publish: false, sameInsideOut: false, label: { en: 'RCON (agent only)', es: 'RCON (solo el agente)' } },
  ],
  // 1 GiB heaps booted every version tried; above a 2 GiB heap an idle server used 341–404 MiB
  // more (players, view distance and plugins add native memory).
  memory: { minMb: 1024, defaultMb: 2048, overheadMb: 1024 },
  capabilities: [
    'rcon',
    'stdinConsole',
    'broadcast',
    'save',
    'hotBackup',
    'players',
    'playerHistory',
    'kick',
    'ban',
    'whitelist',
    'accessLevels',
    'settingsForms',
    'presets',
    'versionPin',
    'loaders',
    'updateCheck',
    'eula',
  ],
  // A stop took 1.2–4 s on a small world; Paper allows its chunk system up to 60 s per dimension.
  stopBudgetMs: 120_000,
  eula: {
    name: { en: 'Minecraft End User License Agreement (EULA)', es: 'Contrato de licencia de usuario final (EULA) de Minecraft' },
    // The link the game's own eula.txt gives.
    url: 'https://aka.ms/MinecraftEULA',
  },
};
