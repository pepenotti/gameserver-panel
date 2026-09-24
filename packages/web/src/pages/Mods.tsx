import { ActionIcon, Alert, Anchor, Badge, Button, Card, Checkbox, Group, Image, Stack, Text, Textarea, Title } from '@mantine/core';
import { modals } from '@mantine/modals';
import { notifications } from '@mantine/notifications';
import { IconArrowDown, IconArrowUp, IconExternalLink, IconTrash } from '@tabler/icons-react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { del, get, post, put } from '../api/http';
import { useLive } from '../api/live';
import { OpBanner } from '../components/OpBanner';
import { useErrorText } from '../lib/format';

interface ScannedMod {
  modId: string;
  name: string;
  versionFolder: string | null;
  compatible: boolean;
  reason: string | null;
  require: string[];
  maps: string[];
}
interface Item {
  workshopId: string;
  title: string;
  previewUrl: string | null;
  timeUpdated: number;
  scannedUpdated: number;
  mods: ScannedMod[];
  downloaded: boolean;
  error: string | null;
}
interface Enabled {
  modId: string;
  workshopId: string;
}
type Issue = { kind: string; modId?: string; requires?: string; with?: string; workshopId?: string; availableIn?: string | null };
interface ModsResponse {
  items: Item[];
  enabled: Enabled[];
  issues: Issue[];
  lines: { Mods: string; WorkshopItems: string; Map: string };
}

