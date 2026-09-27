/**
 * The settings form of `server.properties` (CFG-01, CFG-10): every key the
 * 26.3 servers wrote (fixtures/minecraft/26.3/<loader>/config/
 * server.properties.generated: 69 keys, 70 on Paper), typed, with the
 * defaults they wrote, grouped, and described in the panel's own words in
 * English and Spanish. Keys of other versions the form doesn't know still
 * show up, as text (principle 2).
 *
 * Unverified beyond the fixtures: the choices of `gamemode` other than the
 * default `survival` (the game's `help` lists `difficulty`'s four), and what
 * each setting does in play; ranges are left to the game.
 */
import type { OptionGroup, OptionMeta } from '@gsp/adapter-api';

type OptionType = OptionMeta['type'];

export const PROPERTIES_GROUPS: OptionGroup[] = [
  { id: 'general', label: { en: 'General', es: 'General' } },
  { id: 'gameplay', label: { en: 'Gameplay', es: 'Partida' } },
  { id: 'world', label: { en: 'World', es: 'Mundo' } },
  { id: 'players', label: { en: 'Players and chat', es: 'Jugadores y chat' } },
  { id: 'resource-pack', label: { en: 'Resource pack', es: 'Paquete de recursos' }, advanced: true },
  { id: 'network', label: { en: 'Network and control', es: 'Red y control' }, advanced: true },
  { id: 'management', label: { en: 'Management server', es: 'Servidor de administración' }, advanced: true },
  { id: 'technical', label: { en: 'Performance and technical', es: 'Rendimiento y técnico' }, advanced: true },
];

type Text = [label: string, description: string];

function o(key: string, type: OptionType, group: string, dflt: string | undefined, en: Text, es: Text, extra: Partial<OptionMeta> = {}): OptionMeta {
  return { key, type, group, ...(dflt === undefined ? {} : { default: dflt }), label: { en: en[0], es: es[0] }, description: { en: en[1], es: es[1] }, ...extra };
}

const PANEL = { en: ' The panel sets this one.', es: ' Lo fija el panel.' };
const SECRET = { en: ' Kept hidden.', es: ' Se muestra oculto.' };

