import type { Translations } from '../en';

export default {
  title: 'Consola',
  filter: 'Filtrar líneas',
  hideNoise: 'Ocultar advertencias',
  autoscroll: 'Seguir',
  command: 'Comando (ej. players, save, help)',
  send: 'Ejecutar',
  noOutput: '(enviado a la consola del servidor; mirá el registro)',
  empty: 'Todavía no hay líneas.',
  readOnly: 'Tu rol puede leer el registro pero no ejecutar comandos.',
  quick: 'Comandos rápidos',
} satisfies Translations['console'];
