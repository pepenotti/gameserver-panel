import type { Settings } from '../settings';

export type NotifyEvent = 'serverUp' | 'serverDown' | 'crash' | 'playerJoin' | 'playerLeave' | 'backup' | 'update' | 'restore' | 'reset' | 'mods' | 'security';
export const NOTIFY_EVENTS: NotifyEvent[] = ['serverUp', 'serverDown', 'crash', 'playerJoin', 'playerLeave', 'backup', 'update', 'restore', 'reset', 'mods', 'security'];

export interface DiscordSettings {
  webhookUrl: string | null;
  lang: 'en' | 'es';
  events: Record<NotifyEvent, boolean>;
}

export const DISCORD_DEFAULTS: DiscordSettings = {
  webhookUrl: null,
  lang: 'es',
  events: { serverUp: true, serverDown: true, crash: true, playerJoin: true, playerLeave: false, backup: false, update: true, restore: true, reset: true, mods: true, security: true },
};

/** Only real Discord webhook URLs, so the panel can't be pointed at arbitrary hosts. */
const WEBHOOK = /^https:\/\/(?:ptb\.|canary\.)?discord(?:app)?\.com\/api\/webhooks\/\d{5,25}\/[\w-]{20,100}$/;

export function isWebhookUrl(url: string): boolean {
  return WEBHOOK.test(url);
}

export function maskWebhook(url: string | null): string | null {
  return url ? `${url.slice(0, url.lastIndexOf('/') + 1)}…${url.slice(-4)}` : null;
}

export interface Embed {
  title: string;
  description?: string;
  color: number;
}

const COLOR = { green: 0x2f9e44, red: 0xe03131, orange: 0xf08c00, blue: 0x1c7ed6, gray: 0x868e96 };

type Msg = (p: Record<string, string>) => Embed;

/** A server's message says which server it is about (one webhook may serve several). */
function named(e: Embed, server: string | null): Embed {
  return server ? { ...e, title: `${e.title} · ${server}` } : e;
}

/** Message catalogue, one entry per event kind, in both languages. */
export const MESSAGES: Record<'en' | 'es', Record<string, Msg>> = {
  en: {
    serverUp: () => ({ title: '🟢 Server online', description: 'The server is up. Come on in!', color: COLOR.green }),
    serverDown: (p) => ({ title: '🔴 Server offline', description: p.reason ? `Stopped: ${p.reason}` : 'The server was stopped.', color: COLOR.gray }),
    crash: (p) => ({ title: '💥 Server problem', description: p.message, color: COLOR.red }),
    playerJoin: (p) => ({ title: `➡️ ${p.name} joined`, color: COLOR.blue }),
    playerLeave: (p) => ({ title: `⬅️ ${p.name} left`, color: COLOR.gray }),
    backup: (p) => ({ title: p.ok === 'true' ? '💾 Backup done' : '⚠️ Backup failed', description: p.detail, color: p.ok === 'true' ? COLOR.green : COLOR.red }),
    update: (p) => ({ title: p.ok === 'true' ? '⬆️ Game updated' : '⚠️ Update failed', description: p.detail, color: p.ok === 'true' ? COLOR.green : COLOR.red }),
    updateAvailable: (p) => ({ title: '⬆️ Game update available', description: p.detail, color: COLOR.orange }),
    restore: (p) => ({ title: p.ok === 'true' ? '♻️ Backup restored' : '⚠️ Restore failed', description: p.detail, color: p.ok === 'true' ? COLOR.orange : COLOR.red }),
    reset: (p) => ({ title: p.ok === 'true' ? '🧟 World reset' : '⚠️ Reset failed', description: p.detail, color: p.ok === 'true' ? COLOR.orange : COLOR.red }),
    mods: (p) => ({ title: '🧩 Mods', description: p.detail, color: COLOR.blue }),
    security: (p) => ({ title: '🛡️ Security', description: p.detail, color: COLOR.red }),
    test: () => ({ title: '✅ Test message', description: 'Discord notifications from the game server panel work.', color: COLOR.green }),
  },
  es: {
    serverUp: () => ({ title: '🟢 Servidor en línea', description: 'El servidor está prendido. ¡A jugar!', color: COLOR.green }),
    serverDown: (p) => ({ title: '🔴 Servidor apagado', description: p.reason ? `Se apagó: ${p.reason}` : 'Se apagó el servidor.', color: COLOR.gray }),
    crash: (p) => ({ title: '💥 Problema en el servidor', description: p.message, color: COLOR.red }),
    playerJoin: (p) => ({ title: `➡️ Entró ${p.name}`, color: COLOR.blue }),
    playerLeave: (p) => ({ title: `⬅️ Salió ${p.name}`, color: COLOR.gray }),
    backup: (p) => ({ title: p.ok === 'true' ? '💾 Copia de seguridad lista' : '⚠️ Falló la copia de seguridad', description: p.detail, color: p.ok === 'true' ? COLOR.green : COLOR.red }),
    update: (p) => ({ title: p.ok === 'true' ? '⬆️ Juego actualizado' : '⚠️ Falló la actualización', description: p.detail, color: p.ok === 'true' ? COLOR.green : COLOR.red }),
    updateAvailable: (p) => ({ title: '⬆️ Hay una actualización del juego', description: p.detail, color: COLOR.orange }),
    restore: (p) => ({ title: p.ok === 'true' ? '♻️ Se restauró una copia' : '⚠️ Falló la restauración', description: p.detail, color: p.ok === 'true' ? COLOR.orange : COLOR.red }),
    reset: (p) => ({ title: p.ok === 'true' ? '🧟 Mundo reiniciado' : '⚠️ Falló el reinicio del mundo', description: p.detail, color: p.ok === 'true' ? COLOR.orange : COLOR.red }),
    mods: (p) => ({ title: '🧩 Mods', description: p.detail, color: COLOR.blue }),
    security: (p) => ({ title: '🛡️ Seguridad', description: p.detail, color: COLOR.red }),
    test: () => ({ title: '✅ Mensaje de prueba', description: 'Las notificaciones de Discord del panel de servidores funcionan.', color: COLOR.green }),
  },
};

