import type { AgentCommand, AnnounceKind, Lang } from '@gsp/adapter-api';
import { quoteArg } from '@gsp/formats';

/** In-game announcements: players read them in chat, so they stay short. */
const MSG: Record<Lang, Record<AnnounceKind | 'cancelled', string> & { min: (n: number) => string; sec: (n: number) => string }> = {
  es: {
    restart: 'El servidor se reinicia en {t}. Busquen un lugar seguro.',
    stop: 'El servidor se apaga en {t}. Busquen un lugar seguro.',
    update: 'El servidor se actualiza en {t}. Busquen un lugar seguro.',
    restore: 'El servidor se apaga en {t} para restaurar una copia de seguridad.',
    reset: 'El mundo se reinicia en {t}. Todo lo construido se va a perder.',
    cancelled: 'Se canceló el reinicio del servidor.',
    min: (n) => (n === 1 ? '1 minuto' : `${n} minutos`),
    sec: (n) => `${n} segundos`,
  },
  en: {
    restart: 'Server restarting in {t}. Find somewhere safe.',
    stop: 'Server shutting down in {t}. Find somewhere safe.',
    update: 'Server updating in {t}. Find somewhere safe.',
    restore: 'Server shutting down in {t} to restore a backup.',
    reset: 'The world resets in {t}. Everything built will be lost.',
    cancelled: 'The server restart was cancelled.',
    min: (n) => (n === 1 ? '1 minute' : `${n} minutes`),
    sec: (n) => `${n} seconds`,
  },
};

export function pzAnnounce(kind: AnnounceKind | 'cancelled', secondsLeft: number, lang: Lang): string {
  const m = MSG[lang];
  if (kind === 'cancelled') return m.cancelled;
  const t = secondsLeft >= 60 ? m.min(Math.round(secondsLeft / 60)) : m.sec(secondsLeft);
  return m[kind].replace('{t}', t);
}

/** `servermsg "…"` over RCON; quotes and line breaks are refused (RconProtocolError). */
export function pzBroadcast(text: string): AgentCommand {
  return { command: `servermsg ${quoteArg(text, 'message')}`, via: 'rcon' };
}
