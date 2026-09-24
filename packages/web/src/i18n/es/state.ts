import type { Translations } from '../en';

export default {
  stopped: 'Apagado',
  installing: 'Actualizando',
  starting: 'Iniciando',
  running: 'En línea',
  stopping: 'Apagando',
  crashed: 'Se cayó',
  failed: 'Falló',
  unknown: 'Desconocido',
  agentOffline: 'Servidor inalcanzable',
} satisfies Translations['state'];