export const PROPERTIES_SCHEMA: OptionMeta[] = [
  // ------------------------------------------------------------------ general
  o('motd', 'string', 'general', 'A Minecraft Server', ['Message of the day', 'The line players see under the server’s name in their server list.'], ['Mensaje del día', 'La línea que los jugadores ven bajo el nombre del servidor en su lista de servidores.']),
  o('max-players', 'integer', 'general', '20', ['Player slots', 'How many players can be online at once (operators may be let in beyond it).'], ['Plazas de jugadores', 'Cuántos jugadores pueden estar conectados a la vez (los operadores pueden entrar aunque esté lleno).']),
  o(
    'white-list',
    'boolean',
    'general',
    undefined,
    ['Whitelist on', 'Only players on the whitelist (and operators) can join. New 26.3 servers start with it on; turn it on or off live from the Players page.'],
    ['Lista blanca activa', 'Solo pueden entrar los jugadores de la lista blanca (y los operadores). Los servidores nuevos de 26.3 empiezan con ella activa; se puede activar o desactivar en vivo desde la página Jugadores.'],
  ),
  o('enforce-whitelist', 'boolean', 'general', 'false', ['Kick players not on the whitelist', 'When the whitelist is turned on, players already online who aren’t on it are disconnected.'], ['Expulsar a quien no esté en la lista', 'Al activar la lista blanca, se desconecta a los jugadores conectados que no estén en ella.']),
  o(
    'online-mode',
    'boolean',
    'general',
    'true',
    ['Check accounts', 'Players must sign in with a real Minecraft account, checked with its maker. Turning it off lets anyone join with any name: only for private networks.'],
    ['Verificar cuentas', 'Los jugadores deben entrar con una cuenta real de Minecraft, verificada con su fabricante. Desactivarlo deja entrar a cualquiera con cualquier nombre: solo para redes privadas.'],
  ),
  o('hide-online-players', 'boolean', 'general', 'false', ['Hide who is online', 'The server list shows how many players are online, but not their names.'], ['Ocultar quién está conectado', 'La lista de servidores muestra cuántos jugadores hay, pero no sus nombres.']),
  o('enable-status', 'boolean', 'general', 'true', ['Answer the server list', 'The server shows up as online, with its message and player count, in players’ server lists.'], ['Responder a la lista de servidores', 'El servidor aparece en línea, con su mensaje y cantidad de jugadores, en las listas de servidores de los jugadores.']),
  o(
    'pause-when-empty-seconds',
    'integer',
    'general',
    undefined,
    ['Pause when empty (seconds)', 'After this many seconds without players the world stops ticking until someone joins. A negative number never pauses (Paper’s default; vanilla and Fabric pause after 60).'],
    ['Pausar sin jugadores (segundos)', 'Tras estos segundos sin jugadores el mundo se detiene hasta que alguien entre. Un número negativo nunca pausa (lo que usa Paper; vanilla y Fabric pausan a los 60).'],
  ),
  o('player-idle-timeout', 'integer', 'general', '0', ['Kick idle players (minutes)', 'Players who do nothing for this many minutes are disconnected. 0 never kicks them.'], ['Expulsar inactivos (minutos)', 'Se desconecta a los jugadores que no hagan nada durante estos minutos. 0 nunca los expulsa.']),

  // ----------------------------------------------------------------- gameplay
  o(
    'difficulty',
    'enum',
    'gameplay',
    'easy',
    ['Difficulty', 'How dangerous the world is: how much damage mobs do, and whether hostile mobs appear at all (not on peaceful).'],
    ['Dificultad', 'Qué tan peligroso es el mundo: cuánto daño hacen las criaturas, y si aparecen criaturas hostiles (no en pacífico).'],
    {
      options: [
        { value: 'peaceful', label: { en: 'Peaceful', es: 'Pacífico' } },
        { value: 'easy', label: { en: 'Easy', es: 'Fácil' } },
        { value: 'normal', label: { en: 'Normal', es: 'Normal' } },
        { value: 'hard', label: { en: 'Hard', es: 'Difícil' } },
      ],
    },
  ),
  o('gamemode', 'enum', 'gameplay', 'survival', ['Game mode', 'The mode new players start in.'], ['Modo de juego', 'El modo con el que empiezan los jugadores nuevos.'], {
    options: [
      { value: 'survival', label: { en: 'Survival', es: 'Supervivencia' } },
      { value: 'creative', label: { en: 'Creative', es: 'Creativo' } },
      { value: 'adventure', label: { en: 'Adventure', es: 'Aventura' } },
      { value: 'spectator', label: { en: 'Spectator', es: 'Espectador' } },
    ],
  }),
  o('force-gamemode', 'boolean', 'gameplay', 'false', ['Force the game mode', 'Every player is put back in the server’s game mode whenever they join, not only the first time.'], ['Forzar el modo de juego', 'Cada jugador vuelve al modo de juego del servidor cada vez que entra, no solo la primera vez.']),
  o(
    'hardcore',
    'boolean',
    'gameplay',
    'false',
    ['Hardcore', 'One life: players who die can only watch as spectators. Best set before the world is created.'],
    ['Extremo', 'Una sola vida: quien muere solo puede mirar como espectador. Conviene fijarlo antes de crear el mundo.'],
  ),
  o('allow-flight', 'boolean', 'gameplay', 'false', ['Allow flying', 'Lets players fly in survival (with mods or plugins that allow it) instead of being kicked for it.'], ['Permitir volar', 'Deja volar en supervivencia (con mods o plugins que lo permitan) en vez de expulsar por hacerlo.']),
  o('spawn-protection', 'integer', 'gameplay', '16', ['Spawn protection (blocks)', 'Radius around the world spawn where only operators can build or break. 0 turns it off.'], ['Protección del punto de aparición (bloques)', 'Radio alrededor del punto de aparición donde solo los operadores pueden construir o romper. 0 lo desactiva.']),

  // -------------------------------------------------------------------- world
  o('level-seed', 'string', 'world', '', ['World seed', 'The seed a new world is generated from. Empty picks one at random. Changing it affects only a world created afterwards (a world reset).'], ['Semilla del mundo', 'La semilla con la que se genera un mundo nuevo. Vacía elige una al azar. Cambiarla solo afecta a un mundo creado después (un reinicio del mundo).']),
  o(
    'level-type',
    'string',
    'world',
    'minecraft:normal',
    ['World type', 'The kind of world generated, as the game names it (minecraft:normal, minecraft:flat, minecraft:large_biomes, minecraft:amplified…). Used only when a world is created.'],
    ['Tipo de mundo', 'La clase de mundo que se genera, con el nombre del juego (minecraft:normal, minecraft:flat, minecraft:large_biomes, minecraft:amplified…). Solo se usa al crear un mundo.'],
  ),
  o('generator-settings', 'string', 'world', '{}', ['Generator settings', 'Extra settings for the world type, as JSON (for example, the layers of a flat world).'], ['Ajustes del generador', 'Ajustes extra del tipo de mundo, en JSON (por ejemplo, las capas de un mundo plano).']),
  o('generate-structures', 'boolean', 'world', 'true', ['Generate structures', 'Villages, temples and other structures appear in newly generated land.'], ['Generar estructuras', 'Aparecen aldeas, templos y otras estructuras en el terreno que se genera.']),
  o('max-world-size', 'integer', 'world', '29999984', ['World border radius', 'How far from the center, in blocks, the world may extend.'], ['Radio del borde del mundo', 'Hasta cuántos bloques desde el centro puede extenderse el mundo.']),
  o('view-distance', 'integer', 'world', '10', ['View distance (chunks)', 'How far around each player the server sends the world. Higher uses more memory and network.'], ['Distancia de visión (chunks)', 'Hasta qué distancia alrededor de cada jugador envía el mundo el servidor. Más alto usa más memoria y red.']),
  o('simulation-distance', 'integer', 'world', '10', ['Simulation distance (chunks)', 'How far around each player things keep moving and growing. Higher uses more processor.'], ['Distancia de simulación (chunks)', 'Hasta qué distancia alrededor de cada jugador las cosas se siguen moviendo y creciendo. Más alto usa más procesador.']),
  o('initial-enabled-packs', 'string', 'world', 'vanilla', ['Data packs on at creation', 'Data packs switched on when the world is created, separated by commas.'], ['Paquetes de datos activos al crear', 'Paquetes de datos activados al crear el mundo, separados por comas.']),
  o('initial-disabled-packs', 'string', 'world', '', ['Data packs off at creation', 'Data packs left off when the world is created, separated by commas.'], ['Paquetes de datos inactivos al crear', 'Paquetes de datos desactivados al crear el mundo, separados por comas.']),
  o('level-name', 'string', 'world', 'world', ['World folder', `The folder the world lives in. Backups and resets name it, so it can’t be changed.${PANEL.en}`], ['Carpeta del mundo', `La carpeta donde vive el mundo. Las copias de seguridad y los reinicios la usan, así que no se puede cambiar.${PANEL.es}`]),

  // ------------------------------------------------------------------ players
  o('enforce-secure-profile', 'boolean', 'players', 'true', ['Require signed chat', 'Players must have a profile key signed by the game’s maker to join, so their chat can be verified.'], ['Exigir chat firmado', 'Para entrar, los jugadores deben tener una clave de perfil firmada por el fabricante del juego, para poder verificar su chat.']),
  o('chat-spam-threshold-seconds', 'integer', 'players', '10', ['Chat spam limit (seconds)', 'How the server measures chat flooding before it kicks a player.'], ['Límite de spam en el chat (segundos)', 'Cómo mide el servidor el exceso de mensajes antes de expulsar a un jugador.']),
  o('command-spam-threshold-seconds', 'integer', 'players', '10', ['Command spam limit (seconds)', 'The same for commands typed in chat.'], ['Límite de spam de comandos (segundos)', 'Lo mismo para los comandos escritos en el chat.']),
  o('op-permission-level', 'integer', 'players', '4', ['Operator level', 'How much new operators may do, from 1 (bypass spawn protection) to 4 (every command).'], ['Nivel de operador', 'Cuánto pueden hacer los operadores nuevos, de 1 (ignorar la protección del punto de aparición) a 4 (todos los comandos).']),
  o('function-permission-level', 'integer', 'players', '2', ['Function level', 'The operator level functions from data packs run with.'], ['Nivel de las funciones', 'El nivel de operador con el que se ejecutan las funciones de los paquetes de datos.']),
  o('broadcast-console-to-ops', 'boolean', 'players', 'true', ['Show console commands to operators', 'Operators see in chat what commands typed on the console did.'], ['Mostrar la consola a los operadores', 'Los operadores ven en el chat lo que hicieron los comandos escritos en la consola.']),
  o(
    'broadcast-rcon-to-ops',
    'boolean',
    'players',
    'true',
    ['Show panel commands to operators', 'Operators see in chat what commands the panel sent did (its saves before backups, whitelist changes…).'],
    ['Mostrar los comandos del panel a los operadores', 'Los operadores ven en el chat lo que hicieron los comandos que envió el panel (los guardados antes de las copias, los cambios de la lista blanca…).'],
  ),
  o('log-ips', 'boolean', 'players', 'true', ['Log players’ addresses', 'Players’ IP addresses are written to the log when they join.'], ['Registrar las direcciones', 'Las direcciones IP de los jugadores se escriben en el registro al entrar.']),
  o('enable-code-of-conduct', 'boolean', 'players', 'false', ['Show a code of conduct', 'Players are shown the server’s code of conduct when they join.'], ['Mostrar un código de conducta', 'Se muestra a los jugadores el código de conducta del servidor al entrar.']),
  o('text-filtering-config', 'string', 'players', '', ['Chat filter settings', 'Where a chat filtering service is configured. Empty: no filter.'], ['Ajustes del filtro de chat', 'Dónde se configura un servicio de filtrado del chat. Vacío: sin filtro.']),
  o('text-filtering-version', 'integer', 'players', '0', ['Chat filter version', 'The version of the chat filtering service’s interface.'], ['Versión del filtro de chat', 'La versión de la interfaz del servicio de filtrado del chat.']),
  o('bug-report-link', 'string', 'players', '', ['Bug report link', 'A web address players are offered to report problems with the server.'], ['Enlace para reportar errores', 'Una dirección web que se ofrece a los jugadores para reportar problemas del servidor.']),
  o('accepts-transfers', 'boolean', 'players', 'false', ['Accept transferred players', 'Players another server sends here with the transfer command may join.'], ['Aceptar jugadores transferidos', 'Pueden entrar los jugadores que otro servidor envía aquí con el comando de transferencia.']),

  // ------------------------------------------------------------ resource pack
  o('resource-pack', 'string', 'resource-pack', '', ['Resource pack link', 'A web address of a resource pack offered to players when they join.'], ['Enlace del paquete de recursos', 'La dirección web de un paquete de recursos que se ofrece a los jugadores al entrar.']),
  o('resource-pack-sha1', 'string', 'resource-pack', '', ['Resource pack checksum', 'The pack’s SHA-1, so players’ games can check the download.'], ['Suma de control del paquete', 'El SHA-1 del paquete, para que los juegos de los jugadores comprueben la descarga.']),
  o('resource-pack-id', 'string', 'resource-pack', '', ['Resource pack id', 'A UUID naming the pack, so players’ games can tell packs apart.'], ['Id del paquete', 'Un UUID que nombra el paquete, para que los juegos de los jugadores los distingan.']),
  o('require-resource-pack', 'boolean', 'resource-pack', 'false', ['Require the resource pack', 'Players who decline the pack are disconnected.'], ['Exigir el paquete de recursos', 'Se desconecta a los jugadores que rechacen el paquete.']),
  o('resource-pack-prompt', 'string', 'resource-pack', '', ['Resource pack message', 'A message shown when players are asked to accept the pack.'], ['Mensaje del paquete', 'Un mensaje que se muestra al pedir a los jugadores que acepten el paquete.']),

  // ------------------------------------------------------------------ network
  o('server-port', 'integer', 'network', '25565', ['Game port (inside)', `The port the game listens on inside its container; players use the host port shown on the server’s page.${PANEL.en}`], ['Puerto del juego (interno)', `El puerto en el que escucha el juego dentro de su contenedor; los jugadores usan el puerto del equipo que muestra la página del servidor.${PANEL.es}`]),
  o('server-ip', 'string', 'network', '', ['Listen address', `The address the game listens on inside its container: every one.${PANEL.en}`], ['Dirección de escucha', `La dirección en la que escucha el juego dentro de su contenedor: todas.${PANEL.es}`]),
  o('enable-rcon', 'boolean', 'network', 'false', ['Remote console', `How the panel controls the game (RCON), inside the container only.${PANEL.en}`], ['Consola remota', `Cómo controla el panel el juego (RCON), solo dentro del contenedor.${PANEL.es}`]),
  o('rcon.port', 'integer', 'network', '25575', ['Remote console port', `Never published outside the container.${PANEL.en}`], ['Puerto de la consola remota', `Nunca se publica fuera del contenedor.${PANEL.es}`]),
  o('rcon.password', 'string', 'network', '', ['Remote console password', `Generated by the server’s agent.${SECRET.en}${PANEL.en}`], ['Contraseña de la consola remota', `La genera el agente del servidor.${SECRET.es}${PANEL.es}`]),
  o('enable-query', 'boolean', 'network', 'false', ['Query protocol', `An older way to ask a server who is online, over UDP. The panel doesn’t publish it.${PANEL.en}`], ['Protocolo de consulta', `Una forma antigua de preguntar quién está conectado, por UDP. El panel no lo publica.${PANEL.es}`]),
  o('query.port', 'integer', 'network', '25565', ['Query port', 'The port of the query protocol, when it is on.'], ['Puerto de consulta', 'El puerto del protocolo de consulta, cuando está activo.']),
  o('network-compression-threshold', 'integer', 'network', '256', ['Compress packets from (bytes)', 'Network packets at least this big are compressed. A negative number never compresses.'], ['Comprimir paquetes desde (bytes)', 'Se comprimen los paquetes de red de al menos este tamaño. Un número negativo nunca comprime.']),
  o('rate-limit', 'integer', 'network', '0', ['Packet rate limit', 'Players who send more packets per second than this are kicked. 0: no limit.'], ['Límite de paquetes', 'Se expulsa a los jugadores que envían más paquetes por segundo que esto. 0: sin límite.']),
  o('prevent-proxy-connections', 'boolean', 'network', 'false', ['Refuse players behind proxies', 'Refuses players whose address doesn’t match the one their account signed in from.'], ['Rechazar jugadores detrás de proxies', 'Rechaza a los jugadores cuya dirección no coincide con la que usó su cuenta al iniciar sesión.']),
  o('use-native-transport', 'boolean', 'network', 'true', ['Faster networking on Linux', 'Uses Linux’s own network interface when it can.'], ['Red más rápida en Linux', 'Usa la interfaz de red propia de Linux cuando puede.']),
  o('status-heartbeat-interval', 'integer', 'network', '0', ['Status heartbeat', 'How often the server sends its status to connected clients. 0: the game’s default.'], ['Latido de estado', 'Cada cuánto envía el servidor su estado a los clientes conectados. 0: lo que usa el juego por defecto.']),

  // --------------------------------------------------------------- management
  o('management-server-enabled', 'boolean', 'management', 'false', ['Management server', `The game’s own administration interface (JSON-RPC). The panel doesn’t use it and keeps it off.${PANEL.en}`], ['Servidor de administración', `La interfaz de administración propia del juego (JSON-RPC). El panel no la usa y la mantiene apagada.${PANEL.es}`]),
  o('management-server-host', 'string', 'management', 'localhost', ['Management server address', 'Where the management server listens, when it is on.'], ['Dirección del servidor de administración', 'Dónde escucha el servidor de administración, cuando está activo.']),
  o('management-server-port', 'integer', 'management', '0', ['Management server port', 'Its port; 0 picks one.'], ['Puerto del servidor de administración', 'Su puerto; 0 elige uno.']),
  o('management-server-secret', 'string', 'management', undefined, ['Management server secret', `Written by the game the first time it starts.${SECRET.en}`], ['Secreto del servidor de administración', `Lo escribe el juego la primera vez que arranca.${SECRET.es}`]),
  o('management-server-tls-enabled', 'boolean', 'management', 'true', ['Management server encryption', 'The management server uses TLS.'], ['Cifrado del servidor de administración', 'El servidor de administración usa TLS.']),
  o('management-server-tls-keystore', 'string', 'management', '', ['Management server key store', 'The file with its TLS certificate.'], ['Almacén de claves del servidor de administración', 'El archivo con su certificado TLS.']),
  o('management-server-tls-keystore-password', 'string', 'management', '', ['Key store password', `The password of that file.${SECRET.en}`], ['Contraseña del almacén de claves', `La contraseña de ese archivo.${SECRET.es}`]),
  o('management-server-allowed-origins', 'string', 'management', '', ['Allowed web origins', 'Web pages allowed to reach the management server, separated by commas.'], ['Orígenes web permitidos', 'Páginas web que pueden usar el servidor de administración, separadas por comas.']),

  // ---------------------------------------------------------------- technical
  o('max-tick-time', 'integer', 'technical', '60000', ['Watchdog (milliseconds)', 'The game stops itself when one tick takes longer than this. A negative number turns the watchdog off.'], ['Vigilante (milisegundos)', 'El juego se detiene solo cuando un ciclo tarda más que esto. Un número negativo apaga el vigilante.']),
  o('max-chained-neighbor-updates', 'integer', 'technical', '1000000', ['Chained block updates', 'The most block updates one change may set off in a row, against runaway machines.'], ['Actualizaciones de bloques en cadena', 'La mayor cantidad de actualizaciones de bloques que un cambio puede provocar seguidas, contra máquinas descontroladas.']),
  o('entity-broadcast-range-percentage', 'integer', 'technical', '100', ['Entity view range (%)', 'How far away players see creatures and items, as a share of the normal distance.'], ['Alcance de entidades (%)', 'A qué distancia ven los jugadores criaturas y objetos, como porcentaje de la distancia normal.']),
  o('sync-chunk-writes', 'boolean', 'technical', 'true', ['Write chunks at once', 'The world is written to disk without delay: safer after a crash, a little slower.'], ['Escribir chunks al momento', 'El mundo se escribe en disco sin demora: más seguro tras un fallo, un poco más lento.']),
  o('region-file-compression', 'string', 'technical', 'deflate', ['World file compression', 'How new world files are compressed, as the game names it.'], ['Compresión de los archivos del mundo', 'Cómo se comprimen los archivos nuevos del mundo, con el nombre del juego.']),
  o('enable-jmx-monitoring', 'boolean', 'technical', 'false', ['JMX monitoring', 'Exposes Java’s monitoring interface inside the container.'], ['Monitoreo JMX', 'Expone la interfaz de monitoreo de Java dentro del contenedor.']),
  o('debug', 'boolean', 'technical', 'false', ['Debug mode (Paper)', 'Paper writes more detail to the log.'], ['Modo depuración (Paper)', 'Paper escribe más detalle en el registro.']),
];

/** Shown masked in forms, the text editor and history: the agent's RCON password and the two the game writes itself. */
export const PROPERTIES_SECRETS = ['rcon.password', 'management-server-secret', 'management-server-tls-keystore-password'];
