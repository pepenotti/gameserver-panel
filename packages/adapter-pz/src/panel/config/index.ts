/**
 * Project Zomboid, config files: the server ini, SandboxVars.lua and the
 * spawn files, their schemas, managed keys and presets (CFG-01…10).
 * Paths and behaviour measured on 42.20.4 (docs/verification/pz-b42.md).
 */
import type { AfterWriteResult, ConfigFileDecl, EditableRoot, OptionMeta, PanelAdapterConfig, Scalar, ServerCtx, ServerRef } from '@gsp/adapter-api';
import { flattenScalars, parseLuaData } from '@gsp/formats';
import { parseLogLine, PZ_PATTERNS } from '../../shared/log';
import metaJson from './option-meta.json';

/** Settings metadata generated from the game's own files (scripts/gen-option-meta.ts). */
export const PZ_OPTION_META = metaJson as { source: string; ini: OptionMeta[]; sandbox: OptionMeta[] };

/** Owned by the agent (ports, RCON, UPnP) or the mod manager (mod lists, map order): never edited by hand. */
export const MANAGED_INI = ['RCONPort', 'RCONPassword', 'DefaultPort', 'UDPPort', 'UPnP', 'Mods', 'WorkshopItems', 'Map'];

/** Shown masked in forms, raw text and history. */
export const SECRET_INI = ['RCONPassword', 'Password', 'DiscordToken'];

/**
 * Options that only take effect after a restart. `reloadoptions` re-reads the
 * file (verified on 42.20.4), but these are read once at boot or announced to
 * Steam. Everything else is live.
 */
export const RESTART_ONLY_INI = [
  'Public',
  'PublicName',
  'PublicDescription',
  'MaxPlayers',
  'Open',
  'Seed',
  'ResetID',
  'SteamVAC',
  'SteamScoreboard',
  'DoLuaChecksum',
  'DenyLoginOnOverloadedServer',
  'LoginQueueEnabled',
  'LoginQueueConnectTimeout',
  'server_browser_announced_ip',
  'VoiceEnable',
  'Voice3D',
  'VoiceMinDistance',
  'VoiceMaxDistance',
  'ServerPlayerID',
  'SaveWorldEveryMinutes',
];

/** Seeded into a brand-new ini before the first start; PZ completes a partial ini with its defaults. */
export const FIRST_RUN_INI: Record<string, Scalar> = {
  // PZ's default (0) saves only on shutdown; a crash would lose the session.
  SaveWorldEveryMinutes: '10',
};

/** Where the dedicated server keeps its sandbox presets (`<name>.lua`, `return { … }`). */
const PRESET_DIR = 'media/lua/shared/Sandbox';
const PRESET_NAME = /^[A-Za-z0-9_-]+$/;
const MAX_PRESET_BYTES = 1024 * 1024;

/** Time the game gets to re-read the ini and log the values it rejected, before the panel reports back. */
export const RELOAD_SETTLE_MS = 1500;

function files(srv: ServerRef): ConfigFileDecl[] {
  const base = `Server/${srv.gameName}`;
  return [
    {
      id: 'ini',
      root: 'data',
      rel: `${base}.ini`,
      format: 'ini',
      schemaId: 'ini',
      managedKeys: MANAGED_INI,
      secretKeys: SECRET_INI,
      restartKeys: RESTART_ONLY_INI,
      seed: FIRST_RUN_INI,
    },
    // The game reads these three at boot and executes them, so they must be plain data (CFG-02).
    {
      id: 'sandbox',
      root: 'data',
      rel: `${base}_SandboxVars.lua`,
      format: 'lua-data',
      schemaId: 'sandbox',
      managedKeys: [],
      secretKeys: [],
      restartKeys: '*',
      dataOnly: { form: 'assign', name: 'SandboxVars' },
    },
    { id: 'spawnregions', root: 'data', rel: `${base}_spawnregions.lua`, format: 'lua-data', managedKeys: [], secretKeys: [], restartKeys: '*', dataOnly: { form: 'function', name: 'SpawnRegions' } },
    { id: 'spawnpoints', root: 'data', rel: `${base}_spawnpoints.lua`, format: 'lua-data', managedKeys: [], secretKeys: [], restartKeys: '*', dataOnly: { form: 'function', name: 'SpawnPoints' } },
  ];
}

function roots(srv: ServerRef): EditableRoot[] {
  return [
    {
      id: 'server',
      root: 'data',
      rel: 'Server',
      // Only this server's files: the folder can hold other server names' files too.
      include: [`${srv.gameName}.ini`, `${srv.gameName}_*`],
      exclude: [],
      label: { en: 'Server settings', es: 'Ajustes del servidor' },
    },
    {
      // Server-side mods keep their settings where the game's Lua file API writes (`getFileWriter`).
      id: 'mods',
      root: 'data',
      rel: 'Lua',
      include: ['**/*.ini', '**/*.txt', '**/*.json', '**/*.cfg'],
      exclude: [],
      label: { en: 'Mod settings', es: 'Ajustes de mods' },
    },
  ];
}

/** Ask a running server to re-read the ini, and collect the options it rejected from its log. */
async function afterWrite(ctx: ServerCtx, fileId: string): Promise<AfterWriteResult> {
  // SandboxVars and the spawn files are read once, at boot.
  if (fileId !== 'ini') return { applied: 'restart', warnings: [] };
  const warnings: string[] = [];
  const off = ctx.onLog((line) => {
    const { message } = parseLogLine(line);
    const m = PZ_PATTERNS.optionParseError.exec(message) ?? PZ_PATTERNS.optionRangeError.exec(message);
    if (m) warnings.push(`${m[1]}: ${m[2]}`);
  });
  try {
    await ctx.command({ command: 'reloadoptions', via: 'rcon' });
    await new Promise((r) => setTimeout(r, RELOAD_SETTLE_MS));
  } finally {
    off();
  }
  return { applied: 'live', warnings };
}

async function listPresets(ctx: ServerCtx): Promise<string[]> {
  const entries = await ctx.files.list('install', PRESET_DIR);
  return entries
    .filter((e) => e.kind === 'file' && e.name.endsWith('.lua'))
    .map((e) => e.name.slice(0, -4))
    .filter((n) => PRESET_NAME.test(n) && n !== 'SandboxVars')
    .sort();
}

/** A preset's options; `VERSION` is the file format's, not a setting. */
async function loadPreset(ctx: ServerCtx, name: string): Promise<Record<string, Scalar>> {
  if (!PRESET_NAME.test(name) || !(await listPresets(ctx)).includes(name)) throw new Error(`Unknown preset ${name}`);
  const buf = await ctx.files.read('install', `${PRESET_DIR}/${name}.lua`, { maxBytes: MAX_PRESET_BYTES });
  if (!buf) throw new Error(`Unknown preset ${name}`);
  const out: Record<string, Scalar> = {};
  for (const s of flattenScalars(parseLuaData(buf.toString('utf8')).table)) {
    if (s.path !== 'VERSION' && s.value.type !== 'nil') out[s.path] = s.value.value;
  }
  return out;
}

export const pzPanelConfig: PanelAdapterConfig = {
  files,
  roots,
  schemas: { ini: PZ_OPTION_META.ini, sandbox: PZ_OPTION_META.sandbox },
  // The agent writes the ports and the RCON password before every start; the panel only pins UPnP off.
  managedValues: () => ({ ini: { UPnP: 'false' } }),
  afterWrite,
  presets: { list: listPresets, load: loadPreset },
};
