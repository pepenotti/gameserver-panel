import type { Translations } from '../en';

export default {
  title: 'Consola',
  filter: 'Filtrar líneas',
  hideNoise: 'Ocultar advertencias',
  autoscroll: 'Seguir',
  command: 'Comando de consola',
  send: 'Ejecutar',
  noOutput: '(enviado a la consola del servidor; mirá el registro)',
  empty: 'Todavía no hay líneas.',
  readOnly: 'Tu rol puede leer el registro pero no ejecutar comandos.',
  quick: 'Comandos rápidos',
  catalog: 'Todos los comandos',
  catalogTitle: 'Comandos de consola de {{game}}',
  catalogHelp: 'Elegí uno para ponerlo en la caja de comandos, completalo y apretá Ejecutar.',
} satisfies Translations['console'];
