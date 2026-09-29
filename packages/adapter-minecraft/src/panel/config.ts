/**
 * Minecraft's config files (CFG-01…10), as measured on 26.3
 * (docs/verification/minecraft-26.3.md, "Config"):
 *   - `server.properties`: a settings form; the keys the agent writes before
 *     every start are locked (CFG-04); every key takes effect at the next
 *     start (nothing re-reads the file while the game runs);
 *   - `eula.txt`: the owner's acceptance in the panel owns it (D6);
 *   - `whitelist.json`: re-read live with `whitelist reload`;
 *   - `ops.json` and the ban lists: the running game writes them back from
 *     memory, so they are edited only while it is stopped;
 *   - Paper's own YAML files, per-dimension world settings and plugin
 *     configs; Fabric mods' configs, by extension, in the text editor.
 */
import type { AfterWriteResult, ConfigFileDecl, EditableRoot, OptionMeta, PanelAdapterConfig, Scalar, ServerCtx, ServerRef } from '@gsp/adapter-api';
import { BSTATS_FILE, LEVEL_NAME, MANAGED_PROPERTIES } from '../shared/install';
import { MC_PATTERNS, parseLogLine } from '../shared/log';
import { listCheck } from './lists';
import { PROPERTIES_GROUPS, PROPERTIES_SCHEMA, PROPERTIES_SECRETS } from './properties';

/** Paper's bStats settings (Q10: off for new servers; the owner may turn it on here). */
export const BSTATS_SCHEMA: OptionMeta[] = [
  {
    key: 'enabled',
    type: 'boolean',
    label: { en: 'Send usage statistics', es: 'Enviar estadísticas de uso' },
    description: {
      en: 'Paper and its plugins send anonymous usage statistics to bStats.org. The panel turns it off for new servers.',
      es: 'Paper y sus plugins envían estadísticas de uso anónimas a bStats.org. El panel lo apaga en los servidores nuevos.',
    },
  },
  {
    key: 'logFailedRequests',
    type: 'boolean',
    label: { en: 'Log failed sends', es: 'Registrar envíos fallidos' },
    description: { en: 'Writes to the log when statistics could not be sent.', es: 'Escribe en el registro cuando no se pudieron enviar las estadísticas.' },
  },
  {
    key: 'serverUuid',
    type: 'string',
    label: { en: 'Server id for statistics', es: 'Id del servidor para estadísticas' },
    description: { en: 'A random id bStats counts this server by; Paper writes it.', es: 'Un id al azar con el que bStats cuenta este servidor; lo escribe Paper.' },
    advanced: true,
  },
];

const ALL = '*' as const;

function files(srv: ServerRef): ConfigFileDecl[] {
  const list: ConfigFileDecl[] = [
    {
      id: 'properties',
      label: { en: 'Server settings (server.properties)', es: 'Configuración del servidor (server.properties)' },
      root: 'data',
      rel: 'server.properties',
      format: 'properties',
      schemaId: 'properties',
      managedKeys: [...MANAGED_PROPERTIES],
      secretKeys: PROPERTIES_SECRETS,
      restartKeys: ALL,
    },
    {
      id: 'eula',
      label: { en: 'License acceptance (eula.txt)', es: 'Aceptación de la licencia (eula.txt)' },
      root: 'data',
      rel: 'eula.txt',
      format: 'properties',
      // D6: only the owner's acceptance in the panel sets it, through the agent.
      managedKeys: ['eula'],
      secretKeys: [],
      restartKeys: ALL,
    },
    // The game's lists: JSON arrays of the objects it writes, never bare names (CFG-02, see ./lists).
    { id: 'whitelist', label: { en: 'Whitelist', es: 'Lista blanca' }, root: 'data', rel: 'whitelist.json', format: 'json', managedKeys: [], secretKeys: [], restartKeys: [], check: listCheck('whitelist') },
    { id: 'ops', label: { en: 'Operators', es: 'Operadores' }, root: 'data', rel: 'ops.json', format: 'json', managedKeys: [], secretKeys: [], restartKeys: ALL, stoppedOnly: true, check: listCheck('ops') },
    {
      id: 'banned-players',
      label: { en: 'Banned players', es: 'Jugadores baneados' },
      root: 'data',
      rel: 'banned-players.json',
      format: 'json',
      managedKeys: [],
      secretKeys: [],
      restartKeys: ALL,
      stoppedOnly: true,
      check: listCheck('banned-players'),
    },
    {
      id: 'banned-ips',
      label: { en: 'Banned addresses', es: 'Direcciones baneadas' },
      root: 'data',
      rel: 'banned-ips.json',
      format: 'json',
      managedKeys: [],
      secretKeys: [],
      restartKeys: ALL,
      stoppedOnly: true,
      check: listCheck('banned-ips'),
    },
  ];
  if (srv.flavour === 'paper') {
    const yaml = (id: string, rel: string, en: string, es: string, secretKeys: string[] = []): ConfigFileDecl => ({ id, label: { en, es }, root: 'data', rel, format: 'yaml', managedKeys: [], secretKeys, restartKeys: ALL });
    list.push(
      yaml('bukkit', 'bukkit.yml', 'Bukkit settings (bukkit.yml)', 'Ajustes de Bukkit (bukkit.yml)'),
      yaml('spigot', 'spigot.yml', 'Spigot settings (spigot.yml)', 'Ajustes de Spigot (spigot.yml)'),
      yaml('commands', 'commands.yml', 'Command aliases (commands.yml)', 'Alias de comandos (commands.yml)'),
      // The forwarding secret shared with a Velocity proxy.
      yaml('paper-global', 'config/paper-global.yml', 'Paper, whole server (paper-global.yml)', 'Paper, todo el servidor (paper-global.yml)', ['proxies.velocity.secret']),
      yaml('paper-world-defaults', 'config/paper-world-defaults.yml', 'Paper, every world (paper-world-defaults.yml)', 'Paper, todos los mundos (paper-world-defaults.yml)'),
      { ...yaml('bstats', BSTATS_FILE, 'Usage statistics (bStats)', 'Estadísticas de uso (bStats)'), schemaId: 'bstats' },
    );
  }
  return list;
}

