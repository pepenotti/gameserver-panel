/**
 * Messages to players (CON-03, CON-04), as measured: `say <text>` on the
 * console of every flavour (vanilla and tModLoader print `<Server> <text>`,
 * TShock broadcasts it; UTF-8 came through), and TShock's REST broadcast
 * (`tshock-broadcast`, the runtime's action), which TShock takes up to its
 * chat limit of 500 characters (`MaximumChatMessageLength`'s default).
 */
import type { AgentCommand, AnnounceKind, Lang, ServerCtx } from '@gsp/adapter-api';
import { RconProtocolError } from '@gsp/formats';

/** The longest message the panel sends: TShock's default chat limit, which vanilla's console takes too. */
export const SAY_MAX = 500;

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

export function terrariaAnnounce(kind: AnnounceKind | 'cancelled', secondsLeft: number, lang: Lang): string {
  const m = MSG[lang];
  if (kind === 'cancelled') return m.cancelled;
  const t = secondsLeft >= 60 ? m.min(Math.round(secondsLeft / 60)) : m.sec(secondsLeft);
  return m[kind].replace('{t}', t);
}

/** A message as the game takes it: one line of text, trimmed, not too long. */
export function sayText(text: string): string {
  const t = text.trim();
  if (t === '') throw new RconProtocolError('Empty message');
  // Counted as the runtime's action counts it (UTF-16 code units).
  if (t.length > SAY_MAX) throw new RconProtocolError(`A message can have at most ${SAY_MAX} characters`);
  if (/[\x00-\x1f\x7f]/.test(t)) throw new RconProtocolError('The message contains a control character');
  return t;
}

/** `say <text>` on the console, which every flavour takes. */
export function terrariaBroadcast(text: string): AgentCommand {
  return { command: `say ${sayText(text)}`, via: 'stdin' };
}

/**
 * TShock through its REST API (CON-04), so nothing is typed on its console
 * (which logs every command); the others on the console.
 */
export async function terrariaSend(ctx: ServerCtx, text: string): Promise<void> {
  const message = sayText(text);
  if (ctx.srv.flavour !== 'tshock') {
    await ctx.command(terrariaBroadcast(message));
    return;
  }
  const r = (await ctx.action('tshock-broadcast', { message })) as { ok?: unknown; message?: unknown } | null;
  if (r && r.ok === false) throw new Error(`TShock did not send the message: ${typeof r.message === 'string' ? r.message : 'no reason given'}`);
}
