import { ActionIcon, Badge, Button, Card, Checkbox, Group, NumberInput, SegmentedControl, Select, SimpleGrid, Stack, Switch, Text, TextInput, Title } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { IconPlus, IconX } from '@tabler/icons-react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { get, post, put } from '../api/http';
import { useSession } from '../api/session';
import { formatDateTime, useErrorText } from '../lib/format';

type Policy = 'when-empty' | 'restart-countdown' | 'notify-only';
interface ScheduleSettings {
  timezone: string;
  lang: 'en' | 'es';
  restarts: { enabled: boolean; times: string[]; countdownSec: number; backupWhileStopped: boolean };
  backups: { enabled: boolean; everyHours: number };
  gameUpdates: { enabled: boolean; checkEveryMinutes: number; apply: Policy };
  modUpdates: { enabled: boolean; checkEveryMinutes: number; apply: Policy };
}
interface NextRuns {
  restart: string | null;
  backup: string | null;
  gameCheck: string | null;
  modCheck: string | null;
}
const EVENTS = ['serverUp', 'serverDown', 'crash', 'playerJoin', 'playerLeave', 'backup', 'update', 'restore', 'reset', 'mods', 'security'] as const;
interface DiscordView {
  webhookUrl: string | null;
  configured: boolean;
  lang: 'en' | 'es';
  events: Record<(typeof EVENTS)[number], boolean>;
}

// Every zone the browser knows (searchable in the select); older browsers get UTC only.
const ZONES: string[] = ['UTC', ...(typeof Intl.supportedValuesOf === 'function' ? Intl.supportedValuesOf('timeZone').filter((z) => z !== 'UTC') : [])];

function Section({ title, help, enabled, onToggle, next, children }: { title: string; help: string; enabled: boolean; onToggle?: (v: boolean) => void; next: string | null; children: ReactNode }) {
  const { t, i18n } = useTranslation();
  return (
    <Card withBorder>
      <Group justify="space-between" align="flex-start" wrap="nowrap" mb={4}>
        <Group gap="xs">
          <Text fw={600}>{title}</Text>
          <Badge variant="light" color={enabled ? 'green' : 'gray'}>
            {enabled && next ? t('schedules.next', { when: formatDateTime(next, i18n.language, false) }) : t('schedules.off')}
          </Badge>
        </Group>
        <Switch checked={enabled} onChange={(e) => onToggle?.(e.currentTarget.checked)} disabled={!onToggle} aria-label={title} />
      </Group>
      <Text size="xs" c="dimmed" mb="sm">
        {help}
      </Text>
      {enabled && children}
    </Card>
  );
}

