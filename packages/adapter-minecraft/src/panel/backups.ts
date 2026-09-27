import type { BackupPartDecl, ResetDecl, ServerCtx, ServerRef } from '@gsp/adapter-api';
import { LEVEL_NAME } from '../shared/install';

/**
 * What a backup is made of, relative to the data root (BAK-01…03), as
 * measured on 26.x: every dimension and the players' data live inside the
 * world folder on all three loaders. Left out on purpose: `eula.txt` (the
 * panel's own acceptance), `usercache.json` (a cache), `logs/`,
 * `crash-reports/`, `.paper/` and `.fabric/` (the game's own caches).
 */
export const MINECRAFT_BACKUP_PARTS: BackupPartDecl[] = [
  {
    id: 'world',
    label: { en: 'World (every dimension, players’ inventories and progress)', es: 'Mundo (todas las dimensiones, inventarios y progreso de los jugadores)' },
    paths: () => [LEVEL_NAME],
  },
  {
    id: 'config',
    label: { en: 'Settings, whitelist, operators and bans', es: 'Configuración, lista blanca, operadores y baneos' },
    paths: (srv: ServerRef) => [
      'server.properties',
      'whitelist.json',
      'ops.json',
      'banned-players.json',
      'banned-ips.json',
      ...(srv.flavour === 'paper' ? ['bukkit.yml', 'spigot.yml', 'commands.yml', 'config'] : []),
      ...(srv.flavour === 'fabric' ? ['config'] : []),
    ],
  },
  { id: 'plugins', label: { en: 'Plugins and their settings', es: 'Plugins y sus ajustes' }, paths: (srv) => (srv.flavour === 'paper' ? ['plugins'] : []) },
  { id: 'mods', label: { en: 'Mods', es: 'Mods' }, paths: (srv) => (srv.flavour === 'fabric' ? ['mods'] : []) },
];

/** A new world: a random seed unless asked to keep the one set, then a preset's rules if one was picked. */
async function newWorld(ctx: ServerCtx, o: { newSeed: boolean; preset?: string }): Promise<void> {
  // An empty seed makes the game pick one at random when it creates the world (its default).
  if (o.newSeed) await ctx.config.set('properties', { 'level-seed': '' }, 'reset (world): a new random seed');
  if (o.preset) await ctx.config.applyPreset(o.preset);
}

/**
 * Every reset first takes a backup (the panel does), so each can be undone
 * (BAK-04). On 26.x the players' inventories, positions and progress are
 * inside the world folder, so a new world resets them too.
 *   world   — a new world; settings, lists, plugins and mods stay
 *   factory — also the settings, lists, plugins and mods: the game writes
 *             its defaults at the next start; the owner's EULA acceptance stays
 */
export const MINECRAFT_RESETS: ResetDecl[] = [
  {
    id: 'world',
    label: { en: 'New world (players start over too)', es: 'Mundo nuevo (los jugadores también empiezan de cero)' },
    permission: 'reset.world',
    removeParts: ['world'],
    options: { newSeed: true, preset: true },
    after: newWorld,
  },
  {
    id: 'factory',
    label: { en: 'Factory reset', es: 'Restablecer de fábrica' },
    permission: 'reset.factory',
    removeParts: ['world', 'config', 'plugins', 'mods'],
  },
];