type Fetch = typeof fetch;

/**
 * One server's own Discord settings over the host's (SCH-03, server setting
 * `discord.override`): its own webhook (another channel), language and
 * event switches. What it leaves out follows the host.
 */
export interface DiscordOverride {
  /** Its own webhook; null: the host's. */
  webhookUrl: string | null;
  /** The language of its messages; null: the host's. */
  lang: 'en' | 'es' | null;
  /** Switches over the host's; an event left out follows the host. */
  events: Partial<Record<NotifyEvent, boolean>>;
}

/** The server setting that holds a server's `DiscordOverride`. */
export const DISCORD_OVERRIDE_KEY = 'discord.override';

export const NO_OVERRIDE: DiscordOverride = { webhookUrl: null, lang: null, events: {} };

/** What sends one server's (or the host's) messages. */
export interface Notify {
  /** Queue a message for `event` if it is switched on. `kind` picks the text (defaults to the event). */
  notify(event: NotifyEvent, params?: Record<string, string>, kind?: string): void;
}

/**
 * Posts embeds to a Discord webhook through a small queue that honours
 * Discord's rate limits (429 + retry_after) and drops messages rather than
 * growing without bound when Discord is down. One per panel: each server
 * notifies through `forServer`, which applies its override and names it.
 */
export class DiscordNotifier implements Notify {
  private queue: { url: string; embed: Embed }[] = [];
  private sending = false;
  private recent: number[] = [];

  constructor(
    private readonly settings: Settings,
    private readonly doFetch: Fetch = fetch,
  ) {}

  /** The host's settings. */
  config(): DiscordSettings {
    const s = this.settings.getRaw<Partial<DiscordSettings>>('discord');
    return { ...DISCORD_DEFAULTS, ...s, events: { ...DISCORD_DEFAULTS.events, ...(s?.events ?? {}) } };
  }

  save(next: DiscordSettings): void {
    this.settings.setRaw('discord', next);
  }

  /** The host's settings under a server's override. */
  effective(o: DiscordOverride | null): DiscordSettings {
    const c = this.config();
    if (!o) return c;
    return { webhookUrl: o.webhookUrl ?? c.webhookUrl, lang: o.lang ?? c.lang, events: { ...c.events, ...o.events } };
  }

  /** Host messages (security): the host's settings, no server named. */
  notify(event: NotifyEvent, params: Record<string, string> = {}, kind: string = event): void {
    this.send(this.config(), null, event, params, kind);
  }

  /** A server's messages: its override over the host's settings, each naming the server. */
  forServer(s: { name: () => string; override: () => DiscordOverride | null }): Notify {
    return { notify: (event, params = {}, kind = event) => this.send(this.effective(s.override()), s.name(), event, params, kind) };
  }

  private send(c: DiscordSettings, server: string | null, event: NotifyEvent, params: Record<string, string>, kind: string): void {
    if (!c.webhookUrl || !c.events[event]) return;
    const msg = MESSAGES[c.lang][kind];
    if (!msg) return;
    this.enqueue(c.webhookUrl, named(msg(params), server));
  }

  /** Send the test message right away with these settings (default: the host's) and report the result. */
  async test(c: DiscordSettings = this.config(), server: string | null = null): Promise<{ ok: boolean; status: number }> {
    if (!c.webhookUrl) return { ok: false, status: 0 };
    const res = await this.post(c.webhookUrl, named(MESSAGES[c.lang].test!({}), server));
    return { ok: res.ok, status: res.status };
  }

  private enqueue(url: string, embed: Embed): void {
    if (this.queue.length >= 100) return;
    this.queue.push({ url, embed });
    void this.pump();
  }

  private post(url: string, embed: Embed): Promise<Response> {
    return this.doFetch(`${url}?wait=true`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'Game Server Panel', embeds: [{ ...embed, timestamp: new Date().toISOString() }], allowed_mentions: { parse: [] } }),
      signal: AbortSignal.timeout(10_000),
    });
  }

  private async pump(): Promise<void> {
    if (this.sending) return;
    this.sending = true;
    try {
      while (this.queue.length) {
        // Stay well under Discord's ~30 messages/minute per webhook.
        const now = Date.now();
        this.recent = this.recent.filter((t) => now - t < 60_000);
        if (this.recent.length >= 25) await new Promise((r) => setTimeout(r, 60_000 - (now - this.recent[0]!)));
        const item = this.queue.shift()!;
        try {
          const res = await this.post(item.url, item.embed);
          this.recent.push(Date.now());
          if (res.status === 429) {
            const body = (await res.json().catch(() => ({}))) as { retry_after?: number };
            this.queue.unshift(item);
            await new Promise((r) => setTimeout(r, Math.min((body.retry_after ?? 2) * 1000, 60_000)));
          }
        } catch {
          // Discord unreachable: drop this one.
        }
      }
    } finally {
      this.sending = false;
    }
  }

  /** Test helper. */
  async drain(): Promise<void> {
    while (this.sending || this.queue.length) await new Promise((r) => setTimeout(r, 5));
  }
}
