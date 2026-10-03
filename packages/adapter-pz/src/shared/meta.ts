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
  // SRV-08: players type the game port (UDP 16261 by default); the game also uses the next one, which is
  // forwarded with it. The join password and whether accounts must exist first are the server ini's
  // `Password` and `Open` (the game's own descriptions). No client has joined a server of this panel
  // yet (docs/verification/pz-b42.md), so it is unverified.
  join: {
    port: 'game',
    format: 'separate',
    where: { en: "Join: the server's IP and Port fields", es: 'Unirse: los campos IP y Puerto del servidor' },
    client: { name: { en: 'Project Zomboid', es: 'Project Zomboid' }, sameVersion: true },
    steps: [
      {
        id: 'accounts',
        text: {
          en: 'This server lets in only the accounts an admin made: ask one for your username and password.',
          es: 'Este servidor deja entrar solo a las cuentas que creó un administrador: pedile a uno tu usuario y contraseña.',
        },
        when: { file: 'ini', key: 'Open', equals: false },
      },
    ],
    password: { file: 'ini', key: 'Password' },
    verified: true,
    source: 'The owner joined a real Project Zomboid server of this panel from Join on this PC, 2026-10-03 (docs/verification/pz-b42.md)',
  },
};
