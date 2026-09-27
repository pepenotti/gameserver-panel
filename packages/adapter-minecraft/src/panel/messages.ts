import type { AgentCommand, AnnounceKind, Lang } from '@gsp/adapter-api';
import { RconProtocolError } from '@gsp/formats';

/**
 * Measured on 26.3: `say` takes at most 256 characters and refuses longer
 * messages ("Chat message was too long"); the panel refuses them first.
 */
export const SAY_MAX = 256;

/** In-game announcements: players read them in chat, so they stay short. */
const MSG: Record<Lang, Record<AnnounceKind | 'cancelled', string> & { min: (n: number) => string; sec: (n: number) => string }> = {
  es: {
    restart: 'El servidor se reinicia en {t}.',
    stop: 'El servidor se apaga en {t}.',
    update: 'El servidor se actualiza en {t}.',
    restore: 'El servidor se apaga en {t} para restaurar una copia de seguridad.',
    reset: 'El mundo se reinicia en {t}. Todo lo construido se va a perder.',
    cancelled: 'Se canceló el reinicio del servidor.',
    min: (n) => (n === 1 ? '1 minuto' : `${n} minutos`),
    sec: (n) => `${n} segundos`,
  },
  en: {
    restart: 'Server restarting in {t}.',
    stop: 'Server shutting down in {t}.',
    update: 'Server updating in {t}.',
    restore: 'Server shutting down in {t} to restore a backup.',
    reset: 'The world resets in {t}. Everything built will be lost.',
    cancelled: 'The server restart was cancelled.',
    min: (n) => (n === 1 ? '1 minute' : `${n} minutes`),
    sec: (n) => `${n} seconds`,
  },
};

export function minecraftAnnounce(kind: AnnounceKind | 'cancelled', secondsLeft: number, lang: Lang): string {
  const m = MSG[lang];
  if (kind === 'cancelled') return m.cancelled;
  const t = secondsLeft >= 60 ? m.min(Math.round(secondsLeft / 60)) : m.sec(secondsLeft);
  return m[kind].replace('{t}', t);
}

/** `say <text>` over RCON: one line of at most 256 characters, no control characters (CON-03). */
export function minecraftBroadcast(text: string): AgentCommand {
  const t = text.trim();
  if (t === '') throw new RconProtocolError('Empty message');
  // Counted as the game (Java) counts a string's length: UTF-16 code units.
  if (t.length > SAY_MAX) throw new RconProtocolError(`A message can have at most ${SAY_MAX} characters`);
  if (/[\x00-\x1f\x7f]/.test(t)) throw new RconProtocolError('The message contains a control character');
  return { command: `say ${t}`, via: 'rcon' };
}
