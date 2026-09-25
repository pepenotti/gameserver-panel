import type { BackupPartDecl, ResetDecl, ResetOptions, ServerCtx } from '@gsp/adapter-api';

/** What a backup is made of, relative to the data root (PZ's -cachedir). */
export const PZ_BACKUP_PARTS: BackupPartDecl[] = [
  {
    id: 'world',
    label: { en: 'World (map, players, vehicles)', es: 'Mundo (mapa, jugadores, vehículos)' },
    paths: (srv) => [`Saves/Multiplayer/${srv.gameName}`, `Saves/Multiplayer/${srv.gameName}_player`],
    // players.db, vehicles.db… are written while the game runs.
    sqlite: ['**/*.db'],
  },
  {
    id: 'accounts',
    label: { en: 'Accounts, whitelist and bans', es: 'Cuentas, lista blanca y baneos' },
    paths: (srv) => [`db/${srv.gameName}.db`],
    sqlite: ['**/*.db'],
  },
  {
    id: 'configs',
    label: { en: 'Server settings', es: 'Configuración del servidor' },
    paths: (srv) => ['.ini', '_SandboxVars.lua', '_spawnregions.lua', '_spawnpoints.lua'].map((s) => `Server/${srv.gameName}${s}`),
  },
];

/** A worldgen seed in PZ's format: 16 letters. */
export function randomSeed(): string {
  const a = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ';
  return Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => a[b % a.length]).join('');
}

/** A new ResetID tells returning players' games this is a fresh world. */
export function randomResetId(): string {
  return String(100_000_000 + (crypto.getRandomValues(new Uint32Array(1))[0]! % 900_000_000));
}

/** After the world (and maybe the accounts) is gone: new ResetID, maybe a new seed and a preset. */
function newWorld(scope: string) {
  return async (ctx: ServerCtx, o: ResetOptions): Promise<void> => {
    const changes: Record<string, string> = { ResetID: randomResetId() };
    if (o.newSeed) changes.Seed = randomSeed();
    // The history names ctx.actor, who asked for the reset.
    await ctx.config.set('ini', changes, `reset (${scope})`);
    if (o.preset) await ctx.config.applyPreset(o.preset);
  };
}

/**
 * Every reset first takes a backup (the panel does), so each can be undone.
 *   world   — new world; accounts, whitelist, bans, settings and mods stay
 *   full    — also wipes accounts, whitelist and bans (the admin is recreated at start)
 *   factory — also deletes the settings files; a first-run ini is written
 */
export const PZ_RESETS: ResetDecl[] = [
  {
    id: 'world',
    label: { en: 'New world', es: 'Mundo nuevo' },
    permission: 'reset.world',
    removeParts: ['world'],
    options: { newSeed: true, preset: true },
    after: newWorld('world'),
  },
  {
    id: 'full',
    label: { en: 'New world and accounts', es: 'Mundo y cuentas nuevos' },
    permission: 'reset.full',
    removeParts: ['world', 'accounts'],
    options: { newSeed: true, preset: true },
    after: newWorld('full'),
  },
  {
    id: 'factory',
    label: { en: 'Factory reset', es: 'Restablecer de fábrica' },
    permission: 'reset.factory',
    removeParts: ['world', 'accounts', 'configs'],
    after: async (ctx) => {
      await ctx.config.seedIfMissing();
    },
  },
];

/** Before every start: a brand-new server gets the first-run settings (PZ fills in the rest). */
export async function pzBeforeStart(ctx: ServerCtx): Promise<void> {
  await ctx.config.seedIfMissing();
}
