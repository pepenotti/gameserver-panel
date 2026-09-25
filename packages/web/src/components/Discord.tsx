// Discord notifications (SCH-03): the panel's webhook (a host setting) and
// each server's own override (its own webhook, language and switches, or
// the panel's).
import { Alert, Anchor, Button, Card, Checkbox, Group, SegmentedControl, Select, SimpleGrid, Stack, Text, TextInput } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';
import { api } from '../api/http';
import { useServerApi } from '../api/server';
import { useSession } from '../api/session';
import { useErrorText } from '../lib/format';

export const DISCORD_EVENTS = ['serverUp', 'serverDown', 'crash', 'playerJoin', 'playerLeave', 'backup', 'update', 'restore', 'reset', 'mods', 'security'] as const;
type DiscordEvent = (typeof DISCORD_EVENTS)[number];
type Events = Record<DiscordEvent, boolean>;
type Lang = 'en' | 'es';

/** `GET /api/notifications`: the panel's webhook (masked) and switches. */
interface HostView {
  webhookUrl: string | null;
  configured: boolean;
  lang: Lang;
  events: Events;
}

/** `GET /api/servers/:sid/notifications`: the server's override, the panel's settings, and what its messages use. */
interface OverrideView {
  override: { webhookUrl: string | null; lang: Lang | null; events: Partial<Events> };
  host: { configured: boolean; lang: Lang; events: Events };
  effective: { configured: boolean; lang: Lang; events: Events };
}

const LANGS = [
  { value: 'es', label: 'Español' },
  { value: 'en', label: 'English' },
];

function EventSwitches({ events, onChange, disabled }: { events: Partial<Events>; onChange: (e: Events) => void; disabled?: boolean }) {
  const { t } = useTranslation();
  const all = Object.fromEntries(DISCORD_EVENTS.map((e) => [e, events[e] === true])) as Events;
  return (
    <SimpleGrid cols={{ base: 1, sm: 2 }} spacing={6}>
      {DISCORD_EVENTS.map((e) => (
        <Checkbox key={e} size="sm" disabled={disabled} label={t(`discord.names.${e}`)} checked={all[e]} onChange={(ev) => onChange({ ...all, [e]: ev.currentTarget.checked })} />
      ))}
    </SimpleGrid>
  );
}

/** The panel's webhook: every server's messages go there unless the server has its own. */
export function HostDiscord() {
  const { t } = useTranslation();
  const errorText = useErrorText();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['notifications'], queryFn: () => api<HostView>('GET', '/api/notifications') });
  const [d, setD] = useState<HostView | null>(null);
  const [hook, setHook] = useState('');
  useEffect(() => {
    if (q.data) setD(q.data);
  }, [q.data]);
  const fail = (e: unknown) => notifications.show({ color: 'red', message: errorText(e) });
  const save = (extra: { webhookUrl?: string | null } = {}) =>
    d &&
    void api<HostView>('PUT', '/api/notifications', { lang: d.lang, events: d.events, ...(hook.trim() ? { webhookUrl: hook.trim() } : {}), ...extra }).then((r) => {
      qc.setQueryData(['notifications'], r);
      setHook('');
      notifications.show({ color: 'green', message: t('common.saved') });
    }, fail);

  if (q.error) return <Alert color="red">{errorText(q.error)}</Alert>;
  if (!d) return null;
  return (
    <Card withBorder>
      <Text fw={600}>{t('discord.title')}</Text>
      <Text size="xs" c="dimmed" mb="sm">
        {t('discord.hostHelp')} {t('discord.help')}
      </Text>
      <Stack>
        <TextInput
          label={t('discord.webhook')}
          description={d.configured ? t('discord.webhookKeep', { url: d.webhookUrl }) : undefined}
          placeholder="https://discord.com/api/webhooks/…"
          value={hook}
          onChange={(e) => setHook(e.currentTarget.value)}
        />
        <Group gap="xs">
          <Text size="sm">{t('discord.lang')}:</Text>
          <SegmentedControl size="xs" value={d.lang} onChange={(v) => setD({ ...d, lang: v as Lang })} data={LANGS} />
        </Group>
        <Text size="sm" fw={500}>
          {t('discord.events')}:
        </Text>
        <EventSwitches events={d.events} onChange={(events) => setD({ ...d, events })} />
        <Group>
          <Button onClick={() => save()}>{t('common.save')}</Button>
          <Button variant="default" disabled={!d.configured} onClick={() => void api('POST', '/api/notifications/test', {}).then(() => notifications.show({ color: 'green', message: t('discord.testOk') }), fail)}>
            {t('discord.test')}
          </Button>
          {d.configured && (
            <Button variant="subtle" color="red" onClick={() => save({ webhookUrl: null })}>
              {t('discord.remove')}
            </Button>
          )}
        </Group>
      </Stack>
    </Card>
  );
}

/**
 * One server's Discord (SCH-03): its own webhook (another channel),
 * language and switches, each falling back to the panel's. Every message
 * names the server.
 */
