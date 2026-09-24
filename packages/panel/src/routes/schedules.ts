import type { FastifyInstance } from 'fastify';
import { isWebhookUrl, maskWebhook, NOTIFY_EVENTS, type DiscordSettings } from '../notifier/discord';
import type { ScheduleSettings } from '../scheduler/scheduler';
import { actor, HttpError } from '../http/context';
import type { Deps } from '../http/deps';

const policy = { enum: ['when-empty', 'restart-countdown', 'notify-only'] } as const;

export function scheduleRoutes(app: FastifyInstance, deps: Deps): void {
  const { scheduler, notifier, audit } = deps;

  app.get('/api/schedules', { config: { permission: 'schedules.view' } }, async () => ({ settings: scheduler.config(), next: scheduler.nextRuns() }));

  app.put<{ Body: ScheduleSettings }>(
    '/api/schedules',
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
      try {
        scheduler.save(req.body);
      } catch (e) {
        throw new HttpError(400, 'invalid-schedule', (e as Error).message, { message: (e as Error).message });
      }
      audit.log({ user: actor(req), action: 'schedules.update', detail: req.body, ip: req.ip });
      return { settings: scheduler.config(), next: scheduler.nextRuns() };
    },
  );

  // ----------------------------------------------------------- Discord
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
      audit.log({ user: actor(req), action: 'notifications.update', detail: { lang: req.body.lang, events: req.body.events, webhookChanged: webhookUrl !== cur.webhookUrl }, ip: req.ip });
      return view();
    },
  );

  app.post('/api/notifications/test', { config: { permission: 'notifications.manage' } }, async () => {
    const r = await notifier.test().catch(() => ({ ok: false, status: 0 }));
    if (!r.ok) throw new HttpError(502, 'webhook-failed', undefined, { status: r.status });
    return { ok: true };
  });
}
