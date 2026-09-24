import type { Translations } from '../en';

export default {
  title: 'No disponible para este juego',
  body: '{{game}} no admite {{feature}}, así que acá no hay nada para hacer. El menú oculta páginas como esta.',
  thisGame: 'Este juego',
  or: ' ni ',
  error: 'Este juego no admite {{feature}}.',
  note: 'No se muestra porque {{game}} no lo admite: {{features}}.',
} satisfies Translations['support'];
