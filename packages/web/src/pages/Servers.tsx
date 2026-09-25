import { ActionIcon, Alert, Badge, Button, Card, Center, Group, Loader, Menu, SimpleGrid, Stack, Text, ThemeIcon, Title, Tooltip } from '@mantine/core';
import { useDisclosure } from '@mantine/hooks';
import { modals } from '@mantine/modals';
import { notifications } from '@mantine/notifications';
import { IconDots, IconPencil, IconPlayerPlay, IconPlayerStop, IconPlus, IconRefresh, IconServer2, IconTrash } from '@tabler/icons-react';
import { useTranslation } from 'react-i18next';
import { Link, Navigate } from 'react-router';
import type { ServerState } from '@gsp/shared';
import { serverApi } from '../api/http';
import { useLiveServers, type LiveServer } from '../api/live';
import { localize } from '../api/meta';
import { serverHref, useServers, type ServerSummary } from '../api/server';
import { useSession } from '../api/session';
import { DeleteServerModal, RenameServerModal } from '../components/ServerAdmin';
import { StateBadge } from '../components/StateBadge';
import { formatDateTime, useErrorText } from '../lib/format';

/** What a server is doing now: the websocket's view when it has one, else the list's. */
function current(s: ServerSummary, live: LiveServer | undefined, open: boolean) {
  const fresh = open && live !== undefined && live.status !== null;
  return {
    state: (fresh ? live.status!.state : s.state) as ServerState | null,
    agentConnected: live !== undefined && open ? live.agentConnected : s.agentConnected,
    players: fresh ? (live.players?.count ?? (live.status!.state === 'running' ? 0 : null)) : s.players,
    op: live?.op && !live.op.done ? live.op : null,
  };
}

function ServerCard({ s, live, open }: { s: ServerSummary; live: LiveServer | undefined; open: boolean }) {
  const { t, i18n } = useTranslation();
  const errorText = useErrorText();
  const [renameOpen, rename] = useDisclosure();
  const [deleteOpen, del] = useDisclosure();
  const now = current(s, live, open);
  const can = (p: string) => s.permissions.includes(p as ServerSummary['permissions'][number]);
  const up = now.state === 'running' || now.state === 'starting';
  const down = now.state === null || now.state === 'stopped' || now.state === 'failed' || now.state === 'crashed';
  const busy = now.op !== null;
  const playersOnline = (now.players ?? 0) > 0 && now.state === 'running';
  // Players online get the usual warnings before a stop or restart, as on the dashboard.
  const countdownSec = playersOnline ? 300 : 0;
  const run = (call: () => Promise<unknown>) => void call().catch((e: unknown) => notifications.show({ color: 'red', message: errorText(e) }));
  const sapi = serverApi(s.id);
  const confirm = (text: string, onConfirm: () => void) =>
    modals.openConfirmModal({
      title: s.name,
      children: (
        <Stack gap="xs">
          <Text size="sm">{text}</Text>
          {playersOnline && (
            <Text size="sm" c="dimmed">
              {t('servers.countdownNote')}
            </Text>
          )}
        </Stack>
      ),
      labels: { confirm: t('common.confirm'), cancel: t('common.cancel') },
      onConfirm,
    });
  const game = [localize(s.adapterName, i18n.language), s.flavour, s.version].filter(Boolean).join(' · ');

  return (
    <Card withBorder padding="md">
      <Stack gap={6} style={{ flex: 1 }}>
        <Group justify="space-between" wrap="nowrap" align="flex-start">
          <Stack gap={0} style={{ minWidth: 0 }}>
            <Text fw={600} component={Link} to={serverHref(s.id, '/')} truncate>
              {s.name}
            </Text>
            <Text size="xs" c="dimmed" truncate>
              {game}
            </Text>
          </Stack>
          <StateBadge state={now.state ?? undefined} agentConnected={now.agentConnected} size="sm" />
        </Group>
        <Group gap={6}>
          <Badge size="sm" variant="outline" color="gray" tt="none">
            {t('servers.yourRole', { role: t(`roles.${s.role}`) })}
          </Badge>
          {busy && now.op && (
            <Badge size="sm" variant="light" color="blue" tt="none">
              {t(`ops.kind.${now.op.kind}`, { defaultValue: now.op.kind })}
            </Badge>
          )}
        </Group>
        <Text size="sm">{now.players === null ? t('servers.notRunning') : t('servers.players', { n: now.players })}</Text>
        <Text size="xs" c="dimmed">
          {s.nextRestart ? t('servers.nextRestart', { when: formatDateTime(s.nextRestart, i18n.language, false) }) : t('servers.noRestart')}
        </Text>
        {s.ports.length > 0 && (
          <Text size="xs" c="dimmed">
            {t('servers.ports', { list: s.ports.map((p) => `${p.port}/${p.proto}`).join(', ') })}
          </Text>
        )}
      </Stack>
      <Group justify="space-between" mt="md" wrap="nowrap">
        <Button component={Link} to={serverHref(s.id, '/')} size="xs" variant="light">
          {t('servers.open')}
        </Button>
        <Group gap={4} wrap="nowrap">
          {can('server.control') && down && (
            <Tooltip label={t('controls.start')}>
              <ActionIcon variant="light" color="green" aria-label={t('controls.start')} disabled={busy || !now.agentConnected} onClick={() => run(() => sapi('POST', '/server/start', {}))}>
                <IconPlayerPlay size={16} />
              </ActionIcon>
            </Tooltip>
          )}
          {can('server.control') && up && (
            <Tooltip label={t('controls.stop')}>
              <ActionIcon variant="light" color="red" aria-label={t('controls.stop')} disabled={busy} onClick={() => confirm(t('controls.stopConfirm'), () => run(() => sapi('POST', '/server/stop', { countdownSec })))}>
                <IconPlayerStop size={16} />
              </ActionIcon>
            </Tooltip>
          )}
          {(can('server.control') || can('server.update') || can('server.delete')) && (
            <Menu position="bottom-end" withinPortal>
              <Menu.Target>
                <ActionIcon variant="subtle" aria-label={t('servers.more', { name: s.name })}>
                  <IconDots size={16} />
                </ActionIcon>
              </Menu.Target>
              <Menu.Dropdown>
                {can('server.control') && (
                  <Menu.Item leftSection={<IconRefresh size={14} />} disabled={!up || busy} onClick={() => confirm(t('controls.restartConfirm'), () => run(() => sapi('POST', '/server/restart', { countdownSec })))}>
                    {t('controls.restart')}
                  </Menu.Item>
                )}
                {can('server.update') && (
                  <Menu.Item leftSection={<IconPencil size={14} />} onClick={rename.open}>
                    {t('servers.rename')}
                  </Menu.Item>
                )}
                {can('server.delete') && (
                  <>
                    <Menu.Divider />
                    <Menu.Item color="red" leftSection={<IconTrash size={14} />} onClick={del.open}>
                      {t('servers.delete')}
                    </Menu.Item>
                  </>
                )}
              </Menu.Dropdown>
            </Menu>
          )}
        </Group>
      </Group>
      <RenameServerModal server={s} opened={renameOpen} onClose={rename.close} />
      <DeleteServerModal server={{ ...s, state: now.state }} opened={deleteOpen} onClose={del.close} />
    </Card>
  );
}

