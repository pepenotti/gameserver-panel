import { ActionIcon, Alert, Badge, Button, Card, Checkbox, FileButton, Group, Menu, Modal, SegmentedControl, Stack, Table, Text, Title, Tooltip } from '@mantine/core';
import { modals } from '@mantine/modals';
import { notifications } from '@mantine/notifications';
import { IconArchive, IconDots, IconPinned, IconUpload } from '@tabler/icons-react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ApiError, del, get, patch, post } from '../api/http';
import { useLive } from '../api/live';
import { useSession } from '../api/session';
import { OpBanner } from '../components/OpBanner';
import { formatBytes, formatDateTime, useErrorText } from '../lib/format';

type Part = 'world' | 'accounts' | 'configs';

interface Backup {
  name: string;
  size: number;
  sha256: string;
  pinned: boolean;
  manifest: {
    serverName: string;
    createdAt: string;
    trigger: string;
    mode: 'hot' | 'cold';
    buildId: string | null;
    branch: string | null;
    parts: Part[];
  };
}

interface ListResponse {
  backups: Backup[];
  lastRestore: { backup: string; at: string; trash: string | null } | null;
}

export function Backups() {
  const { t, i18n } = useTranslation();
  const errorText = useErrorText();
  const qc = useQueryClient();
  const { can } = useSession();
  const live = useLive();
  const q = useQuery({ queryKey: ['backups'], queryFn: () => get<ListResponse>('/api/backups') });
  const [restoring, setRestoring] = useState<Backup | null>(null);
  const [parts, setParts] = useState<Part[]>(['world']);
  const [countdown, setCountdown] = useState('300');
  const busy = !!live.op && !live.op.done;

  // Refresh the list whenever a backup/restore/reset operation finishes.
  useEffect(() => {
    if (live.op?.done && ['backup', 'restore', 'reset'].includes(live.op.kind)) void qc.invalidateQueries({ queryKey: ['backups'] });
  }, [live.op?.done, live.op?.kind, qc]);

  const fail = (e: unknown) => notifications.show({ color: 'red', message: errorText(e) });
  const when = (b: Backup) => formatDateTime(b.manifest.createdAt, i18n.language);
  const playersOnline = (live.players?.count ?? 0) > 0 && live.status?.state === 'running';

  const upload = async (file: File | null) => {
    if (!file) return;
    const form = new FormData();
    form.append('file', file);
    try {
      const res = await fetch('/api/backups/upload', { method: 'POST', body: form, headers: { 'x-pz-csrf': (await get<{ csrf: string }>('/api/session')).csrf } });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        throw new ApiError(res.status, body.error ?? 'generic');
      }
      notifications.show({ color: 'green', message: t('backups.uploaded') });
      void qc.invalidateQueries({ queryKey: ['backups'] });
    } catch (e) {
      fail(e);
    }
  };

  return (
    <Stack>
      <Group justify="space-between">
        <Title order={2}>{t('backups.title')}</Title>
        <Group gap="xs">
          {can('backups.upload') && (
            <FileButton onChange={(f) => void upload(f)} accept=".zst,application/zstd">
              {(props) => (
                <Button {...props} variant="default" leftSection={<IconUpload size={16} />}>
                  {t('backups.upload')}
                </Button>
              )}
            </FileButton>
          )}
          {can('backups.create') && (
            <Button leftSection={<IconArchive size={16} />} disabled={busy} onClick={() => void post('/api/backups').catch(fail)}>
              {t('backups.create')}
            </Button>
          )}
        </Group>
      </Group>
      <Text size="sm" c="dimmed">
        {t('backups.intro')}
      </Text>
      <OpBanner />

      {q.data?.lastRestore?.trash && can('backups.restore') && (
        <Alert color="orange" variant="light" title={t('backups.undoTitle')}>
          <Group justify="space-between">
            <Text size="sm">{t('backups.undoHelp', { backup: q.data.lastRestore.backup, when: formatDateTime(q.data.lastRestore.at, i18n.language) })}</Text>
            <Button size="xs" variant="default" disabled={busy} onClick={() => void post('/api/backups/undo-restore').catch(fail)}>
              {t('backups.undo')}
            </Button>
          </Group>
        </Alert>
      )}

      <Card withBorder p={0}>
        {q.data?.backups.length === 0 ? (
          <Text c="dimmed" p="md">
            {t('backups.empty')}
          </Text>
        ) : (
          <Table.ScrollContainer minWidth={340}>
            <Table highlightOnHover>
              <Table.Thead>
                <Table.Tr>
                  <Table.Th>{t('backups.when')}</Table.Th>
                  <Table.Th>{t('backups.kind')}</Table.Th>
                  <Table.Th visibleFrom="sm">{t('backups.size')}</Table.Th>
                  <Table.Th w={140} />
                </Table.Tr>
              </Table.Thead>
              <Table.Tbody>
                {q.data?.backups.map((b) => (
                  <Table.Tr key={b.name}>
                    <Table.Td>
                      <Group gap={6} wrap="nowrap">
                        {b.pinned && <IconPinned size={14} />}
                        <Text size="sm">{when(b)}</Text>
                      </Group>
                      <Text size="xs" c="dimmed" hiddenFrom="sm">
                        {formatBytes(b.size)}
                      </Text>
                    </Table.Td>
                    <Table.Td>
                      <Group gap={4}>
                        <Badge variant="light" color={b.manifest.trigger.startsWith('pre-') ? 'gray' : 'blue'}>
                          {t(`backups.triggers.${b.manifest.trigger}`, { defaultValue: b.manifest.trigger })}
                        </Badge>
                        {b.manifest.mode === 'hot' && (
                          <Tooltip label={t('backups.hotHelp')} multiline w={260}>
                            <Badge variant="outline" color="yellow" size="sm">
                              {t('backups.hot')}
                            </Badge>
                          </Tooltip>
                        )}
                      </Group>
                    </Table.Td>
                    <Table.Td visibleFrom="sm">{formatBytes(b.size)}</Table.Td>
                    <Table.Td>
                      <Group gap={4} justify="flex-end" wrap="nowrap">
                        {can('backups.restore') && (
                          <Button
                            size="compact-xs"
                            variant="light"
                            disabled={busy}
                            onClick={() => {
                              setParts(b.manifest.parts.includes('world') ? ['world'] : b.manifest.parts.slice(0, 1));
                              setRestoring(b);
                            }}
                          >
                            {t('backups.restore')}
                          </Button>
                        )}
                        {(can('backups.download') || can('backups.delete')) && (
                          <Menu position="bottom-end" withinPortal>
                            <Menu.Target>
                              <ActionIcon variant="subtle" aria-label="…">
                                <IconDots size={16} />
                              </ActionIcon>
                            </Menu.Target>
                            <Menu.Dropdown>
                              {can('backups.download') && (
                                <Menu.Item component="a" href={`/api/backups/${encodeURIComponent(b.name)}/download`} download>
                                  {t('backups.download')}
                                </Menu.Item>
                              )}
                              {can('backups.delete') && (
                                <>
                                  <Menu.Item onClick={() => void patch(`/api/backups/${encodeURIComponent(b.name)}`, { pinned: !b.pinned }).then(() => qc.invalidateQueries({ queryKey: ['backups'] }), fail)}>
                                    {b.pinned ? t('backups.unpin') : t('backups.pin')}
                                  </Menu.Item>
                                  <Menu.Item
                                    color="red"
                                    onClick={() =>
                                      modals.openConfirmModal({
                                        title: t('backups.delete'),
                                        children: <Text size="sm">{t('backups.deleteConfirm', { when: when(b) })}</Text>,
                                        labels: { confirm: t('backups.delete'), cancel: t('common.cancel') },
                                        confirmProps: { color: 'red' },
                                        onConfirm: () => void del(`/api/backups/${encodeURIComponent(b.name)}`).then(() => qc.invalidateQueries({ queryKey: ['backups'] }), fail),
                                      })
                                    }
                                  >
                                    {t('backups.delete')}
                                  </Menu.Item>
                                </>
                              )}
                            </Menu.Dropdown>
                          </Menu>
                        )}
                      </Group>
                    </Table.Td>
                  </Table.Tr>
                ))}
              </Table.Tbody>
            </Table>
          </Table.ScrollContainer>
        )}
      </Card>

      <Modal opened={!!restoring} onClose={() => setRestoring(null)} title={t('backups.restoreTitle')} centered>
        {restoring && (
          <Stack>
            <Text size="sm" fw={500}>
              {t('backups.restoreFrom', { when: when(restoring) })}
            </Text>
            {restoring.manifest.buildId && (
              <Text size="xs" c="dimmed">
                {t('backups.buildNote', { build: restoring.manifest.buildId, branch: restoring.manifest.branch ?? '?' })}
              </Text>
            )}
            {(['world', 'accounts', 'configs'] as Part[]).map((p) => (
              <Checkbox
                key={p}
                label={t(`backups.parts.${p}`)}
                description={t(`backups.parts.${p}Help`)}
                disabled={!restoring.manifest.parts.includes(p)}
                checked={parts.includes(p)}
                onChange={(e) => setParts((cur) => (e.currentTarget.checked ? [...cur, p] : cur.filter((x) => x !== p)))}
              />
            ))}
            {playersOnline && (
              <Group gap="xs">
                <Text size="sm" c="dimmed">
                  {t('controls.when')}:
                </Text>
                <SegmentedControl
                  size="xs"
                  value={countdown}
                  onChange={setCountdown}
                  data={[
                    { value: '0', label: t('controls.now') },
                    { value: '60', label: t('controls.in1') },
                    { value: '300', label: t('controls.in5') },
                    { value: '900', label: t('controls.in15') },
                  ]}
                />
              </Group>
            )}
            <Alert color="orange" variant="light">
              {t('backups.restoreWarn')}
            </Alert>
            <Button
              color="orange"
              disabled={parts.length === 0}
              onClick={() =>
                void post(`/api/backups/${encodeURIComponent(restoring.name)}/restore`, { parts, countdownSec: playersOnline ? Number(countdown) : 0 }).then(() => setRestoring(null), fail)
              }
            >
              {t('backups.restoreConfirm')}
            </Button>
          </Stack>
        )}
      </Modal>
    </Stack>
  );
}
