import type { FastifyInstance } from 'fastify';
import { DISCORD_OVERRIDE_KEY, isWebhookUrl, maskWebhook, NO_OVERRIDE, NOTIFY_EVENTS, type DiscordOverride, type DiscordSettings } from '../notifier/discord';
import type { ScheduleSettings } from '../scheduler/scheduler';
import { by, HttpError, srvOf } from '../http/context';
import type { Deps } from '../http/deps';

const policy = { enum: ['when-empty', 'restart-countdown', 'notify-only'] } as const;

export function scheduleRoutes(app: FastifyInstance, deps: Deps): void {
  const { audit } = deps;
  const next = (s: ReturnType<typeof srvOf>) => ({ ...s.scheduler.nextRuns(), ...deps.hostJobs.nextRuns() });

  app.get('/schedules', { config: { permission: 'schedules.view' } }, async (req) => {
    const s = srvOf(req);
    return { settings: s.scheduler.config(), next: next(s) };
  });

  app.put<{ Body: ScheduleSettings }>(
    '/schedules',
    {
      config: { permission: 'schedules.manage' },
      schema: {
        body: {
          type: 'object',
          required: ['timezone', 'lang', 'restarts', 'backups', 'gameUpdates', 'modUpdates'],
          additionalProperties: false,
          properties: {
            timezone: { type: 'string', maxLength: 64, pattern: '^[A-Za-z0-9_+/-]+$' },
            lang: { enum: ['en', 'es'] },
            restarts: {
              type: 'object',
              required: ['enabled', 'times', 'countdownSec', 'backupWhileStopped'],
              additionalProperties: false,
              properties: {
                enabled: { type: 'boolean' },
                times: { type: 'array', maxItems: 6, uniqueItems: true, items: { type: 'string', pattern: '^([01]\\d|2[0-3]):[0-5]\\d$' } },
                countdownSec: { enum: [0, 60, 300, 600, 900] },
                backupWhileStopped: { type: 'boolean' },
              },
            },
            backups: {
              type: 'object',
              required: ['enabled', 'everyHours'],
              additionalProperties: false,
              properties: { enabled: { type: 'boolean' }, everyHours: { type: 'integer', enum: [1, 2, 3, 4, 6, 8, 12, 24] } },
            },
            gameUpdates: {
              type: 'object',
              required: ['enabled', 'checkEveryMinutes', 'apply'],
              additionalProperties: false,
              properties: { enabled: { type: 'boolean' }, checkEveryMinutes: { type: 'integer', minimum: 5, maximum: 59 }, apply: policy },
            },
            modUpdates: {
              type: 'object',
              required: ['enabled', 'checkEveryMinutes', 'apply'],
              additionalProperties: false,
              properties: { enabled: { type: 'boolean' }, checkEveryMinutes: { type: 'integer', minimum: 5, maximum: 59 }, apply: policy },
            },
          },
        },
      },
    },
    async (req) => {
      const s = srvOf(req);
      try {
        s.scheduler.save(req.body);
      } catch (e) {
        throw new HttpError(400, 'invalid-schedule', (e as Error).message, { message: (e as Error).message });
      }
      audit.log({ ...by(req), action: 'schedules.update', detail: req.body });
      return { settings: s.scheduler.config(), next: next(s) };
    },
  );

  // ------------------------------------------ this server's Discord (SCH-03)

  const { notifier } = deps;
  const stored = (s: ReturnType<typeof srvOf>): DiscordOverride => ({ ...NO_OVERRIDE, ...s.settings.getRaw<DiscordOverride>(DISCORD_OVERRIDE_KEY) });
  /** Its override (webhook masked), the host's settings it falls back on, and what its messages use. */
  const overrideView = (s: ReturnType<typeof srvOf>) => {
    const o = stored(s);
    const host = notifier.config();
    const eff = notifier.effective(o);
    return {
      override: { ...o, webhookUrl: maskWebhook(o.webhookUrl) },
      host: { configured: !!host.webhookUrl, lang: host.lang, events: host.events },
      effective: { configured: !!eff.webhookUrl, lang: eff.lang, events: eff.events },
    };
  };

  app.get('/notifications', { config: { permission: 'notifications.manage' } }, async (req) => overrideView(srvOf(req)));

  app.put<{ Body: { webhookUrl?: string | null; lang: 'en' | 'es' | null; events: DiscordOverride['events'] } }>(
    '/notifications',
    {
      config: { permission: 'notifications.manage' },
      schema: {
        body: {
          type: 'object',
          required: ['lang', 'events'],
          additionalProperties: false,
          properties: {
            // Omit to keep its own webhook (only ever shown masked); null: use the host's.
            webhookUrl: { type: 'string', nullable: true, maxLength: 300 },
            lang: { enum: ['en', 'es', null] },
            // Events left out follow the host's switches.
            events: { type: 'object', additionalProperties: false, properties: Object.fromEntries(NOTIFY_EVENTS.map((e) => [e, { type: 'boolean' }])) },
          },
        },
      },
    },
    async (req) => {
      const s = srvOf(req);
      const cur = stored(s);
      let webhookUrl = cur.webhookUrl;
      if (req.body.webhookUrl === null) webhookUrl = null;
      else if (typeof req.body.webhookUrl === 'string' && req.body.webhookUrl.trim() !== '') {
        const url = req.body.webhookUrl.trim();
        if (!isWebhookUrl(url)) throw new HttpError(400, 'invalid-webhook');
        webhookUrl = url;
      }
      s.settings.setRaw<DiscordOverride>(DISCORD_OVERRIDE_KEY, { webhookUrl, lang: req.body.lang, events: req.body.events });
      audit.log({ ...by(req), action: 'notifications.update', detail: { lang: req.body.lang, events: req.body.events, webhookChanged: webhookUrl !== cur.webhookUrl } });
      return overrideView(s);
    },
  );

  /** The test message, where this server's messages go, naming it. */
  app.post('/notifications/test', { config: { permission: 'notifications.manage' } }, async (req) => {
    const s = srvOf(req);
    const r = await notifier.test(notifier.effective(stored(s)), s.row.name).catch(() => ({ ok: false, status: 0 }));
    if (!r.ok) throw new HttpError(502, 'webhook-failed', undefined, { status: r.status });
    return { ok: true };
  });
}

