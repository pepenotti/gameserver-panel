import type { AdapterMeta, Capability } from '@gsp/adapter-api';

/**
 * What every flavour can do: the runtime half's (M5 phase 2: the console on
 * stdin, saves and running backups, who is online and their history,
 * pinned versions, worlds created on the first start) and the panel half's
 * (phase 3: messages to players, kick and ban, the settings forms, update
 * checks).
 */
const COMMON: Capability[] = ['stdinConsole', 'broadcast', 'save', 'hotBackup', 'players', 'playerHistory', 'kick', 'ban', 'settingsForms', 'versionPin', 'updateCheck', 'worldCreate'];

/** tModLoader's app on the Steam Workshop: its mods' consumer app, downloadable anonymously (measured). */
export const TML_WORKSHOP_APP_ID = 1281930;

/**
 * Terraria, shared by the runtime and panel halves. Every value is measured
 * on real servers (D5, docs/verification/terraria-1.4.5.8.md): vanilla
 * 1.4.5.8, TShock 6.2.1 and tModLoader v2026.07.3.0.
 *
 * Each flavour lists its capabilities (a flavour's list replaces the
 * adapter's): the same moderation and settings for the three, since what
 * differs is how they do it (TShock bans by name, IP, UUID or account
 * through its REST API; vanilla and tModLoader ban an online player's IP on
 * the console), plus each one's mods: TShock's plugins (`mods:tshock`,
 * MOD-06) and tModLoader's Workshop mods (`mods:workshop`, MOD-03).
 * TShock's REST API is reached through the runtime's actions, not as a
 * control channel, so `restApi` (which the contract reads as a REST
 * channel) is not declared.
 */
export const TERRARIA_META: AdapterMeta = {
  id: 'terraria',
  name: { en: 'Terraria', es: 'Terraria' },
  // PRD §10: vanilla and TShock run in the native image (with .NET 9 for TShock); tModLoader needs
  // .NET 8 and steamcmd for its Workshop mods, so it runs in the steam image.
  runtime: 'native',
  // Vanilla's server is an x86-64 build only; TShock's ARM64 builds are unverified and tModLoader
  // says it doesn't support ARM (PRD §7, HST-05).
  arch: ['amd64'],
  flavours: [
    { id: 'vanilla', name: { en: 'Vanilla', es: 'Vanilla' }, capabilities: [...COMMON] },
    {
      id: 'tshock',
      name: { en: 'TShock', es: 'TShock' },
      capabilities: [...COMMON, 'mods:tshock'],
      join: {
        steps: [
          {
            id: 'tshock-account',
            // Players who never registered stay TShock's `guest` (measured over REST); `/register` with a real client isn't.
            text: {
              en: 'TShock may ask new players to make an account in game: type /register <password>, then /login <password> when it asks.',
              es: 'TShock puede pedir a los jugadores nuevos que creen una cuenta en el juego: escribí /register <contraseña> y después /login <contraseña> cuando lo pida.',
            },
          },
        ],
      },
    },
    {
      id: 'tmodloader',
      name: { en: 'tModLoader', es: 'tModLoader' },
      runtime: 'steam',
      capabilities: [...COMMON, 'mods:workshop'],
      // Its players need tModLoader, at the server's tModLoader version, with the same mods (PRD §7).
      join: {
        client: { name: { en: 'tModLoader', es: 'tModLoader' }, sameVersion: true },
        steps: [
          {
            id: 'same-mods',
            text: { en: 'Join from tModLoader, not Terraria, with the same mods as the server.', es: 'Entrá desde tModLoader, no desde Terraria, con los mismos mods que el servidor.' },
          },
        ],
      },
    },
  ],
  ports: [
    // A client joined through a different published port (30550 → 7777): the port inside need not match.
    { id: 'game', proto: 'tcp', default: 7777, publish: true, sameInsideOut: false, label: { en: 'Game port', es: 'Puerto del juego' } },
    // TShock's REST API (CON-04): only the agent talks to it, so it is never published.
    { id: 'rest', proto: 'tcp', default: 7878, publish: false, sameInsideOut: false, label: { en: 'TShock REST API (agent only)', es: 'API REST de TShock (solo el agente)' } },
  ],
  // No heap flag: the container limit is the knob. Idle, a small world took 0.53 GiB (vanilla),
  // 0.39 GiB (TShock) and up to 1 GiB (tModLoader's first boot); a large vanilla world 1.14 GiB,
  // peaking at 1.23 GiB (so large worlds need 2048, see `parseTerrariaLaunch`).
  memory: { minMb: 1024, defaultMb: 2048, overheadMb: 256 },
  capabilities: [...COMMON],
  // `exit` saved and stopped in 1–2.2 s (a large world the slowest); players and slow disks add.
  stopBudgetMs: 60_000,
  // SRV-08: the address, then the port, each asked on its own; a password set in the launch settings is
  // asked for after that (the test client was, packet 37). Only a test client joined, through a
  // published port that differed from the one inside (docs/verification/terraria-1.4.5.8.md).
  join: {
    port: 'game',
    format: 'separate',
    where: { en: 'Multiplayer, then Join via IP: the address, then the port', es: 'Multijugador, luego unirse por IP: primero la dirección, después el puerto' },
    client: { name: { en: 'Terraria', es: 'Terraria' }, sameVersion: true },
    password: { launch: 'password' },
    verified: false,
    source: 'docs/verification/terraria-1.4.5.8.md: a test client joined vanilla and TShock through a published port; joining from a real client is still to be checked',
  },
};
