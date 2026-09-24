import type { Translations } from '../en';

export default {
  title: 'Inicio',
  server: 'Servidor',
  gameVersion: 'Versión del juego',
  build: 'build {{build}}',
  nextRestart: 'Próximo reinicio',
  lastBackup: 'Última copia',
  players: 'Jugadores conectados',
  uptime: 'Encendido hace',
  memory: 'Memoria',
  cpu: 'CPU',
  disk: 'Disco libre',
  lastExit: 'Último apagado',
  failure: 'Por qué se detuvo',
  agentOffline: 'El panel no llega al contenedor del servidor del juego. Si la PC se acaba de reiniciar, dale un minuto.',
  lock: 'Mantenimiento en curso: {{holder}}',
  noPlayers: 'No hay nadie conectado',
  clockDrift: 'El reloj del servidor difiere del tuyo en {{seconds}} s. La programación y el 2FA pueden fallar.',
  channelDown: '{{channel}} no está conectado',
  channelDownHelp: 'El servidor está prendido, pero el panel no llega a su canal de control: la lista de jugadores, los mensajes y los comandos pueden fallar hasta que se reconecte.',
  channels: {
    rcon: 'RCON',
    rest: 'La API REST',
  },
} satisfies Translations['dashboard'];
