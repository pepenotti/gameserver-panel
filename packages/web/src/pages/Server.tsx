import { Alert, Badge, Button, Card, Group, NumberInput, Select, Stack, Switch, Table, Text, Title } from '@mantine/core';
import { modals } from '@mantine/modals';
import { notifications } from '@mantine/notifications';
import { IconAlertTriangle } from '@tabler/icons-react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { get, post, put } from '../api/http';
import { useLive } from '../api/live';
import { formatBytes, useErrorText } from '../lib/format';

interface Launch {
  memoryMb: number;
  branch: string;
  updateOnStart: boolean;
}

interface Updates {
  installed: { buildId: string; branch: string } | null;
  branch: string;
  latest: { name: string; buildId: string; timeUpdated?: number } | null;
  branches: { name: string; buildId: string; timeUpdated: number | null }[];
  updateAvailable: boolean;
}

export function Server() {
  const { t } = useTranslation();
  const errorText = useErrorText();
  const qc = useQueryClient();
  const live = useLive();
  const launch = useQuery({ queryKey: ['launch'], queryFn: () => get<Launch>('/api/server/launch') });
  const [form, setForm] = useState<Launch | null>(null);
  useEffect(() => {
    if (launch.data && !form) setForm(launch.data);
  }, [launch.data, form]);
  const updates = useQuery({ queryKey: ['updates'], queryFn: () => get<Updates>('/api/server/updates'), enabled: false, retry: false });
  const save = useMutation({
    mutationFn: (l: Launch) => put<Launch>('/api/server/launch', l),
    onSuccess: (l) => {
      qc.setQueryData(['launch'], l);
      setForm(l);
      notifications.show({ color: 'green', message: t('common.saved') });
    },
    onError: (e) => notifications.show({ color: 'red', message: errorText(e) }),
  });
  const busy = !!live.op && !live.op.done;
  const limit = live.status?.process?.cgroupLimitBytes ?? null;
  const branchOptions = Array.from(new Set(['public', 'legacy41', ...(updates.data?.branches.map((b) => b.name) ?? []), form?.branch ?? 'public']));

  const act = (path: string, body: unknown) => post(path, body).catch((e: unknown) => notifications.show({ color: 'red', message: errorText(e) }));

  return (
    <Stack maw={760}>
      <Title order={2}>{t('server.title')}</Title>

      <Card withBorder>
        <Text fw={600}>{t('server.launch')}</Text>
        <Text size="sm" c="dimmed" mb="sm">
          {t('server.launchHelp')}
        </Text>
        {form && (
          <Stack>
            <NumberInput
              label={t('server.memory')}
              description={t('server.memoryHelp')}
              value={form.memoryMb / 1024}
              onChange={(v) => setForm({ ...form, memoryMb: Math.round(Number(v) * 2) * 512 })}
              min={2}
              max={32}
              step={0.5}
              decimalScale={1}
              w={220}
            />
            {limit && (
              <Text size="xs" c={form.memoryMb * 1024 * 1024 + 3 * 1024 ** 3 > limit ? 'red' : 'dimmed'}>
                {t('server.containerLimit', { limit: formatBytes(limit) })}
              </Text>
            )}
            <Select label={t('server.branch')} description={t('server.branchHelp')} data={branchOptions} value={form.branch} onChange={(v) => v && setForm({ ...form, branch: v })} allowDeselect={false} w={220} />
            {launch.data && form.branch !== launch.data.branch && (
              <Alert color="orange" variant="light" icon={<IconAlertTriangle />}>
                {t('server.branchWarn')}
              </Alert>
            )}
            <Switch label={t('server.updateOnStart')} description={t('server.updateOnStartHelp')} checked={form.updateOnStart} onChange={(e) => setForm({ ...form, updateOnStart: e.currentTarget.checked })} />
            <Group>
              <Button onClick={() => save.mutate(form)} loading={save.isPending} disabled={JSON.stringify(form) === JSON.stringify(launch.data)}>
                {t('common.save')}
              </Button>
            </Group>
          </Stack>
        )}
      </Card>

      <Card withBorder>
        <Group justify="space-between" mb="sm">
          <Text fw={600}>{t('server.updates')}</Text>
          <Button variant="default" size="xs" onClick={() => void updates.refetch()} loading={updates.isFetching}>
            {t('server.check')}
          </Button>
        </Group>
        {updates.error && <Alert color="red">{errorText(updates.error)}</Alert>}
        {updates.data && (
          <Stack gap="sm">
            <Table withRowBorders={false} fz="sm">
              <Table.Tbody>
                <Table.Tr>
                  <Table.Td w={160}>{t('server.installed')}</Table.Td>
                  <Table.Td>
                    {updates.data.installed ? `${updates.data.installed.buildId} (${updates.data.installed.branch})` : '—'}
                  </Table.Td>
                </Table.Tr>
                <Table.Tr>
                  <Table.Td>{t('server.latest')}</Table.Td>
                  <Table.Td>{updates.data.latest ? `${updates.data.latest.buildId} (${updates.data.branch})` : '—'}</Table.Td>
                </Table.Tr>
              </Table.Tbody>
            </Table>
            <Group>
              <Badge color={updates.data.updateAvailable ? 'orange' : 'green'}>{updates.data.updateAvailable ? t('server.updateAvailable') : t('server.upToDate')}</Badge>
              {updates.data.updateAvailable && (
                <Button size="xs" disabled={busy} onClick={() => void act('/api/server/update', { countdownSec: (live.players?.count ?? 0) > 0 ? 300 : 0 })}>
                  {t('server.updateNow')}
                </Button>
              )}
            </Group>
          </Stack>
        )}
        <Group mt="md" justify="space-between">
          <Text size="xs" c="dimmed" maw={480}>
            {t('server.validateHelp')}
          </Text>
          <Button size="xs" variant="default" disabled={busy} onClick={() => void act('/api/server/update', { validate: true, countdownSec: (live.players?.count ?? 0) > 0 ? 300 : 0 })}>
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
