/**
 * The settings form of `serverconfig.txt` (CFG-01, CFG-10): every key the
 * game knows (docs/verification/terraria-1.4.5.8.md, "Config": the keys of
 * the sample file in the zip, tModLoader's two more), typed, grouped and
 * described in the panel's own words in English and Spanish. The game
 * reads the file at every start and never writes it; the flags the agent
 * starts it with win over the file, so the keys those flags set are locked
 * (CFG-04) and say where they are set instead. Keys the form doesn't know
 * still show up, as text (principle 2).
 *
 * Measured: `difficulty` 0 without the key (`Difficulty: 0`), 1 with
 * `difficulty=1`; `seed` takes text; a random seed without one. What each
 * setting does in play was not measured beyond that.
 */
import type { OptionGroup, OptionMeta } from '@gsp/adapter-api';
import { MANAGED_SERVERCONFIG } from '../shared/install';

type OptionType = OptionMeta['type'];
type Text = [label: string, description: string];

export const SERVERCONFIG_GROUPS: OptionGroup[] = [
  { id: 'general', label: { en: 'General', es: 'General' } },
  { id: 'world', label: { en: 'New worlds', es: 'Mundos nuevos' } },
  { id: 'mods', label: { en: 'Mods', es: 'Mods' }, advanced: true },
  { id: 'technical', label: { en: 'Performance and technical', es: 'Rendimiento y técnico' }, advanced: true },
  { id: 'panel', label: { en: 'Set by the panel', es: 'Fijados por el panel' }, advanced: true },
];

function o(key: string, type: OptionType, group: string, dflt: string | undefined, en: Text, es: Text, extra: Partial<OptionMeta> = {}): OptionMeta {
  return { key, type, group, ...(dflt === undefined ? {} : { default: dflt }), label: { en: en[0], es: es[0] }, description: { en: en[1], es: es[1] }, ...extra };
}

const LAUNCH = { en: ' It is set in the server’s launch settings.', es: ' Se fija en los ajustes de inicio del servidor.' };
const PANEL = { en: ' The panel sets it at every start.', es: ' Lo fija el panel en cada inicio.' };
const NEW_WORLD = { en: ' Used only when a new world is created: the first start, or after a world reset.', es: ' Solo se usa al crear un mundo nuevo: el primer inicio, o después de reiniciar el mundo.' };

const OFF_ON = [
  { value: 0, label: { en: 'Off', es: 'Apagado' } },
  { value: 1, label: { en: 'On', es: 'Encendido' } },
];

/** The keys the agent's launch flags or its own writes decide (CFG-04). */
export const SERVERCONFIG_MANAGED = [...MANAGED_SERVERCONFIG, 'password', 'maxplayers', 'worldname'] as const;

