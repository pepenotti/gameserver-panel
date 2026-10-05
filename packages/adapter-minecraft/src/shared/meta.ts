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
  // HST-09, D12: every loader runs from a read-only install (measured on 26.3 / 26.2,
  // docs/verification/shared-installs.md); vanilla and Fabric once the install job's warm-up has
  // unpacked Mojang's bundler (the runtime's `warmUp`), Paper as its install step leaves it.
  install: { mode: 'shared' },
  eula: {
    name: { en: 'Minecraft End User License Agreement (EULA)', es: 'Contrato de licencia de usuario final (EULA) de Minecraft' },
    // The link the game's own eula.txt gives.
    url: 'https://aka.ms/MinecraftEULA',
  },
  // SRV-08: how players join, the same for every loader (the client is the game's own). Measured: the
  // owner joined a real 26.3 server from Direct Connection at 127.0.0.1:<the published port>, which
  // need not be the port inside (docs/verification/minecraft-26.3.md, "Published port"); the client
  // takes the address alone on its default port, 25565.
  join: {
    port: 'game',
    format: 'host:port',
    defaultPort: 25565,
    where: { en: 'Multiplayer, then Direct Connection: the Server Address field', es: 'Multijugador, luego Conexión directa: el campo Dirección del servidor' },
    client: { name: { en: 'Minecraft: Java Edition', es: 'Minecraft: Java Edition' }, sameVersion: true },
    steps: [
      {
        id: 'whitelist',
        text: {
          en: 'The whitelist is on: only the players on it get in. Ask an admin to add your Java Edition name.',
          es: 'La lista blanca está activada: solo entran los jugadores que están en ella. Pedile a un administrador que agregue tu nombre de Java Edition.',
        },
        // 26.3 starts with it on (`white-list=true`), Paper 26.2 and 1.16.5 with it off.
        when: { file: 'properties', key: 'white-list', equals: true },
      },
    ],
    verified: true,
    source: 'M3 acceptance run, 2026-09-28: the owner joined a real 26.3 server from Direct Connection at 127.0.0.1:<published port> (docs/verification/minecraft-26.3.md)',
  },
  // HST-07: settings that act on the address a player joins from. Behind Docker Desktop every player
  // arrives from the relay's address (docs/limitations.md); what each does then is expected, not measured.
  perAddress: [
    {
      id: 'connection-throttle',
      file: 'bukkit',
      key: 'settings.connection-throttle',
      flavours: ['paper'],
      text: {
        en: 'Paper turns away a player who joins within this many milliseconds of another from the same address (4000 by default). Where every player arrives from one address, a second player joining that soon is refused; -1 turns it off.',
        es: 'Paper rechaza a un jugador que entra a menos de estos milisegundos de otro desde la misma dirección (4000 por defecto). Donde todos los jugadores llegan desde una dirección, se rechaza a un segundo jugador que entra tan pronto; -1 lo desactiva.',
      },
      doc: 'limitations.md#players-addresses-are-hidden-behind-docker-desktop',
    },
    {
      id: 'prevent-proxy-connections',
      file: 'properties',
      key: 'prevent-proxy-connections',
      text: {
        en: 'On, the game asks Mojang whether a player joins from the address they signed in from. Where players’ addresses are hidden, the game sees another address and is expected to turn everyone away: keep it off.',
        es: 'Activado, el juego le pregunta a Mojang si un jugador entra desde la dirección con la que inició sesión. Donde las direcciones de los jugadores quedan ocultas, el juego ve otra dirección y se espera que rechace a todos: dejalo desactivado.',
      },
      doc: 'limitations.md#players-addresses-are-hidden-behind-docker-desktop',
    },
  ],
};
