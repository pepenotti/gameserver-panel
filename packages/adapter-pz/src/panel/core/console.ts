import type { CommandDoc } from '@gsp/adapter-api';

/**
 * The console commands people use most, for the console's help and AST-04.
 * Names and usage follow the `help` output of 42.20.4
 * (fixtures/pz/b42/logs/console-session.log); the full list is the game's
 * own `help`.
 */
export const PZ_CONSOLE_CATALOG: CommandDoc[] = [
  { name: 'help', syntax: 'help', description: { en: 'Lists every console command.', es: 'Lista todos los comandos de la consola.' } },
  { name: 'players', syntax: 'players', description: { en: 'Lists the players online.', es: 'Lista los jugadores conectados.' } },
  { name: 'save', syntax: 'save', description: { en: 'Saves the world now.', es: 'Guarda el mundo ahora.' } },
  { name: 'quit', syntax: 'quit', description: { en: 'Saves and stops the server.', es: 'Guarda y apaga el servidor.' } },
  { name: 'servermsg', syntax: 'servermsg "<message>"', description: { en: 'Sends a message to every player online.', es: 'Envía un mensaje a todos los jugadores conectados.' }, permission: 'server.broadcast' },
  {
    name: 'kick',
    syntax: 'kick "<user>" [-r "<reason>"]',
    description: { en: 'Kicks a player, with an optional reason.', es: 'Expulsa a un jugador, con un motivo opcional.' },
    permission: 'players.moderate',
  },
  {
    name: 'banuser',
    syntax: 'banuser "<user>" [-ip] [-r "<reason>"]',
    description: { en: 'Bans a user; -ip also bans their IP.', es: 'Banea a un usuario; -ip también banea su IP.' },
    permission: 'players.moderate',
  },
  { name: 'unbanuser', syntax: 'unbanuser "<user>"', description: { en: 'Lifts a user ban.', es: 'Quita el baneo de un usuario.' }, permission: 'players.moderate' },
  { name: 'banid', syntax: 'banid <SteamID>', description: { en: 'Bans a SteamID.', es: 'Banea un SteamID.' }, permission: 'players.moderate' },
  { name: 'unbanid', syntax: 'unbanid <SteamID>', description: { en: 'Lifts a SteamID ban.', es: 'Quita el baneo de un SteamID.' }, permission: 'players.moderate' },
  {
    name: 'adduser',
    syntax: 'adduser "<user>" "<password>"',
    description: { en: 'Adds a user to the whitelist.', es: 'Agrega un usuario a la lista blanca.' },
    permission: 'whitelist.manage',
  },
  {
    name: 'removeuserfromwhitelist',
    syntax: 'removeuserfromwhitelist "<user>"',
    description: { en: 'Removes a user from the whitelist.', es: 'Quita un usuario de la lista blanca.' },
    permission: 'whitelist.manage',
  },
  {
    name: 'setaccesslevel',
    syntax: 'setaccesslevel "<user>" <admin|moderator|overseer|gm|observer|none>',
    description: { en: "Sets a player's access level.", es: 'Cambia el nivel de acceso de un jugador.' },
    permission: 'players.accessLevel',
  },
  { name: 'setpassword', syntax: 'setpassword "<user>" "<new password>"', description: { en: "Changes a user's password.", es: 'Cambia la contraseña de un usuario.' } },
  { name: 'showoptions', syntax: 'showoptions', description: { en: 'Shows the server options and their values.', es: 'Muestra las opciones del servidor y sus valores.' } },
  { name: 'reloadoptions', syntax: 'reloadoptions', description: { en: 'Re-reads the server ini and sends it to the clients.', es: 'Vuelve a leer el ini del servidor y lo envía a los clientes.' } },
  { name: 'changeoption', syntax: 'changeoption <option> <value>', description: { en: 'Changes one server option.', es: 'Cambia una opción del servidor.' } },
  { name: 'checkModsNeedUpdate', syntax: 'checkModsNeedUpdate', description: { en: 'Says in the log whether a mod was updated.', es: 'Indica en el registro si se actualizó algún mod.' } },
  {
    name: 'additem',
    syntax: 'additem "<user>" <module.item> [count]',
    description: { en: 'Gives an item to a player (e.g. Base.Axe).', es: 'Da un objeto a un jugador (por ejemplo Base.Axe).' },
  },
  {
    name: 'teleportto',
    syntax: 'teleportto <x>,<y>,<z>',
    description: { en: 'Teleports the admin to coordinates.', es: 'Teletransporta al administrador a unas coordenadas.' },
  },
  { name: 'chopper', syntax: 'chopper', description: { en: 'Starts a helicopter event on a random player.', es: 'Inicia un evento de helicóptero sobre un jugador al azar.' } },
  { name: 'startrain', syntax: 'startrain [1-100]', description: { en: 'Starts rain, with an optional intensity.', es: 'Hace llover, con una intensidad opcional.' } },
  { name: 'stoprain', syntax: 'stoprain', description: { en: 'Stops the rain.', es: 'Detiene la lluvia.' } },
];