const common: OptionMeta[] = [
  // ------------------------------------------------------------------ general
  o('motd', 'string', 'general', undefined, ['Message of the day', 'A line players read in chat when they join.'], ['Mensaje del día', 'Una línea que los jugadores leen en el chat al entrar.']),
  o(
    'secure',
    'enum',
    'general',
    undefined,
    ['Extra cheat protection', 'The game checks more of what players send it, and turns away some cheats.'],
    ['Protección extra contra trampas', 'El juego revisa más de lo que le envían los jugadores, y rechaza algunas trampas.'],
    { options: OFF_ON },
  ),

  // ------------------------------------------------------------------ new worlds
  o(
    'difficulty',
    'enum',
    'world',
    '0',
    ['Difficulty', `How hard the world is.${NEW_WORLD.en}`],
    ['Dificultad', `Qué tan difícil es el mundo.${NEW_WORLD.es}`],
    {
      options: [
        { value: 0, label: { en: 'Classic', es: 'Clásico' } },
        { value: 1, label: { en: 'Expert', es: 'Experto' } },
        { value: 2, label: { en: 'Master', es: 'Maestro' } },
        { value: 3, label: { en: 'Journey', es: 'Viaje' } },
      ],
    },
  ),
  o('seed', 'string', 'world', undefined, ['World seed', `Text the new world is generated from: the same seed gives the same world. Empty: a random one.${NEW_WORLD.en}`], ['Semilla del mundo', `El texto con el que se genera el mundo nuevo: la misma semilla da el mismo mundo. Vacío: una al azar.${NEW_WORLD.es}`]),

  // ------------------------------------------------------------------ technical
  o(
    'npcstream',
    'integer',
    'technical',
    undefined,
    ['Enemy updates', 'How often enemies are sent to players: lower numbers make them jump around less but use more bandwidth; 0 turns it off.'],
    ['Actualización de enemigos', 'Cada cuánto se envían los enemigos a los jugadores: los números bajos los hacen saltar menos pero usan más ancho de banda; 0 lo apaga.'],
    { min: 0 },
  ),
  o(
    'priority',
    'enum',
    'technical',
    undefined,
    ['Process priority', 'How much of the processor the game asks for, from real time (0) to idle (5).'],
    ['Prioridad del proceso', 'Cuánto del procesador pide el juego, de tiempo real (0) a inactivo (5).'],
    {
      options: [
        { value: 0, label: { en: 'Real time', es: 'Tiempo real' } },
        { value: 1, label: { en: 'High', es: 'Alta' } },
        { value: 2, label: { en: 'Above normal', es: 'Superior a la normal' } },
        { value: 3, label: { en: 'Normal', es: 'Normal' } },
        { value: 4, label: { en: 'Below normal', es: 'Inferior a la normal' } },
        { value: 5, label: { en: 'Idle', es: 'Inactiva' } },
      ],
    },
  ),
  o(
    'worldrollbackstokeep',
    'integer',
    'technical',
    undefined,
    ['World copies the game keeps', 'How many earlier saves of the world the game keeps next to it (its own, not the panel’s backups).'],
    ['Copias del mundo que guarda el juego', 'Cuántos guardados anteriores del mundo guarda el juego junto a él (los suyos, no las copias de seguridad del panel).'],
    { min: 0 },
  ),

  // ------------------------------------------------------------------ set by the panel
  o('password', 'string', 'panel', undefined, ['Server password', `What players type to join.${LAUNCH.en}`], ['Contraseña del servidor', `Lo que escriben los jugadores para entrar.${LAUNCH.es}`]),
  o('maxplayers', 'integer', 'panel', undefined, ['Player slots', `How many players can be online at once.${LAUNCH.en}`], ['Plazas de jugadores', `Cuántos jugadores pueden estar conectados a la vez.${LAUNCH.es}`]),
  o('worldname', 'string', 'panel', undefined, ['World name', 'The name of the world, which is the server’s id: it names the world’s file, which backups and resets find it by.'], ['Nombre del mundo', 'El nombre del mundo, que es el id del servidor: da nombre al archivo del mundo, con el que lo encuentran las copias de seguridad y los reinicios.']),
  o('port', 'integer', 'panel', undefined, ['Port', `The port the game listens on inside its container; players connect to the port the server publishes.${PANEL.en}`], ['Puerto', `El puerto en el que escucha el juego dentro de su contenedor; los jugadores se conectan al puerto que publica el servidor.${PANEL.es}`]),
  o('world', 'string', 'panel', undefined, ['World file', `Where the world is kept.${PANEL.en}`], ['Archivo del mundo', `Dónde se guarda el mundo.${PANEL.es}`]),
  o('worldpath', 'string', 'panel', undefined, ['Worlds folder', `The folder worlds are kept in.${PANEL.en}`], ['Carpeta de mundos', `La carpeta donde se guardan los mundos.${PANEL.es}`]),
  o('autocreate', 'enum', 'panel', undefined, ['New world size', 'The size of a world the game creates when there is none. It is the World size of the server’s launch settings.'], ['Tamaño del mundo nuevo', 'El tamaño del mundo que crea el juego cuando no hay ninguno. Es el Tamaño del mundo de los ajustes de inicio del servidor.'], {
    options: [
      { value: 1, label: { en: 'Small', es: 'Pequeño' } },
      { value: 2, label: { en: 'Medium', es: 'Mediano' } },
      { value: 3, label: { en: 'Large', es: 'Grande' } },
    ],
  }),
  o('banlist', 'string', 'panel', undefined, ['Ban list file', `Where the game keeps its bans (on the Players page).${PANEL.en}`], ['Archivo de baneos', `Dónde guarda el juego sus baneos (en la página Jugadores).${PANEL.es}`]),
  o('language', 'string', 'panel', undefined, ['Console language', `English: the panel reads what the game prints, and another language would hide it.${PANEL.en}`], ['Idioma de la consola', `Inglés: el panel lee lo que imprime el juego, y otro idioma se lo ocultaría.${PANEL.es}`]),
  o('upnp', 'enum', 'panel', undefined, ['Open router ports', `Off: the panel never opens ports on your router; forward them yourself.${PANEL.en}`], ['Abrir puertos del router', `Apagado: el panel nunca abre puertos en tu router; redirigilos vos.${PANEL.es}`], { options: OFF_ON }),
];

/** tModLoader's two keys: the mods folder and a mod pack, which the panel's mods keep as they are. */
const tml: OptionMeta[] = [
  o('modpath', 'string', 'mods', undefined, ['Mods folder', 'Where tModLoader looks for mods. The panel keeps its mods in their usual place.'], ['Carpeta de mods', 'Dónde busca mods tModLoader. El panel mantiene sus mods en su lugar habitual.']),
  o('modpack', 'string', 'mods', undefined, ['Mod pack', 'A mod pack tModLoader loads instead of the mods enabled on the Mods page.'], ['Paquete de mods', 'Un paquete de mods que tModLoader carga en lugar de los mods activados en la página Mods.']),
];

export const SERVERCONFIG_SCHEMA: OptionMeta[] = common;
export const SERVERCONFIG_TML_SCHEMA: OptionMeta[] = [...common, ...tml];
/** tModLoader's mods folder and pack are the mods' (MOD-03), not a form's. */
export const SERVERCONFIG_TML_MANAGED = [...SERVERCONFIG_MANAGED, 'modpath', 'modpack'] as const;
