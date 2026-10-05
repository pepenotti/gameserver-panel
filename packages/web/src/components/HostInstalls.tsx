// The game files on this computer (HST-09, D12), on the panel settings page,
// for those who see the host overview: each install with what it holds, its
// size, how it was filled, the servers using it, and its job's progress;
// then the old own copies of servers that moved to shared files. The owner
// alone removes an install nobody uses, or an old copy, after confirming.
// Cards rather than a table, so it reads on a phone (UX-02).
import { Alert, Badge, Button, Card, Group, Progress, Stack, Text, Title } from '@mantine/core';
import { modals } from '@mantine/modals';
import { notifications } from '@mantine/notifications';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { api } from '../api/http';
import type { InstallsResponse, InstallView, OwnInstallView } from '../api/installs';
import { localize } from '../api/meta';
import { SERVERS_KEY } from '../api/server';
import { useSession } from '../api/session';
import { formatBytes, formatDateTime, useErrorText } from '../lib/format';
import { installLabel, jobPercent, wantedLabel } from '../lib/installs';

const KEY = ['host-installs'];

export function HostInstalls() {
  const { t, i18n } = useTranslation();
  const errorText = useErrorText();
  const qc = useQueryClient();
  const { canHost } = useSession();
  const owner = canHost('host.settings');
  const q = useQuery({
    queryKey: KEY,
    queryFn: () => api<InstallsResponse>('GET', '/api/host/installs'),
    // Followed closely while a job runs.
    refetchInterval: (query) => (query.state.data?.installs.some((i) => i.state === 'installing' || i.state === 'removing') ? 2000 : 30_000),
  });

  const gameOf = (i: InstallView) => {
    const game = i.adapterName ? localize(i.adapterName, i18n.language) : t('hostSettings.installs.unknownGame', { id: i.adapter });
    return i.flavourName ? `${game} · ${localize(i.flavourName, i18n.language)}` : game;
  };
  const whatOf = (i: InstallView) => [gameOf(i), installLabel(i.key) ?? wantedLabel(i.wanted[0])].filter(Boolean).join(' · ');

  const remove = (title: string, body: string, call: () => Promise<unknown>) =>
    modals.openConfirmModal({
      title,
      children: <Text size="sm">{body}</Text>,
      labels: { confirm: t('hostSettings.installs.remove'), cancel: t('common.cancel') },
      confirmProps: { color: 'red' },
      onConfirm: () =>
        void call()
          .then(() => {
            notifications.show({ color: 'green', message: t('hostSettings.installs.removed') });
            void qc.invalidateQueries({ queryKey: KEY });
            void qc.invalidateQueries({ queryKey: SERVERS_KEY });
          })
          .catch((e: unknown) => notifications.show({ color: 'red', message: errorText(e) })),
    });

  const installCard = (i: InstallView) => {
    const pct = jobPercent(i.job);
    return (
      <Card key={i.id} withBorder padding="sm">
        <Group justify="space-between" align="flex-start" wrap="nowrap" gap="xs">
          <Stack gap={2} style={{ minWidth: 0 }}>
            <Text fw={600} size="sm" style={{ overflowWrap: 'anywhere' }}>
              {whatOf(i)}
            </Text>
            <Text size="xs" c="dimmed">
              {[i.bytes !== null ? formatBytes(i.bytes) : null, t(`hostSettings.installs.origin.${i.origin}`), t('hostSettings.installs.created', { when: formatDateTime(i.readyAt ?? i.createdAt, i18n.language, false) })].filter(Boolean).join(' · ')}
            </Text>
          </Stack>
          {owner && i.removable && (
            <Button
              size="xs"
              color="red"
              variant="light"
              style={{ flexShrink: 0 }}
              onClick={() => remove(t('hostSettings.installs.removeTitle'), t('hostSettings.installs.removeConfirm', { what: whatOf(i), size: formatBytes(i.bytes) }), () => api('DELETE', `/api/host/installs/${encodeURIComponent(i.id)}`))}
            >
              {t('hostSettings.installs.remove')}
            </Button>
          )}
        </Group>
        <Group gap={6} mt={6}>
          {i.state === 'installing' && <Badge color="blue" variant="light" tt="none">{t('hostSettings.installs.installing')}</Badge>}
          {i.state === 'removing' && <Badge color="gray" variant="light" tt="none">{t('hostSettings.installs.removing')}</Badge>}
          {i.superseded && <Badge color="gray" variant="light" tt="none">{t('hostSettings.installs.superseded')}</Badge>}
        </Group>
        {i.state === 'installing' && <Progress mt={6} value={pct ?? 100} animated striped={pct === null} />}
        {i.state === 'failed' && (
          <Text size="xs" c="red" mt={4} style={{ overflowWrap: 'anywhere' }}>
            {t('hostSettings.installs.failed', { error: i.error ?? '—' })}
          </Text>
        )}
        <Text size="xs" mt={4} style={{ overflowWrap: 'anywhere' }}>
          {i.servers.length ? t('hostSettings.installs.usedBy', { list: i.servers.map((s) => s.name).join(', ') }) : t('hostSettings.installs.unused')}
        </Text>
      </Card>
    );
  };

  const leftoverCard = (l: OwnInstallView) => {
    const name = l.serverName ?? l.serverId;
    return (
      <Card key={l.serverId} withBorder padding="sm">
        <Group justify="space-between" align="flex-start" wrap="nowrap" gap="xs">
          <Stack gap={2} style={{ minWidth: 0 }}>
            <Text fw={600} size="sm" style={{ overflowWrap: 'anywhere' }}>
              {t('hostSettings.installs.leftover', { name })}
            </Text>
            <Text size="xs" c="dimmed">
              {[l.bytes !== null ? formatBytes(l.bytes) : null, t('hostSettings.installs.created', { when: formatDateTime(l.since, i18n.language, false) })].filter(Boolean).join(' · ')}
            </Text>
          </Stack>
          {owner && (
            <Button
              size="xs"
              color="red"
              variant="light"
              style={{ flexShrink: 0 }}
              onClick={() => remove(t('hostSettings.installs.removeTitle'), t('hostSettings.installs.leftoverRemoveConfirm', { name, size: formatBytes(l.bytes) }), () => api('DELETE', `/api/host/own-installs/${encodeURIComponent(l.serverId)}`))}
            >
              {t('hostSettings.installs.remove')}
            </Button>
          )}
        </Group>
      </Card>
    );
  };

  return (
    <Card withBorder>
      <Title order={4}>{t('hostSettings.installs.title')}</Title>
      <Text size="sm" c="dimmed" mt={4} mb="sm">
        {t('hostSettings.installs.help')}
      </Text>
      {q.error && <Alert color="red">{errorText(q.error)}</Alert>}
      {q.data && (
        <Stack gap="xs">
          {q.data.installs.length === 0 ? (
            <Text size="sm" c="dimmed">
              {t('hostSettings.installs.none')}
            </Text>
          ) : (
            q.data.installs.map(installCard)
          )}
          {q.data.leftovers.length > 0 && (
            <>
              <Text fw={600} size="sm" mt="sm">
                {t('hostSettings.installs.leftovers')}
              </Text>
              <Text size="xs" c="dimmed">
                {t('hostSettings.installs.leftoversHelp')}
              </Text>
              {q.data.leftovers.map(leftoverCard)}
            </>
          )}
          <Text size="sm" mt="xs">
            {t('hostSettings.installs.total', { size: formatBytes(q.data.totalBytes) })}
          </Text>
          {!owner && (q.data.installs.some((i) => i.removable) || q.data.leftovers.length > 0) && (
            <Text size="xs" c="dimmed">
              {t('hostSettings.installs.ownerOnly')}
            </Text>
          )}
        </Stack>
      )}
    </Card>
  );
}
