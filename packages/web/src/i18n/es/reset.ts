import type { Translations } from '../en';

export default {
  title: 'Reiniciar',
  intro: 'Empezar de cero. Siempre se hace primero una copia de todo, así que un reinicio se puede deshacer desde Copias de seguridad.',
  scope: 'Qué reiniciar',
  deletes: 'Borra: {{parts}}.',
  keeps: 'Conserva: {{parts}}.',
  keepsNothing: 'El servidor arranca como recién instalado.',
  ownerOnly: 'solo el dueño',
  newSeed: 'Usar una semilla de mundo nueva al azar',
  newSeedHelp: 'El mundo nuevo se genera con otra semilla. Dejalo apagado para generarlo con la misma.',
  preset: 'Preset de configuración del mundo',
  presetNone: 'Mantener la configuración actual del mundo',
  when: 'Cuándo',
  confirmLabel: 'Escribí {{name}} para confirmar',
  go: 'Reiniciar',
  warning: 'Se desconecta a todos los que estén jugando. Esto borra datos (antes se hace una copia).',
} satisfies Translations['reset'];
