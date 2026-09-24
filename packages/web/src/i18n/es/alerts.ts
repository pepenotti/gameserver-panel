import type { Translations } from '../en';

export default {
  crash: 'El servidor se cayó',
  'crash-loop': 'El servidor se cae una y otra vez',
  unresponsive: 'El servidor no responde',
  'blocking-prompt': 'El servidor espera una respuesta en la consola',
  fatal: 'Error fatal',
  'start-timeout': 'El servidor tardó demasiado en arrancar',
  'start-failed': 'El servidor no pudo arrancar',
} satisfies Translations['alerts'];
