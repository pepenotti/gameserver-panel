/**
 * Project Zomboid, panel side without the config files: launch settings,
 * backup parts, resets, in-game messages, players, Workshop mods, updates.
 */
import type { PanelAdapterCore } from '@gsp/adapter-api';
import { todo } from '../../shared/todo';

/** The launch settings the panel stores (today's `settings.launch`). */
export interface PzLaunchSettings {
  /** Java heap (-Xms and -Xmx), MiB. */
  memoryMb: number;
  /** Steam branch. */
  branch: string;
  /** steamcmd app_update before every start. */
  updateOnStart: boolean;
}

// ---- TODO(M1-B) -------------------------------------------------------------
// Port from packages/panel/src: control/control.ts (launchParams, announcements,
// servermsg), backups/service.ts (partPaths) and backups/flows.ts (reset scopes,
// ResetID/Seed), players/service.ts (commands, accounts and bans from
// db/<name>.db), mods/{service,scan,steam}.ts (Workshop source), and the
// update check in scheduler/scheduler.ts and routes/server.ts. Data members
// are left empty until then; nothing calls the functions yet.
export const pzPanelCore: PanelAdapterCore<PzLaunchSettings> = {
  launch: {
    schema: [],
    defaults: () => todo('M1-B', 'launch.defaults'),
    toAgent: () => todo('M1-B', 'launch.toAgent'),
  },
  backups: { parts: [] },
  resets: [],
  messages: {
    announce: () => todo('M1-B', 'messages.announce'),
    broadcast: () => todo('M1-B', 'messages.broadcast'),
  },
  players: {
    accessLevels: [],
    kick: () => todo('M1-B', 'players.kick'),
    ban: () => todo('M1-B', 'players.ban'),
    unban: () => todo('M1-B', 'players.unban'),
    setAccess: () => todo('M1-B', 'players.setAccess'),
    whitelistAdd: () => todo('M1-B', 'players.whitelistAdd'),
    whitelistRemove: () => todo('M1-B', 'players.whitelistRemove'),
    accounts: () => todo('M1-B', 'players.accounts'),
    bans: () => todo('M1-B', 'players.bans'),
  },
  mods: [
    {
      id: 'workshop',
      capability: 'mods:workshop',
      label: { en: 'Steam Workshop', es: 'Steam Workshop' },
      parseRef: () => todo('M1-B', 'mods.parseRef'),
      expand: () => todo('M1-B', 'mods.expand'),
      details: () => todo('M1-B', 'mods.details'),
      download: () => todo('M1-B', 'mods.download'),
      scan: () => todo('M1-B', 'mods.scan'),
      toConfig: () => todo('M1-B', 'mods.toConfig'),
      fromConfig: () => todo('M1-B', 'mods.fromConfig'),
    },
  ],
  updates: { check: () => todo('M1-B', 'updates.check') },
  consoleCatalog: [],
};
// ---- end TODO(M1-B) ---------------------------------------------------------
