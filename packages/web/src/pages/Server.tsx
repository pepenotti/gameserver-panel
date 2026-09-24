import { Alert, Autocomplete, Badge, Button, Card, Group, NumberInput, Select, Stack, Switch, Table, Text, TextInput, Title } from '@mantine/core';
import { modals } from '@mantine/modals';
import { notifications } from '@mantine/notifications';
import { IconAlertTriangle } from '@tabler/icons-react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { OptionMeta } from '@gsp/formats';
import { get, post, put } from '../api/http';
import { useLive } from '../api/live';
import { localize } from '../api/meta';
import { useMeta } from '../api/useMeta';
import { UnsupportedNote } from '../components/Supported';
import { formatBytes, useErrorText } from '../lib/format';
import { humanize } from './config/options';

/** The adapter's launch settings (its `launch.schema` keys). */
type Launch = Record<string, unknown>;

/** `GET /api/server/updates` (shape kept from the Steam-branch days; versions map onto it). */
interface Updates {
  installed: { buildId: string | null; branch: string | null } | null;
  /** The pinned version (Steam branch, release channel); null when the source doesn't list it. */
  branch: string | null;
  latest: { name: string; buildId: string | null; timeUpdated?: number } | null;
  branches: { name: string; buildId: string | null; timeUpdated: number | null }[];
  updateAvailable: boolean;
}

/** "memoryMb" → "Memory (MiB)", "updateOnStart" → "Update on start": a unit suffix becomes a unit. */
export function launchLabel(key: string): string {
  const unit = /(Mb|MiB|Gb|GiB|Ms|Sec|Seconds|Minutes)$/.exec(key)?.[1];
  if (!unit || unit === key) return humanize(key);
  const units: Record<string, string> = { Mb: 'MiB', MiB: 'MiB', Gb: 'GiB', GiB: 'GiB', Ms: 'ms', Sec: 's', Seconds: 's', Minutes: 'min' };
  return `${humanize(key.slice(0, -unit.length))} (${units[unit]})`;
}

/** One launch setting, as its schema types it. `versions` turns a text field into a picker of known versions. */
function LaunchField({ o, value, onChange, versions }: { o: OptionMeta; value: unknown; onChange: (v: unknown) => void; versions?: string[] }) {
  const { i18n } = useTranslation();
  const label = launchLabel(o.key);
  const description = localize(o.description, i18n.language) || undefined;
  switch (o.type) {
    case 'boolean':
      return <Switch label={label} description={description} checked={value === true} onChange={(e) => onChange(e.currentTarget.checked)} />;
    case 'integer':
    case 'decimal':
      return (
        <NumberInput
          label={label}
          description={description}
          value={typeof value === 'number' ? value : ''}
          onChange={(v) => onChange(v === '' ? null : Number(v))}
          min={o.min}
          max={o.max}
          allowDecimal={o.type === 'decimal'}
          hideControls={o.min !== undefined && o.max !== undefined && o.max - o.min > 100}
          w={{ base: '100%', xs: 260 }}
        />
      );
    case 'enum':
      return (
        <Select
          label={label}
          description={description}
          data={(o.options ?? []).map((x) => ({ value: String(x.value), label: localize(x.label, i18n.language) || String(x.value) }))}
          value={value === null || value === undefined ? null : String(value)}
          onChange={(v) => v !== null && onChange(Number(v))}
          allowDeselect={false}
          w={{ base: '100%', xs: 260 }}
        />
      );
    case 'string':
      return versions ? (
        <Autocomplete label={label} description={description} data={versions} value={String(value ?? '')} onChange={(v) => onChange(v.replace(/[\r\n]/g, ''))} w={{ base: '100%', xs: 260 }} />
      ) : (
        <TextInput label={label} description={description} value={String(value ?? '')} onChange={(e) => onChange(e.currentTarget.value.replace(/[\r\n]/g, ''))} w={{ base: '100%', xs: 260 }} />
      );
  }
}

