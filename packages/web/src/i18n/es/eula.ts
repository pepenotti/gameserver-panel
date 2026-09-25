import type { Translations } from '../en';

export default {
  pendingTitle: 'Licencia sin aceptar',
  pending: '{{game}} necesita que se acepte su licencia (EULA) antes de que este servidor pueda iniciar.',
  review: 'Leer y aceptar la licencia',
  ownerOnly: 'Solo el dueño de este panel puede aceptarla: pedile que abra este servidor.',
  dialogTitle: 'Licencia del juego (EULA)',
  dialogIntro: 'Antes de que {{game}} pueda correr acá, el dueño de este panel acepta su licencia. Leela primero:',
  dialogNote: 'El panel registra quién la aceptó y cuándo. Nunca acepta una licencia en nombre de nadie.',
  confirm: 'Leí la licencia y la acepto para este servidor.',
  accept: 'Aceptar',
  done: 'Licencia aceptada. El servidor ya puede iniciar.',
  accepted: 'Licencia aceptada por {{by}} el {{when}}:',
  someone: 'una cuenta eliminada',
} satisfies Translations['eula'];
