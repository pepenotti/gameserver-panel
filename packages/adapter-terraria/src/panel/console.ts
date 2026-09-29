import type { CommandDoc } from '@gsp/adapter-api';

/**
 * The console commands people use most, for the console's help and AST-04,
 * as each flavour's console listed and answered them
 * (docs/verification/terraria-1.4.5.8.md, "Control": vanilla's `help`,
 * tModLoader's two more, TShock's own commands, which its console takes
 * with or without `/`). The full lists are the consoles' own `help`.
 */
const CONSOLE = ['vanilla', 'tmodloader'];
const TSHOCK = ['tshock'];

export const TERRARIA_CONSOLE_CATALOG: CommandDoc[] = [
  { name: 'help', syntax: 'help', description: { en: 'Lists the console commands.', es: 'Lista los comandos de la consola.' } },
  { name: 'playing', syntax: 'playing', description: { en: 'Lists the players online.', es: 'Lista los jugadores conectados.' } },
  { name: 'say', syntax: 'say <message>', description: { en: 'Sends a message to every player online.', es: 'Envía un mensaje a todos los jugadores conectados.' }, permission: 'server.broadcast' },
  { name: 'save', syntax: 'save', description: { en: 'Saves the world now.', es: 'Guarda el mundo ahora.' } },
  { name: 'exit', syntax: 'exit', description: { en: 'Saves and stops the server.', es: 'Guarda y apaga el servidor.' } },
  { name: 'version', syntax: 'version', description: { en: 'Shows the server’s version.', es: 'Muestra la versión del servidor.' } },
  { name: 'time', syntax: 'time', description: { en: 'Shows the time of day in the world.', es: 'Muestra la hora del día en el mundo.' } },
  {
    name: 'kick',
    syntax: 'kick <player>',
    description: { en: 'Disconnects a player who is online (on TShock, a reason may follow the name).', es: 'Desconecta a un jugador conectado (en TShock, puede seguir un motivo después del nombre).' },
    permission: 'players.moderate',
  },

  // ------------------------------------------------------------------ vanilla and tModLoader
  {
    name: 'ban',
    syntax: 'ban <player>',
    description: { en: 'Bans the address of a player who is online: everyone who shares it is banned too.', es: 'Banea la dirección de un jugador conectado: también quedan baneados todos los que la comparten.' },
    permission: 'players.moderate',
    flavours: CONSOLE,
  },
  {
    name: 'password',
    syntax: 'password [<new password>]',
    description: { en: 'Shows the server password, or changes it until the next start.', es: 'Muestra la contraseña del servidor, o la cambia hasta el próximo inicio.' },
    permission: 'server.update',
    secretArgs: true,
    flavours: CONSOLE,
  },
  { name: 'motd', syntax: 'motd [<message>]', description: { en: 'Shows the message of the day, or changes it until the next start.', es: 'Muestra el mensaje del día, o lo cambia hasta el próximo inicio.' }, flavours: CONSOLE },
  { name: 'exit-nosave', syntax: 'exit-nosave', description: { en: 'Stops the server without saving.', es: 'Apaga el servidor sin guardar.' }, flavours: CONSOLE },
  { name: 'dawn', syntax: 'dawn', description: { en: 'Changes the time to dawn (also noon, dusk and midnight).', es: 'Cambia la hora al amanecer (también noon, dusk y midnight).' }, flavours: CONSOLE },
  { name: 'settle', syntax: 'settle', description: { en: 'Settles the world’s water.', es: 'Asienta el agua del mundo.' }, flavours: CONSOLE },
  { name: 'seed', syntax: 'seed', description: { en: 'Shows the world’s seed.', es: 'Muestra la semilla del mundo.' }, flavours: CONSOLE },
  { name: 'maxplayers', syntax: 'maxplayers', description: { en: 'Shows how many players can be online.', es: 'Muestra cuántos jugadores pueden estar conectados.' }, flavours: CONSOLE },
  { name: 'modlist', syntax: 'modlist', description: { en: 'Lists the mods loaded.', es: 'Lista los mods cargados.' }, flavours: ['tmodloader'] },

  // ------------------------------------------------------------------ TShock
  { name: 'who', syntax: 'who', description: { en: 'Lists the players online, with the player limit.', es: 'Lista los jugadores conectados, con el límite de jugadores.' }, flavours: TSHOCK },
  {
    name: 'ban add',
    syntax: 'ban add <player> [<reason>]',
    description: { en: 'Bans a player who is online, by name.', es: 'Banea por nombre a un jugador conectado.' },
    permission: 'players.moderate',
    flavours: TSHOCK,
  },
  { name: 'ban list', syntax: 'ban list', description: { en: 'Lists the bans with their tickets.', es: 'Lista los baneos con sus números.' }, flavours: TSHOCK },
  { name: 'ban del', syntax: 'ban del <ticket>', description: { en: 'Lifts a ban by its ticket.', es: 'Quita un baneo por su número.' }, permission: 'players.moderate', flavours: TSHOCK },
  { name: 'broadcast', syntax: 'broadcast <message>', description: { en: 'Sends a message to every player online.', es: 'Envía un mensaje a todos los jugadores conectados.' }, permission: 'server.broadcast', flavours: TSHOCK },
  {
    name: 'serverpassword',
    syntax: 'serverpassword "<password>"',
    description: { en: 'Changes the server password until the next start.', es: 'Cambia la contraseña del servidor hasta el próximo inicio.' },
    permission: 'server.update',
    secretArgs: true,
    flavours: TSHOCK,
  },
  { name: 'off', syntax: 'off', description: { en: 'Saves and stops the server (off-nosave: without saving).', es: 'Guarda y apaga el servidor (off-nosave: sin guardar).' }, flavours: TSHOCK },
];