export function ServerDiscord() {
  const { t } = useTranslation();
  const errorText = useErrorText();
  const qc = useQueryClient();
  const sapi = useServerApi();
  const { canHost } = useSession();
  const key = ['notifications', sapi.sid];
  const q = useQuery({ queryKey: key, queryFn: () => sapi<OverrideView>('GET', '/notifications') });
  const [ownHook, setOwnHook] = useState(false);
  const [hook, setHook] = useState('');
  const [lang, setLang] = useState<Lang | null>(null);
  const [ownEvents, setOwnEvents] = useState(false);
  const [events, setEvents] = useState<Partial<Events>>({});
  const [error, setError] = useState<string | null>(null);

  const reset = (v: OverrideView) => {
    setOwnHook(v.override.webhookUrl !== null);
    setHook('');
    setLang(v.override.lang);
    setOwnEvents(Object.keys(v.override.events).length > 0);
    setEvents({ ...v.effective.events });
    setError(null);
  };
  useEffect(() => {
    if (q.data) reset(q.data);
  }, [q.data]);

  if (q.error) return <Alert color="red">{errorText(q.error)}</Alert>;
  const v = q.data;
  if (!v) return null;

  const needsUrl = ownHook && !hook.trim() && v.override.webhookUrl === null;
  const put = (body: { webhookUrl?: string | null; lang: Lang | null; events: Partial<Events> }) =>
    sapi<OverrideView>('PUT', '/notifications', body).then(
      (r) => {
        qc.setQueryData(key, r);
        notifications.show({ color: 'green', message: t('common.saved') });
      },
      (e: unknown) => setError(errorText(e)),
    );
  const save = () => {
    // Own webhook: a new one replaces it, none typed keeps it; the panel's: null.
    const webhookUrl = ownHook ? (hook.trim() ? hook.trim() : undefined) : null;
    void put({ ...(webhookUrl === undefined ? {} : { webhookUrl }), lang, events: ownEvents ? events : {} });
  };
  const overridden = v.override.webhookUrl !== null || v.override.lang !== null || Object.keys(v.override.events).length > 0;
  const hostLang = LANGS.find((x) => x.value === v.host.lang)?.label ?? v.host.lang;

  return (
    <Card withBorder>
      <Text fw={600}>{t('discord.serverTitle')}</Text>
      <Text size="xs" c="dimmed" mb="sm">
        {t('discord.serverHelp')}
      </Text>
      <Stack>
        <Alert variant="light" color={v.effective.configured ? 'blue' : 'gray'}>
          {v.effective.configured ? (v.override.webhookUrl ? t('discord.goesOwn') : t('discord.goesHost')) : t('discord.goesNowhere')}
          {canHost('notifications.manage') && (
            <>
              {' '}
              <Anchor component={Link} to="/settings" size="sm">
                {t('discord.hostLink')}
              </Anchor>
            </>
          )}
        </Alert>

        <Stack gap={6}>
          <Text size="sm" fw={500}>
            {t('discord.webhook')}
          </Text>
          <SegmentedControl
            value={ownHook ? 'own' : 'host'}
            onChange={(x) => setOwnHook(x === 'own')}
            data={[
              { value: 'host', label: v.host.configured ? t('discord.useHost') : t('discord.useHostNone') },
              { value: 'own', label: t('discord.useOwn') },
            ]}
            fullWidth
            maw={480}
          />
          {ownHook && (
            <TextInput
              description={v.override.webhookUrl ? t('discord.webhookKeep', { url: v.override.webhookUrl }) : t('discord.help')}
              placeholder="https://discord.com/api/webhooks/…"
              value={hook}
              onChange={(e) => setHook(e.currentTarget.value)}
              error={needsUrl ? t('discord.pasteUrl') : undefined}
            />
          )}
        </Stack>

        <Select
          label={t('discord.lang')}
          w={{ base: '100%', xs: 320 }}
          value={lang ?? 'host'}
          onChange={(x) => setLang(x === 'host' || x === null ? null : (x as Lang))}
          allowDeselect={false}
          data={[{ value: 'host', label: t('discord.sameAsHost', { lang: hostLang }) }, ...LANGS]}
        />

        <Stack gap={6}>
          <Checkbox label={t('discord.useHostEvents')} checked={!ownEvents} onChange={(e) => setOwnEvents(!e.currentTarget.checked)} />
          <EventSwitches events={ownEvents ? events : v.host.events} onChange={setEvents} disabled={!ownEvents} />
        </Stack>

        {error && (
          <Alert color="red" withCloseButton onClose={() => setError(null)}>
            {error}
          </Alert>
        )}
        <Group>
          <Button onClick={save} disabled={needsUrl}>
            {t('common.save')}
          </Button>
          <Button
            variant="default"
            disabled={!v.effective.configured}
            onClick={() => void sapi('POST', '/notifications/test', {}).then(() => notifications.show({ color: 'green', message: t('discord.testOk') }), (e: unknown) => setError(errorText(e)))}
          >
            {t('discord.test')}
          </Button>
          {overridden && (
            <Button variant="subtle" onClick={() => void put({ webhookUrl: null, lang: null, events: {} })}>
              {t('discord.useHostAll')}
            </Button>
          )}
        </Group>
      </Stack>
    </Card>
  );
}