/**
 * The Discord webhook (SCH-03): one for the host, so these are host routes;
 * `notifications.manage` is checked as "on every server". A server's own
 * override (`discord.override`) is `/api/servers/:sid/notifications` (above).
 */
export function notificationRoutes(app: FastifyInstance, deps: Deps): void {
  const { audit, notifier } = deps;
  const view = () => {
    const c = notifier.config();
    return { ...c, webhookUrl: maskWebhook(c.webhookUrl), configured: !!c.webhookUrl };
  };

  app.get('/api/notifications', { config: { permission: 'notifications.manage' } }, async () => view());

  app.put<{ Body: { webhookUrl?: string | null; lang: 'en' | 'es'; events: DiscordSettings['events'] } }>(
    '/api/notifications',
    {
      config: { permission: 'notifications.manage' },
      schema: {
        body: {
          type: 'object',
          required: ['lang', 'events'],
          additionalProperties: false,
          properties: {
            // Omit to keep the current webhook (the UI only ever sees it masked); null removes it.
            webhookUrl: { type: 'string', nullable: true, maxLength: 300 },
            lang: { enum: ['en', 'es'] },
            events: { type: 'object', additionalProperties: false, properties: Object.fromEntries(NOTIFY_EVENTS.map((e) => [e, { type: 'boolean' }])) },
          },
        },
      },
    },
    async (req) => {
      const cur = notifier.config();
      let webhookUrl = cur.webhookUrl;
      if (req.body.webhookUrl === null) webhookUrl = null;
      else if (typeof req.body.webhookUrl === 'string' && req.body.webhookUrl.trim() !== '') {
        const url = req.body.webhookUrl.trim();
        if (!isWebhookUrl(url)) throw new HttpError(400, 'invalid-webhook');
        webhookUrl = url;
      }
      notifier.save({ webhookUrl, lang: req.body.lang, events: { ...cur.events, ...req.body.events } });
      audit.log({ ...by(req), action: 'notifications.update', detail: { lang: req.body.lang, events: req.body.events, webhookChanged: webhookUrl !== cur.webhookUrl } });
      return view();
    },
  );

  app.post('/api/notifications/test', { config: { permission: 'notifications.manage' } }, async () => {
    const r = await notifier.test().catch(() => ({ ok: false, status: 0 }));
    if (!r.ok) throw new HttpError(502, 'webhook-failed', undefined, { status: r.status });
    return { ok: true };
  });
}
