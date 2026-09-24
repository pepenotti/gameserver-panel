import type { Translations } from '../en';

export default {
  title: 'Reiniciar',
  intro: 'Empezar de cero. Siempre se hace primero una copia de todo, así que un reinicio se puede deshacer desde Copias de seguridad.',
  scope: 'Qué reiniciar',
  scopes: {
    world: 'Mundo nuevo',
    worldHelp: 'Borra el mapa y todos los personajes. Conserva las cuentas, la lista blanca, los baneos, la configuración y los mods. Los jugadores crean personajes nuevos.',
    full: 'Mundo y cuentas nuevos',
    fullHelp: 'También borra las cuentas de los jugadores, la lista blanca, los baneos y los roles de administración. La configuración y los mods quedan.',
    factory: 'Restablecer de fábrica',
    factoryHelp: 'También borra toda la configuración del servidor y del mundo, y la lista de mods. El servidor arranca como recién instalado.',
  },
  ownerOnly: 'solo el dueño',
  newSeed: 'Usar una semilla de mundo nueva al azar',
  newSeedHelp: 'Cambia los detalles del terreno generado (bosques, recolección). Dejalo apagado para mantener el mismo mapa.',
  preset: 'Preset de configuración del mundo',
  presetNone: 'Mantener la configuración actual del mundo',
  when: 'Cuándo',
  confirmLabel: 'Escribí {{name}} para confirmar',
  go: 'Reiniciar',
  warning: 'Se desconecta a todos los que estén jugando. Esto borra datos (antes se hace una copia).',
} satisfies Translations['reset'];
