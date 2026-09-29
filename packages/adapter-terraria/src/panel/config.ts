/**
 * Terraria's config files (CFG-01…10), as measured on the three flavours
 * (docs/verification/terraria-1.4.5.8.md, "Config"):
 *   - `serverconfig.txt`: key=value lines the game reads at every start and
 *     never writes; a form, the agent's keys locked (CFG-04), every key
 *     taking effect at the next start;
 *   - `banlist.txt` (vanilla and tModLoader): the game's IP bans, which it
 *     keeps in memory and only appends to, so it is changed only while the
 *     game is stopped;
 *   - TShock's `tshock/config.json`: a form over TShock's 145 settings, its
 *     REST API and the agent's token the agent's (the token object hidden
 *     whole), rewritten by TShock at every start, which drops unknown keys;
 *     and its other files;
 *   - tModLoader's mod list, and its mods' settings if the server writes any.
 * Editable folders take only text files: never worlds, databases, mods
 * (`.tmod`) or plugins (`.dll`) (CFG-08).
 */
import type { ConfigFileDecl, EditableRoot, PanelAdapterConfig, ServerRef } from '@gsp/adapter-api';
import { DATA } from '../shared/install';
import { SERVERCONFIG_GROUPS, SERVERCONFIG_MANAGED, SERVERCONFIG_SCHEMA, SERVERCONFIG_TML_MANAGED, SERVERCONFIG_TML_SCHEMA } from './serverconfig';
import { TSHOCK_GROUPS, TSHOCK_MANAGED, TSHOCK_SCHEMA, TSHOCK_SECRETS, TSHOCK_TOKEN_TREE } from './tshock';

const ALL = '*' as const;

function files(srv: ServerRef): ConfigFileDecl[] {
  const tml = srv.flavour === 'tmodloader';
  const list: ConfigFileDecl[] = [
    {
      id: 'serverconfig',
      label: { en: 'Server settings (serverconfig.txt)', es: 'Configuración del servidor (serverconfig.txt)' },
      root: 'data',
      rel: DATA.serverConfig,
      format: 'ini',
      schemaId: tml ? 'serverconfig-tml' : 'serverconfig',
      managedKeys: [...(tml ? SERVERCONFIG_TML_MANAGED : SERVERCONFIG_MANAGED)],
      secretKeys: ['password'],
      restartKeys: ALL,
      note: {
        en: 'The game reads this file when it starts and never writes it. The panel sets the port, the world, its folder, the ban list, the language, the password and the player slots itself (the password and the slots in the launch settings).',
        es: 'El juego lee este archivo al iniciar y nunca lo escribe. El panel fija por su cuenta el puerto, el mundo, su carpeta, la lista de baneos, el idioma, la contraseña y las plazas (la contraseña y las plazas en los ajustes de inicio).',
      },
    },
  ];
  if (srv.flavour === 'tshock') {
    list.push(
      {
        id: 'tshock-config',
        label: { en: 'TShock settings (tshock/config.json)', es: 'Configuración de TShock (tshock/config.json)' },
        root: 'data',
        rel: DATA.tshockConfig,
        format: 'json',
        schemaId: 'tshock',
        managedKeys: [...TSHOCK_MANAGED],
        secretKeys: [...TSHOCK_SECRETS],
        secretTrees: [TSHOCK_TOKEN_TREE],
        restartKeys: ALL,
        note: {
          en: 'TShock rewrites this file every time it starts: it keeps the settings it knows, adds the ones missing with their defaults, and drops anything it doesn’t know. The panel’s agent owns the REST API and its key, which stay hidden.',
          es: 'TShock reescribe este archivo cada vez que inicia: conserva los ajustes que conoce, agrega los que faltan con sus valores por defecto y descarta lo que no conoce. El agente del panel maneja la API REST y su clave, que se mantienen ocultas.',
        },
      },
      { id: 'tshock-ssc', label: { en: 'TShock server-side characters (sscconfig.json)', es: 'Personajes en el servidor de TShock (sscconfig.json)' }, root: 'data', rel: 'tshock/sscconfig.json', format: 'json', managedKeys: [], secretKeys: [], restartKeys: ALL },
      { id: 'tshock-motd', label: { en: 'TShock welcome message (motd.txt)', es: 'Mensaje de bienvenida de TShock (motd.txt)' }, root: 'data', rel: 'tshock/motd.txt', format: 'text', managedKeys: [], secretKeys: [], restartKeys: ALL },
      { id: 'tshock-rules', label: { en: 'TShock rules (rules.txt)', es: 'Reglas de TShock (rules.txt)' }, root: 'data', rel: 'tshock/rules.txt', format: 'text', managedKeys: [], secretKeys: [], restartKeys: ALL },
      {
        id: 'tshock-whitelist',
        label: { en: 'TShock whitelist (whitelist.txt)', es: 'Lista blanca de TShock (whitelist.txt)' },
        root: 'data',
        rel: 'tshock/whitelist.txt',
        format: 'lines',
        managedKeys: [],
        secretKeys: [],
        restartKeys: ALL,
        note: {
          en: 'One address (or range) per line, used when TShock’s whitelist is on. Behind Docker Desktop every player arrives from the same address.',
          es: 'Una dirección (o rango) por línea, usada cuando la lista blanca de TShock está activa. Detrás de Docker Desktop todos los jugadores llegan desde la misma dirección.',
        },
      },
    );
  } else {
    list.push({
      id: 'banlist',
      label: { en: 'Banned addresses (banlist.txt)', es: 'Direcciones baneadas (banlist.txt)' },
      root: 'data',
      rel: DATA.banlist,
      format: 'lines',
      managedKeys: [],
      secretKeys: [],
      restartKeys: ALL,
      // The game keeps its bans in memory and only appends to the file (measured).
      stoppedOnly: true,
      note: {
        en: 'The game’s bans: each banned address, after a //name line saying who it was. The running game keeps them in memory, so the file is changed only while the server is stopped.',
        es: 'Los baneos del juego: cada dirección baneada, después de una línea //nombre que dice quién era. El juego en marcha los guarda en memoria, así que el archivo se cambia solo con el servidor detenido.',
      },
    });
  }
  if (tml) {
    list.push({
      id: 'tml-mods',
      label: { en: 'Enabled mods (Mods/enabled.json)', es: 'Mods activados (Mods/enabled.json)' },
      root: 'data',
      rel: DATA.tmlEnabled,
      format: 'json',
      managedKeys: [],
      secretKeys: [],
      restartKeys: ALL,
      // MOD-03: the Mods page writes this list (the names of the enabled mods, in load order).
      note: {
        en: 'The Mods page writes this file whenever the enabled mods change: the names of the mods tModLoader loads, in order. Enable and disable mods there; an edit here is replaced at the next change on that page.',
        es: 'La página de Mods escribe este archivo cada vez que cambian los mods activados: los nombres de los mods que carga tModLoader, en orden. Activá y desactivá mods ahí; una edición acá se reemplaza con el próximo cambio en esa página.',
      },
    });
  }
  return list;
}

