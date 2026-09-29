/**
 * The settings form of TShock's `tshock/config.json` (CFG-01, CFG-10): the
 * settings people change most, from the 145 keys TShock 6.2.1 wrote
 * (fixtures/terraria/1.4.5.8/tshock/config/config.json.generated), with the
 * defaults it wrote, grouped and described in the panel's own words in
 * English and Spanish; every other key shows up under "Advanced" as it is
 * (principle 2). The keys are dotted paths under `Settings`.
 *
 * Measured: TShock rewrites the file at every start, keeping the values it
 * knows and dropping unknown keys; its command line wins over `ServerPort`,
 * `MaxSlots`, `RestApiEnabled` and `RestApiPort`; the agent owns the REST
 * API and its token (CON-04). What each setting does in play was not
 * measured.
 */
import type { OptionGroup, OptionMeta } from '@gsp/adapter-api';

type OptionType = OptionMeta['type'];
type Text = [label: string, description: string];

export const TSHOCK_GROUPS: OptionGroup[] = [
  { id: 'general', label: { en: 'General', es: 'General' } },
  { id: 'accounts', label: { en: 'Accounts and joining', es: 'Cuentas y entrada' } },
  { id: 'gameplay', label: { en: 'Gameplay', es: 'Partida' } },
  { id: 'saving', label: { en: 'Saving and backups', es: 'Guardado y copias' } },
  { id: 'chat', label: { en: 'Chat and commands', es: 'Chat y comandos' } },
  { id: 'storage', label: { en: 'Database', es: 'Base de datos' }, advanced: true },
  { id: 'rest', label: { en: 'REST API', es: 'API REST' }, advanced: true },
];

const S = (k: string) => `Settings.${k}`;

function o(key: string, type: OptionType, group: string, dflt: string | undefined, en: Text, es: Text, extra: Partial<OptionMeta> = {}): OptionMeta {
  return { key: S(key), type, group, ...(dflt === undefined ? {} : { default: dflt }), label: { en: en[0], es: es[0] }, description: { en: en[1], es: es[1] }, ...extra };
}

const AGENT = { en: ' The panel’s agent sets it and talks to TShock through it; it is never published.', es: ' Lo fija el agente del panel, que habla con TShock a través de ella; nunca se publica.' };
const FLAG = { en: ' TShock is started with the server’s own value, which wins over this one.', es: ' TShock se inicia con el valor del servidor, que tiene prioridad sobre este.' };

/** The keys the agent owns or the launch flags decide (CFG-04, CON-04); the token object is also secret whole. */
export const TSHOCK_MANAGED = [S('ServerPort'), S('MaxSlots'), S('RestApiEnabled'), S('RestApiPort'), S('ApplicationRestTokens')];
/** Where TShock keeps its REST tokens: as object keys (`{ "<token>": { Username, UserGroupName } }`). */
export const TSHOCK_TOKEN_TREE = S('ApplicationRestTokens');
/** Passwords, and the connection strings that may hold one. */
export const TSHOCK_SECRETS = [S('ServerPassword'), S('MySqlPassword'), S('PostgresPassword'), S('SqliteConnectionString'), S('MySqlConnectionString'), S('PostgresConnectionString')];

