import type { Translations } from '../en';

export default {
  title: 'Servidor del juego',
  launch: 'Configuración de inicio',
  launchHelp: 'Se aplica la próxima vez que prenda el servidor.',
  versionWarn: 'Cambiar a otra versión puede dejar el mundo inservible: las partidas no siempre pasan de una versión a otra. Hacé una copia de seguridad antes.',
  updates: 'Actualizaciones del juego',
  check: 'Buscar actualizaciones',
  installed: 'Instalada',
  latest: 'Última disponible',
  upToDate: 'Al día',
  updateAvailable: 'Hay una actualización',
  updateNow: 'Actualizar ahora',
  validate: 'Verificar archivos del juego',
  validateHelp: 'Vuelve a bajar lo que esté dañado o falte. Tarda unos minutos.',
  danger: 'Emergencia',
  kill: 'Forzar apagado (sin guardar)',
  killHelp: 'Solo si el servidor se colgó y el apagado normal no funciona. Se pierde lo no guardado.',
  killConfirm: '¿Forzar el apagado sin guardar?',
  containerLimit: 'Límite de memoria del contenedor: {{limit}}. El juego necesita unos {{overhead}} además de su propia configuración de memoria.',
} satisfies Translations['server'];