/** Text files only (CFG-08): never worlds, databases, mods, plugins or binaries. */
const TEXT = ['**/*.json', '**/*.txt'];

function roots(srv: ServerRef): EditableRoot[] {
  const out: EditableRoot[] = [
    {
      id: 'server',
      root: 'data',
      rel: '',
      include: [DATA.serverConfig, ...(srv.flavour === 'tshock' ? [] : [DATA.banlist]), ...(srv.flavour === 'tmodloader' ? [DATA.tmlEnabled] : [])],
      exclude: [],
      label: { en: 'Server settings', es: 'Ajustes del servidor' },
    },
  ];
  if (srv.flavour === 'tshock') {
    // TShock's own files and its plugins' settings; not its logs, crash reports, backups or database, nor the setup code.
    out.push({ id: 'tshock', root: 'data', rel: DATA.tshock, include: TEXT, exclude: ['logs', 'crashes', 'backups', 'setup-code.txt', 'plugins'], label: { en: 'TShock and plugin settings', es: 'Ajustes de TShock y de plugins' } });
  }
  if (srv.flavour === 'tmodloader') {
    // Where tModLoader keeps the settings of mods that have server-side ones (not seen with the mod measured).
    out.push({ id: 'mod-configs', root: 'data', rel: DATA.tmlModConfigs, include: ['**/*.json'], exclude: [], label: { en: 'Mod settings', es: 'Ajustes de mods' } });
  }
  return out;
}

/** Values the panel pins; the ports, paths and the token are the agent's, from where it runs (they keep what is on disk). */
export function terrariaManagedValues(srv: ServerRef): Record<string, Record<string, string>> {
  return {
    serverconfig: { language: 'en-US', upnp: '0' },
    ...(srv.flavour === 'tshock' ? { 'tshock-config': { 'Settings.RestApiEnabled': 'true' } } : {}),
  };
}

export const terrariaPanelConfig: PanelAdapterConfig = {
  files,
  roots,
  schemas: { serverconfig: SERVERCONFIG_SCHEMA, 'serverconfig-tml': SERVERCONFIG_TML_SCHEMA, tshock: TSHOCK_SCHEMA },
  groups: { serverconfig: SERVERCONFIG_GROUPS, 'serverconfig-tml': SERVERCONFIG_GROUPS, tshock: TSHOCK_GROUPS },
  managedValues: terrariaManagedValues,
};
