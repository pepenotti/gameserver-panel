import { ActionIcon, Alert, Badge, Button, Card, Checkbox, FileButton, Group, Menu, Modal, SegmentedControl, Stack, Table, Text, Title, Tooltip } from '@mantine/core';
import { modals } from '@mantine/modals';
import { notifications } from '@mantine/notifications';
import { IconArchive, IconDots, IconPinned, IconUpload } from '@tabler/icons-react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useServerApi } from '../api/server';
import { useLive } from '../api/live';
import { useSession } from '../api/session';
import { useMeta } from '../api/useMeta';
import { OpBanner } from '../components/OpBanner';
import { formatBytes, formatDateTime, useErrorText } from '../lib/format';

/** A backup part id: one of the adapter's `backupParts`. */
type Part = string;

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
    gameVersion: string | null;
    /** Build and channel (Steam build id and branch) of the game that made it. */
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
  const sapi = useServerApi();
  const { meta, l } = useMeta();
  const q = useQuery({ queryKey: ['backups', sapi.sid], queryFn: () => sapi<ListResponse>('GET', '/backups') });
  const [restoring, setRestoring] = useState<Backup | null>(null);
  const [parts, setParts] = useState<Part[]>([]);
  // What a backup is made of, as the server's game names it; parts a backup lists but the game doesn't are shown by id.
  const allParts = (b: Backup | null) => [
    ...(meta?.backupParts ?? []).map((p) => ({ id: p.id, label: l(p.label) })),
    ...(b?.manifest.parts ?? []).filter((id) => !meta?.backupParts.some((p) => p.id === id)).map((id) => ({ id, label: id })),
  ];
  const known = new Set(meta?.backupParts.map((p) => p.id));
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
      await sapi('POST', '/backups/upload', form);
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
            <Button leftSection={<IconArchive size={16} />} disabled={busy} onClick={() => void sapi('POST', '/backups', {}).catch(fail)}>
              {t('backups.create')}
            </Button>
          )}
        </Group>
      </Group>
      <Text size="sm" c="dimmed">
        {meta && meta.backupParts.length > 0 && `${t('backups.holds', { parts: meta.backupParts.map((p) => l(p.label)).join('; ') })} `}
        {t('backups.intro')}
      </Text>
      <OpBanner />

      {q.data?.lastRestore?.trash && can('backups.restore') && (
        <Alert color="orange" variant="light" title={t('backups.undoTitle')}>
          <Group justify="space-between">
            <Text size="sm">{t('backups.undoHelp', { backup: q.data.lastRestore.backup, when: formatDateTime(q.data.lastRestore.at, i18n.language) })}</Text>
            <Button size="xs" variant="default" disabled={busy} onClick={() => void sapi('POST', '/backups/undo-restore', {}).catch(fail)}>
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
                              // The game's first part it has (the world, for most games).
                              const first = allParts(b).find((p) => b.manifest.parts.includes(p.id));
                              setParts(first ? [first.id] : []);
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
                                <Menu.Item component="a" href={sapi.url(`/backups/${encodeURIComponent(b.name)}/download`)} download>
                                  {t('backups.download')}
                                </Menu.Item>
                              )}
                              {can('backups.delete') && (
                                <>
                                  <Menu.Item onClick={() => void sapi('PATCH', `/backups/${encodeURIComponent(b.name)}`, { pinned: !b.pinned }).then(() => qc.invalidateQueries({ queryKey: ['backups'] }), fail)}>
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
                                        onConfirm: () => void sapi('DELETE', `/backups/${encodeURIComponent(b.name)}`).then(() => qc.invalidateQueries({ queryKey: ['backups'] }), fail),
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
            {(restoring.manifest.gameVersion || restoring.manifest.buildId) && (
              <Text size="xs" c="dimmed">
                {t('backups.madeWith', {
                  version: [restoring.manifest.gameVersion, restoring.manifest.buildId && t('dashboard.build', { build: restoring.manifest.buildId }), restoring.manifest.branch].filter(Boolean).join(' · '),
                })}
              </Text>
            )}
            {allParts(restoring).map((p) => (
              <Checkbox
                key={p.id}
                label={p.label}
                // Only parts this game knows can be restored (the API refuses the rest).
                disabled={!restoring.manifest.parts.includes(p.id) || !known.has(p.id)}
                checked={parts.includes(p.id)}
                onChange={(e) => setParts((cur) => (e.currentTarget.checked ? [...cur, p.id] : cur.filter((x) => x !== p.id)))}
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
                void sapi('POST', `/backups/${encodeURIComponent(restoring.name)}/restore`, { parts, countdownSec: playersOnline ? Number(countdown) : 0 }).then(() => setRestoring(null), fail)
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
