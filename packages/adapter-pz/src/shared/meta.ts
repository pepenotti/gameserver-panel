import type { AdapterMeta } from '@gsp/adapter-api';

/**
 * Project Zomboid (Build 42), shared by the runtime and panel halves.
 * Defaults are today's: .env.example ports, the panel's launch settings and
 * the agent's stop timeout (PZ_STOP_TIMEOUT_MS).
 */
export const PZ_META: AdapterMeta = {
  id: 'pz',
  name: { en: 'Project Zomboid', es: 'Project Zomboid' },
  runtime: 'steam',
  // Installed with steamcmd, which is x86-64 only (PRD §7).
  arch: ['amd64'],
  flavours: [],
  ports: [
    { id: 'game', proto: 'udp', default: 16261, publish: true, sameInsideOut: true, label: { en: 'Game port', es: 'Puerto del juego' } },
    { id: 'udp', proto: 'udp', default: 16262, publish: true, sameInsideOut: true, label: { en: 'Direct connection port', es: 'Puerto de conexión directa' } },
    { id: 'rcon', proto: 'tcp', default: 27015, publish: false, sameInsideOut: false, label: { en: 'RCON (agent only)', es: 'RCON (solo el agente)' } },
  ],
  // The heap is at least 1 GiB (the agent's launch check); the container needs ~3 GB on top (.env.example).
  memory: { minMb: 1024, defaultMb: 8192, overheadMb: 3072 },
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
    'accounts',
    'mods:workshop',
    'settingsForms',
    'presets',
    'liveReload',
    'branches',
    'updateCheck',
  ],
  stopBudgetMs: 180_000,
};