export function Schedules() {
  const { t } = useTranslation();
  const errorText = useErrorText();
  const qc = useQueryClient();
  const { can } = useSession();
  const editable = can('schedules.manage');
  const q = useQuery({ queryKey: ['schedules'], queryFn: () => get<{ settings: ScheduleSettings; next: NextRuns }>('/api/schedules') });
  const discord = useQuery({ queryKey: ['notifications'], queryFn: () => get<DiscordView>('/api/notifications'), enabled: can('notifications.manage') });
  const [s, setS] = useState<ScheduleSettings | null>(null);
  const [d, setD] = useState<DiscordView | null>(null);
  const [hook, setHook] = useState('');
  const [newTime, setNewTime] = useState('');

  useEffect(() => {
    if (q.data) setS(q.data.settings);
  }, [q.data]);
  useEffect(() => {
    if (discord.data) setD(discord.data);
  }, [discord.data]);

  const fail = (e: unknown) => notifications.show({ color: 'red', message: errorText(e) });
  const saveSchedules = () =>
    s &&
    void put<{ settings: ScheduleSettings; next: NextRuns }>('/api/schedules', s).then((r) => {
      qc.setQueryData(['schedules'], r);
      notifications.show({ color: 'green', message: t('schedules.saved') });
    }, fail);
  const saveDiscord = (extra: { webhookUrl?: string | null } = {}) =>
    d &&
    void put<DiscordView>('/api/notifications', { lang: d.lang, events: d.events, ...(hook.trim() ? { webhookUrl: hook.trim() } : {}), ...extra }).then((r) => {
      qc.setQueryData(['notifications'], r);
      setHook('');
      notifications.show({ color: 'green', message: t('common.saved') });
    }, fail);

  if (!s) return null;
  const policySelect = (value: Policy, onChange: (p: Policy) => void) => (
    <Select label={t('schedules.apply')} value={value} onChange={(v) => v && onChange(v as Policy)} allowDeselect={false} disabled={!editable} data={(['when-empty', 'restart-countdown', 'notify-only'] as Policy[]).map((p) => ({ value: p, label: t(`schedules.policies.${p}`) }))} />
  );

  return (
    <Stack maw={820}>
      <Title order={2}>{t('schedules.title')}</Title>
      <SimpleGrid cols={{ base: 1, sm: 2 }}>
        <Select label={t('schedules.timezone')} data={Array.from(new Set([s.timezone, ...ZONES]))} value={s.timezone} onChange={(v) => v && setS({ ...s, timezone: v })} searchable disabled={!editable} allowDeselect={false} />
        <Stack gap={4}>
          <Text size="sm" fw={500}>
            {t('schedules.gameLang')}
          </Text>
          <SegmentedControl value={s.lang} onChange={(v) => setS({ ...s, lang: v as 'en' | 'es' })} data={[{ value: 'es', label: 'Español' }, { value: 'en', label: 'English' }]} disabled={!editable} />
        </Stack>
      </SimpleGrid>

      <Section title={t('schedules.restarts')} help={t('schedules.restartsHelp')} enabled={s.restarts.enabled} onToggle={editable ? (v) => setS({ ...s, restarts: { ...s.restarts, enabled: v } }) : undefined} next={q.data?.next.restart ?? null}>
        <Stack gap="sm">
          <Group gap="xs">
            {s.restarts.times.map((time) => (
              <Badge key={time} size="lg" variant="outline" rightSection={editable && s.restarts.times.length > 1 ? <ActionIcon size="xs" variant="transparent" onClick={() => setS({ ...s, restarts: { ...s.restarts, times: s.restarts.times.filter((x) => x !== time) } })}><IconX size={12} /></ActionIcon> : undefined}>
                {time}
              </Badge>
            ))}
            {editable && s.restarts.times.length < 6 && (
              <Group gap={4}>
                <TextInput size="xs" w={80} placeholder="18:00" value={newTime} onChange={(e) => setNewTime(e.currentTarget.value)} />
                <ActionIcon
                  variant="light"
                  disabled={!/^([01]\d|2[0-3]):[0-5]\d$/.test(newTime) || s.restarts.times.includes(newTime)}
                  onClick={() => {
                    setS({ ...s, restarts: { ...s.restarts, times: [...s.restarts.times, newTime].sort() } });
                    setNewTime('');
                  }}
                  aria-label={t('schedules.addTime')}
                >
                  <IconPlus size={14} />
                </ActionIcon>
              </Group>
            )}
          </Group>
          <Group gap="xs">
            <Text size="sm">{t('schedules.warnFor')}:</Text>
            <SegmentedControl
              size="xs"
              disabled={!editable}
              value={String(s.restarts.countdownSec)}
              onChange={(v) => setS({ ...s, restarts: { ...s.restarts, countdownSec: Number(v) } })}
              data={[0, 60, 300, 600, 900].map((n) => ({ value: String(n), label: n === 0 ? t('controls.now') : t('schedules.minutes', { n: n / 60 }) }))}
            />
          </Group>
          <Checkbox label={t('schedules.backupWhileStopped')} description={t('schedules.backupWhileStoppedHelp')} checked={s.restarts.backupWhileStopped} disabled={!editable} onChange={(e) => setS({ ...s, restarts: { ...s.restarts, backupWhileStopped: e.currentTarget.checked } })} />
        </Stack>
      </Section>

      <Section title={t('schedules.backups')} help={t('schedules.backupsHelp')} enabled={s.backups.enabled} onToggle={editable ? (v) => setS({ ...s, backups: { ...s.backups, enabled: v } }) : undefined} next={q.data?.next.backup ?? null}>
        <Select w={200} value={String(s.backups.everyHours)} disabled={!editable} allowDeselect={false} onChange={(v) => v && setS({ ...s, backups: { ...s.backups, everyHours: Number(v) } })} data={[1, 2, 3, 4, 6, 8, 12, 24].map((n) => ({ value: String(n), label: t('schedules.everyHours', { n }) }))} />
      </Section>

      {(['gameUpdates', 'modUpdates'] as const).map((k) => (
        <Section key={k} title={t(`schedules.${k}`)} help={t(`schedules.${k}Help`)} enabled={s[k].enabled} onToggle={editable ? (v) => setS({ ...s, [k]: { ...s[k], enabled: v } }) : undefined} next={q.data?.next[k === 'gameUpdates' ? 'gameCheck' : 'modCheck'] ?? null}>
          <SimpleGrid cols={{ base: 1, sm: 2 }}>
            <NumberInput label={t('schedules.checkEvery')} min={5} max={59} value={s[k].checkEveryMinutes} disabled={!editable} onChange={(v) => setS({ ...s, [k]: { ...s[k], checkEveryMinutes: Number(v) || 30 } })} />
            {policySelect(s[k].apply, (p) => setS({ ...s, [k]: { ...s[k], apply: p } }))}
          </SimpleGrid>
        </Section>
      ))}

      {editable && (
        <Group>
          <Button onClick={saveSchedules} disabled={JSON.stringify(s) === JSON.stringify(q.data?.settings)}>
            {t('common.save')}
          </Button>
        </Group>
      )}

      {d && (
        <Card withBorder>
          <Text fw={600}>{t('discord.title')}</Text>
          <Text size="xs" c="dimmed" mb="sm">
            {t('discord.help')}
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
              <SegmentedControl size="xs" value={d.lang} onChange={(v) => setD({ ...d, lang: v as 'en' | 'es' })} data={[{ value: 'es', label: 'Español' }, { value: 'en', label: 'English' }]} />
            </Group>
            <Text size="sm" fw={500}>
              {t('discord.events')}:
            </Text>
            <SimpleGrid cols={{ base: 1, sm: 2 }} spacing={6}>
              {EVENTS.map((e) => (
                <Checkbox key={e} size="sm" label={t(`discord.names.${e}`)} checked={d.events[e]} onChange={(ev) => setD({ ...d, events: { ...d.events, [e]: ev.currentTarget.checked } })} />
              ))}
            </SimpleGrid>
            <Group>
              <Button onClick={() => saveDiscord()}>{t('common.save')}</Button>
              <Button variant="default" disabled={!d.configured} onClick={() => void post('/api/notifications/test').then(() => notifications.show({ color: 'green', message: t('discord.testOk') }), fail)}>
                {t('discord.test')}
              </Button>
              {d.configured && (
                <Button variant="subtle" color="red" onClick={() => saveDiscord({ webhookUrl: null })}>
                  {t('discord.remove')}
                </Button>
              )}
            </Group>
          </Stack>
        </Card>
      )}
    </Stack>
  );
}
