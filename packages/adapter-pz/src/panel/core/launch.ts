import type { OptionMeta, SecretBag, ServerRef } from '@gsp/adapter-api';
import type { LaunchParams } from '@gsp/shared';

/** The launch settings the panel stores (the settings row `launch`). */
export interface PzLaunchSettings {
  /** Java heap (-Xms and -Xmx), MiB. */
  memoryMb: number;
  /** Steam branch of app 380870. */
  branch: string;
  /** steamcmd app_update before every start. */
  updateOnStart: boolean;
}

export const PZ_LAUNCH_DEFAULTS: Readonly<PzLaunchSettings> = { memoryMb: 8192, branch: 'public', updateOnStart: true };

const MEMORY = { min: 2048, max: 32768, step: 512 };
const BRANCH = /^[A-Za-z0-9._-]{1,64}$/;

export const PZ_LAUNCH_SCHEMA: OptionMeta[] = [
  {
    key: 'memoryMb',
    type: 'integer',
    min: MEMORY.min,
    max: MEMORY.max,
    default: String(PZ_LAUNCH_DEFAULTS.memoryMb),
    description: {
      en: `Java heap for the game, in MiB (a multiple of ${MEMORY.step}). The container needs about 3 GB more.`,
      es: `Memoria de Java para el juego, en MiB (múltiplo de ${MEMORY.step}). El contenedor necesita unos 3 GB más.`,
    },
  },
  {
    key: 'branch',
    type: 'string',
    default: PZ_LAUNCH_DEFAULTS.branch,
    description: {
      en: 'Steam branch to install and run (public, unstable, legacy41, a pinned build…).',
      es: 'Rama de Steam que se instala y ejecuta (public, unstable, legacy41, una versión fija…).',
    },
  },
  {
    key: 'updateOnStart',
    type: 'boolean',
    default: String(PZ_LAUNCH_DEFAULTS.updateOnStart),
    description: {
      en: 'Check for a game update with steamcmd before every start.',
      es: 'Buscar una actualización del juego con steamcmd antes de cada inicio.',
    },
  },
];

/** Stored or submitted launch settings, over the defaults; throws on values the server can't run with. */
export function parsePzLaunchSettings(input: unknown): PzLaunchSettings {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) throw new Error('Launch settings must be an object');
  const s = { ...PZ_LAUNCH_DEFAULTS, ...(input as Partial<PzLaunchSettings>) };
  if (!Number.isInteger(s.memoryMb) || s.memoryMb < MEMORY.min || s.memoryMb > MEMORY.max || s.memoryMb % MEMORY.step !== 0) {
    throw new Error(`memoryMb must be a multiple of ${MEMORY.step} between ${MEMORY.min} and ${MEMORY.max}`);
  }
  if (typeof s.branch !== 'string' || !BRANCH.test(s.branch)) throw new Error('branch must be 1-64 letters, digits, dots, dashes or underscores');
  if (typeof s.updateOnStart !== 'boolean') throw new Error('updateOnStart must be true or false');
  return { memoryMb: s.memoryMb, branch: s.branch, updateOnStart: s.updateOnStart };
}

/**
 * Optional fourth argument of `toAgent` the panel passes until the contract
 * has it (M1-B contract request): the start follows an install the panel just
 * ran, so the pre-start update would only repeat it.
 */
export interface LaunchHints {
  afterInstall?: boolean;
}

/** Secrets the panel holds for a Project Zomboid server (`SecretBag` keys). */
export const PZ_SECRET_ADMIN_PASSWORD = 'adminPassword';

export function pzToAgent(srv: ServerRef, s: PzLaunchSettings, secrets: SecretBag, hints: LaunchHints = {}): LaunchParams {
  const v = parsePzLaunchSettings(s);
  const adminPassword = secrets[PZ_SECRET_ADMIN_PASSWORD];
  if (!adminPassword) throw new Error('The server admin password is not set');
  return {
    serverName: srv.gameName,
    adminUsername: 'admin',
    adminPassword,
    memoryMb: v.memoryMb,
    branch: v.branch,
    updateOnStart: hints.afterInstall ? false : v.updateOnStart,
  };
}
