/**
 * What a Terraria backup is made of (BAK-01…03) and what a reset deletes
 * (BAK-04), relative to the data root, as measured
 * (docs/verification/terraria-1.4.5.8.md, "Saving and backups"): the world
 * file (`Worlds/<world>.wld`, and tModLoader's `.twld` next to it) without
 * the game's own `.bak` and `.bak2`; the settings; TShock's database
 * (accounts, bans, server-side characters), copied through SQLite while the
 * game runs. Left out on purpose: tModLoader's own world zips
 * (`Worlds/Backups`), the Workshop cache (`.workshop`, downloaded again),
 * logs (`tshock/logs`, `ServerLog.txt`), crash reports, TShock's own
 * backups, the game's `favorites.json`.
 *
 * The world is named after the server (`ServerRef.gameName`), which is
 * fixed once it exists.
 */
import { randomInt } from 'node:crypto';
import type { BackupPartDecl, ResetDecl, ResetOptions, ServerCtx, ServerRef } from '@gsp/adapter-api';
import { DATA } from '../shared/install';

const world = (srv: ServerRef) => `${DATA.worlds}/${srv.gameName}`;

/** TShock's settings files (its config, server-side characters, messages, whitelist) and the lock that keeps its setup code away. */
const TSHOCK_SETTINGS = [DATA.tshockConfig, 'tshock/sscconfig.json', 'tshock/motd.txt', 'tshock/rules.txt', 'tshock/whitelist.txt', DATA.tshockSetupLock];

export const TERRARIA_BACKUP_PARTS: BackupPartDecl[] = [
  {
    id: 'world',
    label: { en: 'World (everything built, chests, NPCs)', es: 'Mundo (todo lo construido, cofres, NPC)' },
    paths: (srv) => [`${world(srv)}.wld`, ...(srv.flavour === 'tmodloader' ? [`${world(srv)}.twld`] : [])],
  },
  {
    id: 'settings',
    label: { en: 'Settings and bans', es: 'Configuración y baneos' },
    paths: (srv) => [DATA.serverConfig, DATA.banlist, ...(srv.flavour === 'tshock' ? TSHOCK_SETTINGS : []), ...(srv.flavour === 'tmodloader' ? [DATA.tmlEnabled] : [])],
  },
  {
    id: 'database',
    label: { en: 'TShock database (accounts, bans, server-side characters)', es: 'Base de datos de TShock (cuentas, baneos, personajes en el servidor)' },
    paths: (srv) => (srv.flavour === 'tshock' ? [DATA.tshockDb] : []),
    sqlite: [DATA.tshockDb],
  },
];

/**
 * A new world's seed: a fresh random one when asked (the form of the seeds
 * the game picks itself, measured: `Seed: 1749852911`), else the one set
 * stays (none set: the game picks one).
 */
async function newWorld(ctx: ServerCtx, o: ResetOptions): Promise<void> {
  if (o.newSeed) await ctx.config.set('serverconfig', { seed: String(randomInt(1, 2 ** 31 - 1)) }, 'reset (world): a new random seed');
}

/**
 * Every reset first takes a backup (the panel does), so each can be undone
 * (BAK-04). Players' characters live in their own games, not on the server,
 * except TShock's accounts and server-side characters.
 *   world   — a new world at the next start; settings and bans stay
 *   players — TShock: a new world, and its database (accounts, bans,
 *             server-side characters, regions) starts over
 *   factory — everything: the next start writes the panel's settings and
 *             the game's defaults again
 */
export const TERRARIA_RESETS: ResetDecl[] = [
  {
    id: 'world',
    label: { en: 'New world', es: 'Mundo nuevo' },
    permission: 'reset.world',
    removeParts: ['world'],
    options: { newSeed: true },
    after: newWorld,
  },
  {
    id: 'players',
    label: { en: 'New world and TShock’s accounts, bans and characters', es: 'Mundo nuevo y cuentas, baneos y personajes de TShock' },
    permission: 'reset.full',
    flavours: ['tshock'],
    removeParts: ['world', 'database'],
    options: { newSeed: true },
    after: newWorld,
  },
  {
    id: 'factory',
    label: { en: 'Factory reset', es: 'Restablecer de fábrica' },
    permission: 'reset.factory',
    removeParts: ['world', 'settings', 'database'],
  },
];