export function Mods() {
  const { t } = useTranslation();
  const errorText = useErrorText();
  const qc = useQueryClient();
  const live = useLive();
  const q = useQuery({ queryKey: ['mods'], queryFn: () => get<ModsResponse>('/api/mods') });
  const [refs, setRefs] = useState('');
  const [adding, setAdding] = useState(false);
  const busy = !!live.op && !live.op.done;
  const fail = (e: unknown) => notifications.show({ color: 'red', message: errorText(e) });
  const refresh = () => void qc.invalidateQueries({ queryKey: ['mods'] });

  const opDone = live.op?.done && live.op.kind === 'mods';
  useEffect(() => {
    if (opDone) void qc.invalidateQueries({ queryKey: ['mods'] });
  }, [opDone, qc]);

  const saveEnabled = async (enabled: Enabled[]) => {
    try {
      const r = await put<{ restartNeeded: boolean }>('/api/mods/enabled', { enabled });
      if (r.restartNeeded) notifications.show({ color: 'orange', message: t('mods.restartNeeded') });
      refresh();
    } catch (e) {
      fail(e);
    }
  };

  const add = async () => {
    const list = refs
      .split(/[\s,]+/)
      .map((s) => s.trim())
      .filter(Boolean);
    if (!list.length) return;
    setAdding(true);
    try {
      const r = await post<{ added: string[] }>('/api/mods', { refs: list });
      notifications.show({ color: 'green', message: t('mods.added', { count: r.added.length }) });
      setRefs('');
      refresh();
    } catch (e) {
      fail(e);
    } finally {
      setAdding(false);
    }
  };

  const data = q.data;
  const enabled = data?.enabled ?? [];
  const isEnabled = (modId: string) => enabled.some((e) => e.modId === modId);
  const move = (i: number, dir: -1 | 1) => {
    const next = [...enabled];
    const [m] = next.splice(i, 1);
    next.splice(i + dir, 0, m!);
    void saveEnabled(next);
  };
  const issueText = (x: Issue) =>
    t(x.kind === 'missing-dependency' && x.availableIn ? 'mods.issues.missing-dependency-available' : `mods.issues.${x.kind}`, {
      modId: x.modId,
      requires: x.requires,
      with: x.with,
      workshopId: x.workshopId,
    });

  return (
    <Stack>
      <Group justify="space-between">
        <Title order={2}>{t('mods.title')}</Title>
        <Group gap="xs">
          <Button
            variant="default"
            size="xs"
            disabled={busy || !data?.items.length}
            onClick={() =>
              void post<{ updates: string[] }>('/api/mods/check').then((r) => {
                notifications.show({ color: r.updates.length ? 'orange' : 'green', message: r.updates.length ? t('mods.updatesFound', { count: r.updates.length }) : t('mods.noUpdates') });
                refresh();
              }, fail)
            }
          >
            {t('mods.check')}
          </Button>
          <Button variant="default" size="xs" disabled={busy || !data?.items.length} onClick={() => void post('/api/mods/download', {}).catch(fail)}>
            {t('mods.download')}
          </Button>
        </Group>
      </Group>
      <Text size="sm" c="dimmed">
        {t('mods.intro')}
      </Text>
      <OpBanner />

      <Card withBorder>
        <Stack gap="xs">
          <Textarea value={refs} onChange={(e) => setRefs(e.currentTarget.value)} placeholder={t('mods.addPlaceholder')} autosize minRows={2} maxRows={6} />
          <Group justify="flex-end">
            <Button onClick={() => void add()} loading={adding} disabled={busy || !refs.trim()}>
              {t('mods.add')}
            </Button>
          </Group>
        </Stack>
      </Card>

      {data?.issues.map((x, i) => (
        <Alert key={i} color={x.kind === 'order' || x.kind === 'not-downloaded' ? 'yellow' : 'red'} variant="light">
          {issueText(x)}
        </Alert>
      ))}

      <Card withBorder>
        <Group justify="space-between" mb={4}>
          <Text fw={600}>{t('mods.loadOrder')}</Text>
          <Button size="compact-xs" variant="default" disabled={enabled.length < 2} onClick={() => void post('/api/mods/sort').then(refresh, fail)}>
            {t('mods.autoSort')}
          </Button>
        </Group>
        <Text size="xs" c="dimmed" mb="xs">
          {t('mods.loadOrderHelp')}
        </Text>
        {enabled.length === 0 ? (
          <Text size="sm" c="dimmed">
            {t('mods.noneEnabled')}
          </Text>
        ) : (
          <Stack gap={4}>
            {enabled.map((e, i) => (
              <Group key={e.modId} justify="space-between" px={6} py={4} style={{ border: '1px solid var(--mantine-color-default-border)', borderRadius: 6 }}>
                <Group gap="xs">
                  <Text size="xs" c="dimmed" w={20} ta="right">
                    {i + 1}
                  </Text>
                  <Text size="sm" ff="monospace">
                    {e.modId}
                  </Text>
                </Group>
                <Group gap={2}>
                  <ActionIcon variant="subtle" size="sm" disabled={i === 0} onClick={() => move(i, -1)} aria-label={t('mods.up')}>
                    <IconArrowUp size={14} />
                  </ActionIcon>
                  <ActionIcon variant="subtle" size="sm" disabled={i === enabled.length - 1} onClick={() => move(i, 1)} aria-label={t('mods.down')}>
                    <IconArrowDown size={14} />
                  </ActionIcon>
                </Group>
              </Group>
            ))}
          </Stack>
        )}
      </Card>

      <Text fw={600}>{t('mods.installed')}</Text>
      {data?.items.length === 0 && (
        <Text size="sm" c="dimmed">
          {t('mods.empty')}
        </Text>
      )}
      {data?.items.map((item) => (
        <Card key={item.workshopId} withBorder padding="sm">
          <Group align="flex-start" wrap="nowrap">
            {item.previewUrl && <Image src={item.previewUrl} w={72} h={72} radius="sm" alt="" fit="cover" />}
            <Stack gap={4} style={{ flex: 1, minWidth: 0 }}>
              <Group justify="space-between" wrap="nowrap">
                <Group gap={6}>
                  <Text fw={600} lineClamp={1}>
                    {item.title}
                  </Text>
                  {item.scannedUpdated > 0 && item.timeUpdated > item.scannedUpdated && (
                    <Badge size="xs" color="orange">
                      {t('mods.updateAvailable')}
                    </Badge>
                  )}
                  {!item.downloaded && (
                    <Badge size="xs" color="gray">
                      {t('mods.notDownloaded')}
                    </Badge>
                  )}
                </Group>
                <Group gap={4} wrap="nowrap">
                  <Anchor href={`https://steamcommunity.com/sharedfiles/filedetails/?id=${item.workshopId}`} target="_blank" rel="noreferrer noopener" size="xs">
                    <Group gap={2}>
                      {t('mods.open')} <IconExternalLink size={12} />
                    </Group>
                  </Anchor>
                  <ActionIcon
                    variant="subtle"
                    color="red"
                    aria-label={t('mods.remove')}
                    onClick={() =>
                      modals.openConfirmModal({
                        title: t('mods.remove'),
                        children: <Text size="sm">{t('mods.removeConfirm', { title: item.title })}</Text>,
                        labels: { confirm: t('mods.remove'), cancel: t('common.cancel') },
                        confirmProps: { color: 'red' },
                        onConfirm: () => void del(`/api/mods/${item.workshopId}`).then(refresh, fail),
                      })
                    }
                  >
                    <IconTrash size={16} />
                  </ActionIcon>
                </Group>
              </Group>
              {item.error && (
                <Text size="xs" c="red">
                  {item.error}
                </Text>
              )}
              {item.mods.length > 1 && (
                <Text size="xs" c="dimmed">
                  {t('mods.variants')}
                </Text>
              )}
              {item.mods.map((m) => (
                <Group key={m.modId} gap="xs">
                  <Checkbox
                    size="xs"
                    checked={isEnabled(m.modId)}
                    onChange={(e) =>
                      void saveEnabled(e.currentTarget.checked ? [...enabled, { modId: m.modId, workshopId: item.workshopId }] : enabled.filter((x) => x.modId !== m.modId))
                    }
                    label={
                      <Group gap={6}>
                        <Text size="sm">{m.name}</Text>
                        <Text size="xs" c="dimmed" ff="monospace">
                          {m.modId}
                        </Text>
                        {m.compatible ? (
                          m.versionFolder && (
                            <Badge size="xs" variant="outline">
                              {m.versionFolder}
                            </Badge>
                          )
                        ) : (
                          <Badge size="xs" color="red">
                            {t(`mods.reasons.${m.reason}`, { defaultValue: m.reason ?? '' })}
                          </Badge>
                        )}
                        {m.maps.length > 0 && (
                          <Badge size="xs" color="teal" variant="light">
                            map: {m.maps.join(', ')}
                          </Badge>
                        )}
                      </Group>
                    }
                  />
                </Group>
              ))}
            </Stack>
          </Group>
        </Card>
      ))}
    </Stack>
  );
}