export const TSHOCK_SCHEMA: OptionMeta[] = [
  // ------------------------------------------------------------------ general
  o('ServerName', 'string', 'general', '', ['Server name', 'The name TShock gives the server, used when "Use the server name" is on.'], ['Nombre del servidor', 'El nombre que TShock le da al servidor, usado cuando "Usar el nombre del servidor" está activo.']),
  o('UseServerName', 'boolean', 'general', 'false', ['Use the server name', 'Show the server name above instead of the world’s name.'], ['Usar el nombre del servidor', 'Mostrar el nombre del servidor en lugar del nombre del mundo.']),
  o(
    'ServerPassword',
    'string',
    'general',
    '',
    ['TShock’s server password', 'A password of TShock’s own for joining. The server password in the launch settings is the one the panel sets: use one or the other. Kept hidden.'],
    ['Contraseña del servidor de TShock', 'Una contraseña propia de TShock para entrar. La contraseña del servidor de los ajustes de inicio es la que fija el panel: usá una o la otra. Se muestra oculta.'],
  ),
  o('ReservedSlots', 'integer', 'general', '20', ['Reserved slots', 'Extra places for players allowed in when the server is full.'], ['Plazas reservadas', 'Lugares extra para los jugadores que pueden entrar con el servidor lleno.'], { min: 0 }),
  o('MaxSlots', 'integer', 'general', '8', ['Player slots', `How many players can be online at once.${FLAG.en}`], ['Plazas de jugadores', `Cuántos jugadores pueden estar conectados a la vez.${FLAG.es}`]),
  o('ServerPort', 'integer', 'general', '7777', ['Port', `The port the game listens on inside its container.${FLAG.en}`], ['Puerto', `El puerto en el que escucha el juego dentro de su contenedor.${FLAG.es}`]),

  // ------------------------------------------------------------------ accounts and joining
  o('RequireLogin', 'boolean', 'accounts', 'false', ['Require an account', 'Players must log in to a TShock account to play.'], ['Exigir una cuenta', 'Los jugadores deben entrar con una cuenta de TShock para jugar.']),
  o('DisableLoginBeforeJoin', 'boolean', 'accounts', 'false', ['No login before joining', 'Don’t ask for the account password while joining; players log in once they are in.'], ['Sin inicio de sesión al entrar', 'No pedir la contraseña de la cuenta al entrar; los jugadores inician sesión ya adentro.']),
  o(
    'DisableUUIDLogin',
    'boolean',
    'accounts',
    'false',
    ['No automatic login', 'Don’t log players in by the id their game sends. That id can be copied by a server they joined before, so public servers may want this on.'],
    ['Sin inicio de sesión automático', 'No iniciar sesión a los jugadores por el id que envía su juego. Ese id lo puede copiar un servidor en el que hayan entrado antes, así que los servidores públicos pueden querer activarlo.'],
  ),
  o('KickEmptyUUID', 'boolean', 'accounts', 'true', ['Kick games without an id', 'Turn away players whose game sends no id.'], ['Expulsar juegos sin id', 'Rechazar a los jugadores cuyo juego no envía un id.']),
  o('AllowRegisterAnyUsername', 'boolean', 'accounts', 'false', ['Register any name', 'Players may register accounts under names other than their character’s.'], ['Registrar cualquier nombre', 'Los jugadores pueden registrar cuentas con nombres distintos al de su personaje.']),
  o('AllowLoginAnyUsername', 'boolean', 'accounts', 'true', ['Log in to any account', 'Players may log in to accounts with names other than their character’s.'], ['Entrar a cualquier cuenta', 'Los jugadores pueden entrar a cuentas con nombres distintos al de su personaje.']),
  o('MinimumPasswordLength', 'integer', 'accounts', '4', ['Shortest account password', 'The fewest characters an account password may have.'], ['Contraseña de cuenta más corta', 'La menor cantidad de caracteres que puede tener la contraseña de una cuenta.'], { min: 1 }),
  o('MaximumLoginAttempts', 'integer', 'accounts', '3', ['Login attempts', 'Wrong passwords a player may type before being kicked.'], ['Intentos de inicio de sesión', 'Contraseñas incorrectas que puede escribir un jugador antes de ser expulsado.'], { min: 1 }),
  o('DefaultRegistrationGroupName', 'string', 'accounts', 'default', ['Group of new accounts', 'The TShock group a newly registered account starts in.'], ['Grupo de las cuentas nuevas', 'El grupo de TShock con el que empieza una cuenta recién registrada.']),
  o('DefaultGuestGroupName', 'string', 'accounts', 'guest', ['Group of guests', 'The TShock group of players who are not logged in.'], ['Grupo de los invitados', 'El grupo de TShock de los jugadores que no iniciaron sesión.']),
  o('EnableWhitelist', 'boolean', 'accounts', 'false', ['Whitelist on', 'Only addresses in TShock’s whitelist file can join. Behind Docker Desktop every player shares one address.'], ['Lista blanca activa', 'Solo pueden entrar las direcciones del archivo de lista blanca de TShock. Detrás de Docker Desktop todos los jugadores comparten una dirección.']),
  o('WhitelistKickReason', 'string', 'accounts', 'You are not on the whitelist.', ['Whitelist message', 'What players not on the whitelist are told.'], ['Mensaje de la lista blanca', 'Lo que se les dice a los jugadores que no están en la lista blanca.']),
  o('KickProxyUsers', 'boolean', 'accounts', 'true', ['Kick proxy users', 'Turn away players who connect through a known proxy.'], ['Expulsar a quien use proxy', 'Rechazar a los jugadores que se conectan a través de un proxy conocido.']),
  o('EnableGeoIP', 'boolean', 'accounts', 'true', ['Show where players join from', 'Name the country a player joins from, from TShock’s own address list.'], ['Mostrar desde dónde entran', 'Nombrar el país desde el que entra un jugador, según la lista de direcciones de TShock.']),

  // ------------------------------------------------------------------ gameplay
  o('PvPMode', 'string', 'gameplay', 'normal', ['PvP mode', 'Whether players can fight each other; "normal" leaves it to each player, as in the game.'], ['Modo PvP', 'Si los jugadores pueden pelear entre sí; "normal" lo deja a cada jugador, como en el juego.']),
  o('SpawnProtection', 'boolean', 'gameplay', 'false', ['Protect the spawn', 'Only admins can build near where players appear.'], ['Proteger el punto de aparición', 'Solo los administradores pueden construir cerca de donde aparecen los jugadores.']),
  o('SpawnProtectionRadius', 'integer', 'gameplay', '10', ['Spawn protection radius', 'How many tiles around the spawn are protected.'], ['Radio de protección', 'Cuántos bloques alrededor del punto de aparición se protegen.'], { min: 0 }),
  o('DisableBuild', 'boolean', 'gameplay', 'false', ['No building', 'Nobody can place or break blocks.'], ['Sin construir', 'Nadie puede poner ni romper bloques.']),
  o('DisableHardmode', 'boolean', 'gameplay', 'false', ['No hardmode', 'The world never enters hardmode.'], ['Sin modo difícil', 'El mundo nunca entra en modo difícil.']),
  o('DisableTombstones', 'boolean', 'gameplay', 'false', ['No tombstones', 'Players leave no tombstone when they die.'], ['Sin lápidas', 'Los jugadores no dejan lápida al morir.']),
  o('ForceTime', 'string', 'gameplay', 'normal', ['Time of day', '"normal" lets days and nights pass as in the game.'], ['Hora del día', '"normal" deja pasar días y noches como en el juego.']),
  o('RespawnSeconds', 'integer', 'gameplay', '0', ['Respawn time (seconds)', 'How long players wait to come back after dying; 0 leaves it to the game.'], ['Tiempo de reaparición (segundos)', 'Cuánto esperan los jugadores para volver después de morir; 0 lo deja al juego.'], { min: 0 }),
  o('RespawnBossSeconds', 'integer', 'gameplay', '0', ['Respawn time during a boss (seconds)', 'The same, while a boss is alive; 0 leaves it to the game.'], ['Reaparición durante un jefe (segundos)', 'Lo mismo, mientras hay un jefe vivo; 0 lo deja al juego.'], { min: 0 }),
  o('DefaultMaximumSpawns', 'integer', 'gameplay', '5', ['Enemies at once', 'How many enemies may be around at the same time.'], ['Enemigos a la vez', 'Cuántos enemigos puede haber al mismo tiempo.'], { min: 0, advanced: true }),
  o('DefaultSpawnRate', 'integer', 'gameplay', '600', ['Spawn delay', 'How often enemies appear: higher numbers mean fewer.'], ['Ritmo de aparición', 'Cada cuánto aparecen enemigos: los números más altos significan menos.'], { min: 0, advanced: true }),
  o('MaxHP', 'integer', 'gameplay', '500', ['Most health', 'Players with more health than this are kicked as cheaters.'], ['Vida máxima', 'Se expulsa como tramposos a los jugadores con más vida que esta.'], { min: 1, advanced: true }),
  o('MaxMP', 'integer', 'gameplay', '200', ['Most mana', 'Players with more mana than this are kicked as cheaters.'], ['Maná máximo', 'Se expulsa como tramposos a los jugadores con más maná que este.'], { min: 1, advanced: true }),

  // ------------------------------------------------------------------ saving and backups
  o('AutoSave', 'boolean', 'saving', 'true', ['Save automatically', 'TShock saves the world every few minutes.'], ['Guardar automáticamente', 'TShock guarda el mundo cada algunos minutos.']),
  o('AnnounceSave', 'boolean', 'saving', 'false', ['Announce saves', 'Tell players when the world is saved.'], ['Anunciar los guardados', 'Avisar a los jugadores cuando se guarda el mundo.']),
  o('BackupInterval', 'integer', 'saving', '10', ['TShock’s backups (minutes)', 'How often TShock copies the world into its own backups (not the panel’s); 0 turns them off.'], ['Copias de TShock (minutos)', 'Cada cuánto copia TShock el mundo en sus propias copias (no las del panel); 0 las apaga.'], { min: 0 }),
  o('BackupKeepFor', 'integer', 'saving', '240', ['Keep TShock’s backups (minutes)', 'How long TShock keeps its own backups.'], ['Conservar las copias de TShock (minutos)', 'Cuánto tiempo conserva TShock sus propias copias.'], { min: 0 }),
  o('SaveWorldOnCrash', 'boolean', 'saving', 'true', ['Save on a crash', 'Try to save the world when the server crashes.'], ['Guardar si se cae', 'Intentar guardar el mundo cuando el servidor falla.']),
  o('SaveWorldOnLastPlayerExit', 'boolean', 'saving', 'true', ['Save when the last player leaves', 'Save the world when the server becomes empty.'], ['Guardar cuando sale el último', 'Guardar el mundo cuando el servidor queda vacío.']),

  // ------------------------------------------------------------------ chat and commands
  o('CommandSpecifier', 'string', 'chat', '/', ['Command sign', 'What players type before a command in chat.'], ['Signo de comando', 'Lo que escriben los jugadores antes de un comando en el chat.']),
  o('CommandSilentSpecifier', 'string', 'chat', '.', ['Silent command sign', 'The same, for commands others don’t see.'], ['Signo de comando silencioso', 'Lo mismo, para comandos que los demás no ven.']),
  o('MaximumChatMessageLength', 'integer', 'chat', '500', ['Longest chat message', 'The most characters a chat message may have.'], ['Mensaje de chat más largo', 'La mayor cantidad de caracteres que puede tener un mensaje de chat.'], { min: 1 }),
  o('ChatFormat', 'string', 'chat', '{1}{2}{3}: {4}', ['Chat format', 'How chat lines look; the numbers stand for the group’s name, prefix, the player and the message.'], ['Formato del chat', 'Cómo se ven las líneas del chat; los números representan el nombre del grupo, el prefijo, el jugador y el mensaje.'], { advanced: true }),

  // ------------------------------------------------------------------ database
  o('StorageType', 'string', 'storage', 'sqlite', ['Database kind', 'Where TShock keeps accounts, bans and more: "sqlite" is a file next to the server, which the panel’s backups copy.'], ['Tipo de base de datos', 'Dónde guarda TShock las cuentas, los baneos y más: "sqlite" es un archivo junto al servidor, que copian las copias de seguridad del panel.']),
  o('SqliteDBPath', 'string', 'storage', 'tshock.sqlite', ['Database file', 'The SQLite file, in TShock’s folder. The panel’s backups look for it under this name.'], ['Archivo de la base de datos', 'El archivo SQLite, en la carpeta de TShock. Las copias de seguridad del panel lo buscan con este nombre.']),
  o('SqliteConnectionString', 'string', 'storage', '', ['SQLite connection text', 'Advanced connection settings for SQLite. Kept hidden.'], ['Texto de conexión de SQLite', 'Ajustes de conexión avanzados para SQLite. Se muestra oculto.']),
  o('MySqlHost', 'string', 'storage', 'localhost:3306', ['MySQL server', 'Address and port of a MySQL database.'], ['Servidor MySQL', 'Dirección y puerto de una base de datos MySQL.']),
  o('MySqlDbName', 'string', 'storage', '', ['MySQL database', 'Name of the MySQL database.'], ['Base de datos MySQL', 'Nombre de la base de datos MySQL.']),
  o('MySqlUsername', 'string', 'storage', '', ['MySQL user', 'The MySQL user TShock connects as.'], ['Usuario de MySQL', 'El usuario de MySQL con el que se conecta TShock.']),
  o('MySqlPassword', 'string', 'storage', '', ['MySQL password', 'Kept hidden.'], ['Contraseña de MySQL', 'Se muestra oculta.']),
  o('MySqlConnectionString', 'string', 'storage', '', ['MySQL connection text', 'A whole connection text instead of the settings above. Kept hidden.'], ['Texto de conexión de MySQL', 'Un texto de conexión completo en lugar de los ajustes de arriba. Se muestra oculto.']),
  o('PostgresHost', 'string', 'storage', '', ['PostgreSQL server', 'Address and port of a PostgreSQL database.'], ['Servidor PostgreSQL', 'Dirección y puerto de una base de datos PostgreSQL.']),
  o('PostgresDbName', 'string', 'storage', '', ['PostgreSQL database', 'Name of the PostgreSQL database.'], ['Base de datos PostgreSQL', 'Nombre de la base de datos PostgreSQL.']),
  o('PostgresUsername', 'string', 'storage', '', ['PostgreSQL user', 'The PostgreSQL user TShock connects as.'], ['Usuario de PostgreSQL', 'El usuario de PostgreSQL con el que se conecta TShock.']),
  o('PostgresPassword', 'string', 'storage', '', ['PostgreSQL password', 'Kept hidden.'], ['Contraseña de PostgreSQL', 'Se muestra oculta.']),
  o('PostgresConnectionString', 'string', 'storage', '', ['PostgreSQL connection text', 'A whole connection text instead of the settings above. Kept hidden.'], ['Texto de conexión de PostgreSQL', 'Un texto de conexión completo en lugar de los ajustes de arriba. Se muestra oculto.']),

  // ------------------------------------------------------------------ REST API
  o('RestApiEnabled', 'boolean', 'rest', 'false', ['REST API on', `TShock’s web API.${AGENT.en}`], ['API REST activa', `La API web de TShock.${AGENT.es}`]),
  o('RestApiPort', 'integer', 'rest', '7878', ['REST API port', `The API’s port inside the container.${AGENT.en}`], ['Puerto de la API REST', `El puerto de la API dentro del contenedor.${AGENT.es}`]),
  o('ApplicationRestTokens', 'string', 'rest', undefined, ['REST API tokens', 'The keys that open the API, the agent’s among them. Hidden whole, and kept as they are.'], ['Claves de la API REST', 'Las claves que abren la API, entre ellas la del agente. Ocultas por completo, y se conservan como están.']),
  o('LogRest', 'boolean', 'rest', 'false', ['Log API calls', 'Write each call to the API in TShock’s log (never its key).'], ['Registrar las llamadas a la API', 'Escribir cada llamada a la API en el registro de TShock (nunca su clave).']),
];
