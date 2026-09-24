/**
 * Project Zomboid, agent side: steamcmd install and branches, the start
 * command, readiness from the log, RCON with stdin as fallback, save+quit.
 */
import type { RuntimeAdapter } from '@gsp/adapter-api';
import type { LaunchParams } from '@gsp/shared';
import { WORKSHOP_DOWNLOAD } from '../shared/actions';
import { PZ_META } from '../shared/meta';
import { todo } from '../shared/todo';

/** Launch params the panel sends; today's `LaunchParams`. */
export type PzLaunch = LaunchParams;

// ---- TODO(M1-A) -------------------------------------------------------------
// Port from packages/agent/src/agent.ts (validateLaunch, readInstalled,
// runInstall/appInfo, enforceIni, doStart's command line, onGameLine,
// gracefulStop, pollPlayers) and packages/agent/src/steamcmd.ts, then drop
// the `todo()` calls. Until then nothing calls this object; only its `meta`
// and shape are checked (runtime contract suite).
export const pzRuntimeAdapter: RuntimeAdapter<PzLaunch> = {
  meta: PZ_META,
  parseLaunch: () => todo('M1-A', 'parseLaunch'),
  secrets: () => todo('M1-A', 'secrets'),
  installed: () => todo('M1-A', 'installed'),
  install: () => todo('M1-A', 'install'),
  versions: () => todo('M1-A', 'versions'),
  prepare: () => todo('M1-A', 'prepare'),
  command: () => todo('M1-A', 'command'),
  classify: () => todo('M1-A', 'classify'),
  channel: () => todo('M1-A', 'channel'),
  stop: () => todo('M1-A', 'stop'),
  save: () => todo('M1-A', 'save'),
  hotCopy: {
    before: () => todo('M1-A', 'hotCopy.before'),
    after: () => todo('M1-A', 'hotCopy.after'),
    // Today every .db file in a running backup is copied as a SQLite snapshot.
    sqlite: ['**/*.db'],
  },
  listPlayers: () => todo('M1-A', 'listPlayers'),
  roots: () => todo('M1-A', 'roots'),
  actions: {
    [WORKSHOP_DOWNLOAD]: {
      job: 'workshop',
      parse: () => todo('M1-A', `actions.${WORKSHOP_DOWNLOAD}.parse`),
      run: () => todo('M1-A', `actions.${WORKSHOP_DOWNLOAD}.run`),
    },
  },
};
// ---- end TODO(M1-A) ---------------------------------------------------------
