import type { Translations } from '../en';

export default {
  viewer: 'Espectador',
  operator: 'Operador',
  admin: 'Administrador',
  owner: 'Dueño',
  viewerHelp: 'Ve el inicio y quién está conectado.',
  operatorHelp: 'Prende, apaga y reinicia el servidor, lee la consola, expulsa y banea.',
  adminHelp: 'Cambia la configuración y los mods, restaura copias, reinicia el mundo. Necesita 2FA.',
  ownerHelp: 'Todo, incluidas las cuentas y los borrados completos.',
} satisfies Translations['roles'];