/**
 * The servers this user may see (SRV-02): state, players, version, next
 * restart and their role on each, with the actions that role allows. The
 * list follows the websocket (`servers` messages, live states).
 */
export function Servers() {
  const { t } = useTranslation();
  const errorText = useErrorText();
  const { canHost } = useSession();
  const q = useServers();
  const live = useLiveServers();
  const canCreate = canHost('servers.create');

  if (q.isLoading) {
    return (
      <Center mt="xl">
        <Loader />
      </Center>
    );
  }
  if (q.error) return <Alert color="red">{errorText(q.error)}</Alert>;
  const list = q.data ?? [];

  return (
    <Stack>
      <Group justify="space-between">
        <Title order={2}>{t('servers.title')}</Title>
        {canCreate && list.length > 0 && (
          <Button component={Link} to="/servers/new" leftSection={<IconPlus size={16} />}>
            {t('servers.new')}
          </Button>
        )}
      </Group>
      {list.length === 0 ? (
        <Card withBorder padding="xl" maw={560}>
          <Stack align="center" gap="sm">
            <ThemeIcon size={48} radius="xl" variant="light">
              <IconServer2 size={28} />
            </ThemeIcon>
            <Text fw={600}>{t('servers.emptyTitle')}</Text>
            <Text size="sm" c="dimmed" ta="center">
              {canCreate ? t('servers.emptyCreate') : t('servers.emptyAsk')}
            </Text>
            {canCreate && (
              <Button component={Link} to="/servers/new" leftSection={<IconPlus size={16} />}>
                {t('servers.createFirst')}
              </Button>
            )}
          </Stack>
        </Card>
      ) : (
        <SimpleGrid cols={{ base: 1, sm: 2, lg: 3 }}>
          {list.map((s) => (
            <ServerCard key={s.id} s={s} live={live.servers[s.id]} open={live.open} />
          ))}
        </SimpleGrid>
      )}
    </Stack>
  );
}

/** The landing page: a single-server install opens its server straight away; otherwise the list. */
export function Home() {
  const q = useServers();
  if (q.isLoading) {
    return (
      <Center mt="xl">
        <Loader />
      </Center>
    );
  }
  const list = q.data ?? [];
  if (list.length === 1) return <Navigate to={serverHref(list[0]!.id, '/')} replace />;
  return <Servers />;
}