export function Server() {
  const { t } = useTranslation();
  const errorText = useErrorText();
  const qc = useQueryClient();
  const live = useLive();
  const { meta, has } = useMeta();
  const schema = meta?.launch.schema ?? [];
  const launch = useQuery({ queryKey: ['launch'], queryFn: () => get<Launch>('/api/server/launch') });
  const [form, setForm] = useState<Launch | null>(null);
  useEffect(() => {
    if (launch.data && !form) setForm(launch.data);
  }, [launch.data, form]);
  // Asking for versions runs a job on the server (steamcmd for Steam games): only on request.
  const updates = useQuery({ queryKey: ['updates'], queryFn: () => get<Updates>('/api/server/updates'), enabled: false, retry: false });
  const body = (l: Launch) => Object.fromEntries(schema.map((o) => [o.key, l[o.key]]));
  const save = useMutation({
    mutationFn: (l: Launch) => put<Launch>('/api/server/launch', body(l)),
    onSuccess: (l) => {
      qc.setQueryData(['launch'], l);
      setForm(l);
      notifications.show({ color: 'green', message: t('common.saved') });
    },
    onError: (e) => notifications.show({ color: 'red', message: errorText(e) }),
  });
  const busy = !!live.op && !live.op.done;
  const limit = live.status?.process?.cgroupLimitBytes ?? null;
  const overheadMb = meta?.adapter.memory.overheadMb ?? 0;

  // The setting that pins the version is the text field holding the version (channel) the server reports.
  const pinned = updates.data?.branch ?? live.status?.installedInfo?.channel ?? null;
  const versionKey = has('branches') && pinned !== null ? schema.find((o) => o.type === 'string' && launch.data?.[o.key] === pinned)?.key : undefined;
  const versions = versionKey ? Array.from(new Set([...(updates.data?.branches.map((b) => b.name) ?? []), String(form?.[versionKey] ?? '')])).filter(Boolean) : undefined;
  const versionChanged = versionKey !== undefined && form !== null && launch.data !== undefined && form[versionKey] !== launch.data[versionKey];

  const act = (path: string, b: unknown) => post(path, b).catch((e: unknown) => notifications.show({ color: 'red', message: errorText(e) }));
  const countdown = () => ((live.players?.count ?? 0) > 0 ? 300 : 0);

  return (
    <Stack maw={760}>
      <Title order={2}>{t('server.title')}</Title>

      <Card withBorder>
        <Text fw={600}>{t('server.launch')}</Text>
        <Text size="sm" c="dimmed" mb="sm">
          {t('server.launchHelp')}
        </Text>
        {launch.error && <Alert color="red">{errorText(launch.error)}</Alert>}
        {form && (
          <Stack>
            {schema.map((o) => (
              <LaunchField key={o.key} o={o} value={form[o.key]} onChange={(v) => setForm({ ...form, [o.key]: v })} versions={o.key === versionKey ? versions : undefined} />
            ))}
            {versionChanged && (
              <Alert color="orange" variant="light" icon={<IconAlertTriangle />}>
                {t('server.versionWarn')}
              </Alert>
            )}
            {limit !== null && overheadMb > 0 && (
              <Text size="xs" c="dimmed">
                {t('server.containerLimit', { limit: formatBytes(limit), overhead: formatBytes(overheadMb * 1024 * 1024) })}
              </Text>
            )}
            <Group>
              <Button onClick={() => save.mutate(form)} loading={save.isPending} disabled={JSON.stringify(body(form)) === JSON.stringify(body(launch.data ?? {}))}>
                {t('common.save')}
              </Button>
            </Group>
          </Stack>
        )}
      </Card>

      <Card withBorder>
        <Group justify="space-between" mb="sm">
          <Text fw={600}>{t('server.updates')}</Text>
          {has('updateCheck') && (
            <Button variant="default" size="xs" onClick={() => void updates.refetch()} loading={updates.isFetching}>
              {t('server.check')}
            </Button>
          )}
        </Group>
        {updates.error && <Alert color="red">{errorText(updates.error)}</Alert>}
        {updates.data && (
          <Stack gap="sm">
            <Table withRowBorders={false} fz="sm">
              <Table.Tbody>
                <Table.Tr>
                  <Table.Td w={160}>{t('server.installed')}</Table.Td>
                  <Table.Td>{updates.data.installed ? `${updates.data.installed.buildId ?? '—'}${updates.data.installed.branch ? ` (${updates.data.installed.branch})` : ''}` : '—'}</Table.Td>
                </Table.Tr>
                <Table.Tr>
                  <Table.Td>{t('server.latest')}</Table.Td>
                  <Table.Td>{updates.data.latest ? `${updates.data.latest.buildId ?? '—'}${updates.data.branch ? ` (${updates.data.branch})` : ''}` : '—'}</Table.Td>
                </Table.Tr>
              </Table.Tbody>
            </Table>
            <Group>
              <Badge color={updates.data.updateAvailable ? 'orange' : 'green'}>{updates.data.updateAvailable ? t('server.updateAvailable') : t('server.upToDate')}</Badge>
              {updates.data.updateAvailable && (
                <Button size="xs" disabled={busy} onClick={() => void act('/api/server/update', { countdownSec: countdown() })}>
                  {t('server.updateNow')}
                </Button>
              )}
            </Group>
          </Stack>
        )}
        <UnsupportedNote needs={[{ capability: 'updateCheck' }]} />
        <Group mt="md" justify="space-between">
          <Text size="xs" c="dimmed" maw={480}>
            {t('server.validateHelp')}
          </Text>
          <Button size="xs" variant="default" disabled={busy} onClick={() => void act('/api/server/update', { validate: true, countdownSec: countdown() })}>
            {t('server.validate')}
          </Button>
        </Group>
      </Card>

      <Card withBorder style={{ borderColor: 'var(--mantine-color-red-8)' }}>
        <Text fw={600} c="red">
          {t('server.danger')}
        </Text>
        <Group justify="space-between" mt="xs">
          <Text size="sm" c="dimmed" maw={480}>
            {t('server.killHelp')}
          </Text>
          <Button
            color="red"
            variant="light"
            disabled={!live.status?.pid}
            onClick={() =>
              modals.openConfirmModal({
                title: t('server.kill'),
                children: <Text size="sm">{t('server.killConfirm')}</Text>,
                labels: { confirm: t('server.kill'), cancel: t('common.cancel') },
                confirmProps: { color: 'red' },
                onConfirm: () => void act('/api/server/kill', {}),
              })
            }
          >
            {t('server.kill')}
          </Button>
        </Group>
      </Card>
    </Stack>
  );
}
