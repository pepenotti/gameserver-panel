import type { CommandDoc } from '@gsp/adapter-api';

/**
 * The console commands people use most, for the console's help and AST-04.
 * Names and usage follow the `help` output of 26.3
 * (fixtures/minecraft/26.3/vanilla/logs/console-session.log); the full list
 * is the game's own `help`.
 */
export const MINECRAFT_CONSOLE_CATALOG: CommandDoc[] = [
  { name: 'help', syntax: 'help [<command>]', description: { en: 'Lists the console commands, or explains one.', es: 'Lista los comandos de la consola, o explica uno.' } },
  { name: 'list', syntax: 'list [uuids]', description: { en: 'Lists the players online (with their account ids).', es: 'Lista los jugadores conectados (con los id de sus cuentas).' } },
  { name: 'say', syntax: 'say <message>', description: { en: 'Sends a message to every player online (256 characters at most).', es: 'Envía un mensaje a todos los jugadores conectados (256 caracteres como máximo).' }, permission: 'server.broadcast' },
  { name: 'save-all', syntax: 'save-all [flush]', description: { en: 'Saves the world now; flush waits until it is on disk.', es: 'Guarda el mundo ahora; flush espera hasta que esté en disco.' } },
  { name: 'stop', syntax: 'stop', description: { en: 'Saves and stops the server.', es: 'Guarda y apaga el servidor.' } },
  { name: 'kick', syntax: 'kick <targets> [<reason>]', description: { en: 'Disconnects a player, with an optional reason.', es: 'Desconecta a un jugador, con un motivo opcional.' }, permission: 'players.moderate' },
  { name: 'ban', syntax: 'ban <targets> [<reason>]', description: { en: 'Bans a player by name.', es: 'Banea a un jugador por su nombre.' }, permission: 'players.moderate' },
  { name: 'ban-ip', syntax: 'ban-ip <target> [<reason>]', description: { en: 'Bans an IP address.', es: 'Banea una dirección IP.' }, permission: 'players.moderate' },
  { name: 'pardon', syntax: 'pardon <targets>', description: { en: 'Lifts a player’s ban.', es: 'Quita el baneo de un jugador.' }, permission: 'players.moderate' },
  { name: 'pardon-ip', syntax: 'pardon-ip <target>', description: { en: 'Lifts an IP ban.', es: 'Quita el baneo de una IP.' }, permission: 'players.moderate' },
  { name: 'banlist', syntax: 'banlist [ips|players]', description: { en: 'Lists the bans.', es: 'Lista los baneos.' } },
  { name: 'op', syntax: 'op <targets>', description: { en: 'Makes a player an operator.', es: 'Hace operador a un jugador.' }, permission: 'players.accessLevel' },
  { name: 'deop', syntax: 'deop <targets>', description: { en: 'Takes operator away from a player.', es: 'Le quita a un jugador el rango de operador.' }, permission: 'players.accessLevel' },
  {
    name: 'whitelist',
    syntax: 'whitelist (on|off|list|add|remove|reload)',
    description: { en: 'Turns the whitelist on or off, lists it, adds or removes a player, or re-reads its file.', es: 'Activa o desactiva la lista blanca, la lista, agrega o quita a un jugador, o vuelve a leer su archivo.' },
    permission: 'whitelist.manage',
  },
  { name: 'difficulty', syntax: 'difficulty [peaceful|easy|normal|hard]', description: { en: 'Shows or changes the difficulty until the next start.', es: 'Muestra o cambia la dificultad hasta el próximo inicio.' } },
  { name: 'gamemode', syntax: 'gamemode <gamemode> [<target>]', description: { en: 'Changes a player’s game mode.', es: 'Cambia el modo de juego de un jugador.' } },
  { name: 'defaultgamemode', syntax: 'defaultgamemode <gamemode>', description: { en: 'Changes the game mode new players start in.', es: 'Cambia el modo de juego con el que empiezan los jugadores nuevos.' } },
  { name: 'gamerule', syntax: 'gamerule <rule> [<value>]', description: { en: 'Shows or changes one of the world’s rules (keep inventory, mob griefing…).', es: 'Muestra o cambia una de las reglas del mundo (conservar el inventario, destrozos de criaturas…).' } },
  { name: 'time', syntax: 'time (set|add|query) …', description: { en: 'Shows or changes the time of day.', es: 'Muestra o cambia la hora del día.' } },
  { name: 'weather', syntax: 'weather (clear|rain|thunder)', description: { en: 'Changes the weather.', es: 'Cambia el clima.' } },
  { name: 'teleport', syntax: 'teleport (<location>|<destination>|<targets>)', description: { en: 'Moves players or entities (also tp).', es: 'Mueve jugadores o entidades (también tp).' } },
  { name: 'give', syntax: 'give <targets> <item> [<count>]', description: { en: 'Gives an item to a player.', es: 'Le da un objeto a un jugador.' } },
  { name: 'seed', syntax: 'seed', description: { en: 'Shows the world’s seed.', es: 'Muestra la semilla del mundo.' } },
  { name: 'version', syntax: 'version', description: { en: 'Shows the server’s version.', es: 'Muestra la versión del servidor.' } },
];
