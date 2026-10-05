import { ActionIcon, Badge, Button, Card, Checkbox, Group, NumberInput, SegmentedControl, Select, SimpleGrid, Stack, Switch, Text, TextInput, Title } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { IconPlus, IconX } from '@tabler/icons-react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { useServerApi } from '../api/server';
import { NEED_MODS, type Need } from '../api/meta';
import { useSession } from '../api/session';
import { useMeta } from '../api/useMeta';
import { ServerDiscord } from '../components/Discord';
import { UnsupportedNote } from '../components/Supported';
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
type HeavyJob = 'restart' | 'backup' | 'update' | 'mods';
interface NextRuns {
  /** Planned times: what the schedule says plus this server's offset (SCH-02). */
  restart: string | null;
  backup: string | null;
  gameCheck: string | null;
  modCheck: string | null;
  offsetMinutes: number;
  waiting: { job: HeavyJob; plannedAt: string }[];
}

/** How this server's jobs share the host with the others' (SCH-02): its offset, and what waits for its turn now. */
function Stagger({ next }: { next: NextRuns | undefined }) {
  const { t } = useTranslation();
  if (!next) return null;
  return (
    <Stack gap={4}>
      <Text size="sm" c="dimmed">
        {next.offsetMinutes > 0 ? t('schedules.staggered', { n: next.offsetMinutes }) : t('schedules.notStaggered')} {t('schedules.takeTurns')}
      </Text>
      {next.waiting.length > 0 && (
        <Group gap="xs">
          <Badge variant="light" color="yellow">
            {t('schedules.waiting', { jobs: next.waiting.map((w) => t(`schedules.jobs.${w.job}`)).join(', ') })}
          </Badge>
        </Group>
      )}
    </Stack>
  );
}
/** Update checks, each shown only when the server's game has what it checks. */
const UPDATE_CHECKS: ['gameUpdates' | 'modUpdates', Need][] = [
  ['gameUpdates', { capability: 'updateCheck' }],
  ['modUpdates', NEED_MODS],
];

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
  const sapi = useServerApi();
  const { supports, gameName } = useMeta();
  const editable = can('schedules.manage');
  const q = useQuery({ queryKey: ['schedules', sapi.sid], queryFn: () => sapi<{ settings: ScheduleSettings; next: NextRuns }>('GET', '/schedules') });
  const [s, setS] = useState<ScheduleSettings | null>(null);
  const [newTime, setNewTime] = useState('');

  useEffect(() => {
    if (q.data) setS(q.data.settings);
  }, [q.data]);

  const fail = (e: unknown) => notifications.show({ color: 'red', message: errorText(e) });
  const saveSchedules = () =>
    s &&
    void sapi<{ settings: ScheduleSettings; next: NextRuns }>('PUT', '/schedules', s).then((r) => {
      qc.setQueryData(['schedules', sapi.sid], r);
      notifications.show({ color: 'green', message: t('schedules.saved') });
    }, fail);

  if (!s) return null;
  const policySelect = (value: Policy, onChange: (p: Policy) => void) => (
    <Select label={t('schedules.apply')} value={value} onChange={(v) => v && onChange(v as Policy)} allowDeselect={false} disabled={!editable} data={(['when-empty', 'restart-countdown', 'notify-only'] as Policy[]).map((p) => ({ value: p, label: t(`schedules.policies.${p}`) }))} />
  );

  return (
    <Stack maw={820}>
      <Title order={2}>{t('schedules.title')}</Title>
      <Stagger next={q.data?.next} />
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

      {UPDATE_CHECKS.filter(([, need]) => supports(need)).map(([k]) => (
        <Section key={k} title={t(`schedules.${k}`)} help={t(`schedules.${k}Help`, { game: gameName })} enabled={s[k].enabled} onToggle={editable ? (v) => setS({ ...s, [k]: { ...s[k], enabled: v } }) : undefined} next={q.data?.next[k === 'gameUpdates' ? 'gameCheck' : 'modCheck'] ?? null}>
          <SimpleGrid cols={{ base: 1, sm: 2 }}>
            <NumberInput label={t('schedules.checkEvery')} min={5} max={59} value={s[k].checkEveryMinutes} disabled={!editable} onChange={(v) => setS({ ...s, [k]: { ...s[k], checkEveryMinutes: Number(v) || 30 } })} />
            {policySelect(s[k].apply, (p) => setS({ ...s, [k]: { ...s[k], apply: p } }))}
          </SimpleGrid>
        </Section>
      ))}

      <UnsupportedNote needs={UPDATE_CHECKS.map(([, need]) => need)} />

      {editable && (
        <Group>
          <Button onClick={saveSchedules} disabled={JSON.stringify(s) === JSON.stringify(q.data?.settings)}>
            {t('common.save')}
          </Button>
        </Group>
      )}

      {can('notifications.manage') && <ServerDiscord />}
    </Stack>
  );
}
