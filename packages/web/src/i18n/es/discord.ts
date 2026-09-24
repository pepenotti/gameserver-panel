import type { Translations } from '../en';

export default {
  title: 'Notificaciones de Discord',
  help: 'Creá un webhook en tu servidor de Discord (Ajustes del servidor → Integraciones → Webhooks) y pegá acá su URL.',
  webhook: 'URL del webhook',
  webhookKeep: 'Configurado: {{url}} — pegá uno nuevo para reemplazarlo',
  remove: 'Quitar webhook',
  lang: 'Idioma de los mensajes',
  events: 'Mandar un mensaje cuando',
  test: 'Mandar un mensaje de prueba',
  testOk: 'Mensaje de prueba enviado.',
  names: {
    serverUp: 'el servidor se prende',
    serverDown: 'el servidor se apaga',
    crash: 'algo sale mal (caídas, cuelgues)',
    playerJoin: 'entra un jugador',
    playerLeave: 'sale un jugador',
    backup: 'termina una copia de seguridad',
    update: 'se actualiza el juego',
    restore: 'se restaura una copia',
    reset: 'se reinicia el mundo',
    mods: 'cambian los mods o hay actualizaciones',
    security: 'hay muchos ingresos fallidos',
  },
} satisfies Translations['discord'];