/** Text files mods and plugins keep their settings in; jars and native libraries are never editable anyway (CFG-08). */
const TEXT = ['json', 'json5', 'toml', 'properties', 'yml', 'yaml', 'txt', 'cfg', 'conf', 'ini'].map((ext) => `**/*.${ext}`);

function roots(srv: ServerRef): EditableRoot[] {
  const out: EditableRoot[] = [
    {
      id: 'server',
      root: 'data',
      rel: '',
      // The server's own files, top level only: `usercache.json` is a cache the game rewrites, never an input.
      include: ['server.properties', 'whitelist.json', 'ops.json', 'banned-players.json', 'banned-ips.json', ...(srv.flavour === 'paper' ? ['*.yml'] : [])],
      exclude: ['usercache.json'],
      label: { en: 'Server settings', es: 'Ajustes del servidor' },
    },
    { id: 'config', root: 'data', rel: 'config', include: TEXT, exclude: [], label: { en: srv.flavour === 'fabric' ? 'Mod settings' : 'Settings folder', es: srv.flavour === 'fabric' ? 'Ajustes de mods' : 'Carpeta de ajustes' } },
  ];
  if (srv.flavour === 'paper') {
    out.push(
      { id: 'plugins', root: 'data', rel: 'plugins', include: TEXT, exclude: [], label: { en: 'Plugin settings', es: 'Ajustes de plugins' } },
      {
        // Measured on 26.x: every dimension lives in world/dimensions/<namespace>/<name>/, with Paper's paper-world.yml there.
        id: 'world-config',
        root: 'data',
        rel: `${LEVEL_NAME}/dimensions`,
        include: ['*/*/paper-world.yml'],
        exclude: ['*/*/region', '*/*/entities', '*/*/poi', '*/*/data'],
        label: { en: 'Paper, each dimension', es: 'Paper, cada dimensión' },
      },
    );
  }
  return out;
}

/** How long the log gets, after `whitelist reload` answered, to say the game couldn't read the file. */
export const RELOAD_SETTLE_MS = 1000;

/**
 * The whitelist is re-read live (measured: `whitelist reload` takes the
 * file); everything else waits for a start. A whitelist the game can't read
 * leaves it with an empty one: its log says so (a WARN, and the exception's
 * message on the next line), and that comes back as a warning.
 */
async function afterWrite(ctx: ServerCtx, fileId: string): Promise<AfterWriteResult> {
  if (fileId !== 'whitelist') return { applied: 'restart', warnings: [] };
  const warnings: string[] = [];
  /** A failure line whose next line may carry the exception's message. */
  const failed: { line: string | null } = { line: null };
  const off = ctx.onLog((raw) => {
    const line = parseLogLine(raw);
    if (failed.line !== null) {
      // The exception's message, printed without the game's header.
      warnings.push((line.header ? failed.line : `${failed.line} ${line.message.trim()}`).slice(0, 300));
      failed.line = null;
    }
    if (line.header && MC_PATTERNS.whitelistLoadFailed.test(line.message)) failed.line = line.message.trim();
  });
  try {
    const r = await ctx.command({ command: 'whitelist reload', via: 'rcon' });
    const out = (r.output ?? '').trim();
    if (r.output !== null && !/^Reloaded the whitelist$/.test(out)) warnings.push(out.slice(0, 300));
    await new Promise((resolve) => setTimeout(resolve, RELOAD_SETTLE_MS));
  } finally {
    off();
  }
  if (failed.line !== null) warnings.push(failed.line.slice(0, 300));
  return { applied: 'live', warnings };
}

/** Game-mode and difficulty presets for `server.properties` (CFG-06): a new world's rules at one click. */
export const MINECRAFT_PRESETS: Record<string, Record<string, Scalar>> = {
  creative: { gamemode: 'creative', difficulty: 'peaceful', hardcore: 'false' },
  'survival-easy': { gamemode: 'survival', difficulty: 'easy', hardcore: 'false' },
  'survival-normal': { gamemode: 'survival', difficulty: 'normal', hardcore: 'false' },
  'survival-hard': { gamemode: 'survival', difficulty: 'hard', hardcore: 'false' },
  hardcore: { gamemode: 'survival', difficulty: 'hard', hardcore: 'true' },
};

/** Values the panel pins for managed keys; the ports and the RCON password are the agent's, from where it runs. */
export function minecraftManagedValues(): Record<string, Record<string, string>> {
  return { properties: { 'server-ip': '', 'enable-rcon': 'true', 'enable-query': 'false', 'management-server-enabled': 'false', 'level-name': LEVEL_NAME } };
}

export const minecraftPanelConfig: PanelAdapterConfig = {
  files,
  roots,
  schemas: { properties: PROPERTIES_SCHEMA, bstats: BSTATS_SCHEMA },
  groups: { properties: PROPERTIES_GROUPS },
  managedValues: minecraftManagedValues,
  afterWrite,
  presets: {
    fileId: 'properties',
    list: async () => Object.keys(MINECRAFT_PRESETS),
    load: async (_ctx, name) => {
      const p = Object.hasOwn(MINECRAFT_PRESETS, name) ? MINECRAFT_PRESETS[name] : undefined;
      if (!p) throw new Error(`Unknown preset ${name}`);
      return { ...p };
    },
  },
};
