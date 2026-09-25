import { ActionIcon, Alert, Badge, Button, Card, Checkbox, CopyButton, Group, Menu, Modal, Select, Stack, Table, Text, TextInput, Title, Tooltip } from '@mantine/core';
import { modals } from '@mantine/modals';
import { notifications } from '@mantine/notifications';
import { IconDots, IconUserPlus } from '@tabler/icons-react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useServerApi } from '../api/server';
import { useLive } from '../api/live';
import type { Need } from '../api/meta';
import { useSession } from '../api/session';
import { useMeta } from '../api/useMeta';
import { UnsupportedNote } from '../components/Supported';
import { formatDateTime, useDuration, useErrorText } from '../lib/format';

interface Account {
  username: string;
  displayName: string | null;
  role: string;
  lastConnection: string | null;
  steamId: string | null;
}

interface PlayersResponse {
  online: { username: string; since: string }[];
  accounts: Account[] | null;
  bans: { steamIds: { steamId: string; reason: string | null }[]; ips: { ip: string; username: string | null; reason: string | null }[] } | null;
  ipBansTrustworthy: boolean;
}

interface Session {
  id: number;
  username: string;
  joinedAt: string;
  leftAt: string | null;
}

/** Moderation the page offers when the game has it; the note under the page names what it lacks. */
const MODERATION: Need[] = [{ capability: 'kick' }, { capability: 'ban' }, { capability: 'whitelist' }, { capability: 'accessLevels' }, { capability: 'playerHistory' }];

type Dialog = { kind: 'kick' | 'ban'; name: string; steamId: string | null } | { kind: 'access'; name: string } | { kind: 'whitelist' } | null;

export function Players() {
  const { t, i18n } = useTranslation();
  const errorText = useErrorText();
  const dur = useDuration();
  const qc = useQueryClient();
  const { can: canRole } = useSession();
  const live = useLive();
  const sapi = useServerApi();
  const { meta, has, l } = useMeta();
  const q = useQuery({ queryKey: ['players', sapi.sid], queryFn: () => sapi<PlayersResponse>('GET', '/players'), refetchInterval: 30_000 });
  const history = useQuery({ queryKey: ['players', 'history', sapi.sid], queryFn: () => sapi<Session[]>('GET', '/players/history?limit=50'), enabled: canRole('accounts.view') && has('playerHistory') });
  const [dialog, setDialog] = useState<Dialog>(null);
  const [reason, setReason] = useState('');
  const [bySteam, setBySteam] = useState(true);
  const levels = meta?.accessLevels ?? [];
  const [level, setLevel] = useState<string | null>(null);
  const [wl, setWl] = useState({ username: '', password: '' });
  const running = live.status?.state === 'running';
  // What this user may do and this game supports.
  const can = {
    kick: canRole('players.moderate') && has('kick'),
    ban: canRole('players.moderate') && has('ban'),
    access: canRole('players.accessLevel') && has('accessLevels') && levels.length > 0,
    whitelist: canRole('whitelist.manage') && has('whitelist'),
  };
  const anyAction = can.kick || can.ban || can.access || can.whitelist;
  /** An account's level: the adapter's name for it, else the game's own word. */
  const levelLabel = (id: string) => {
    const known = levels.find((x) => x.id === id);
    return known ? l(known.label) : id;
  };
  /** Levels are listed lowest first: the highest stands out, unknown ones (the game's own roles) are grey. */
  const levelColor = (id: string) => {
    const i = levels.findIndex((x) => x.id === id);
    return i < 0 ? 'gray' : i === levels.length - 1 && i > 0 ? 'red' : i > 0 ? 'orange' : 'blue';
  };
  // What a ban can name (the adapter declares it); without a declaration, a username.
  const banTargets = meta?.banTargets?.length ? meta.banTargets : ['username'];
  const banByAccount = banTargets.includes('steamId');
  const banByName = banTargets.includes('username');
  const steamIds = !!q.data?.accounts?.some((a) => a.steamId);

  // Presence changes arrive over the websocket; refresh the lists when they do.
  useEffect(() => {
    void qc.invalidateQueries({ queryKey: ['players'] });
  }, [live.players, qc]);

  const act = async (fn: () => Promise<{ output: string }>) => {
    try {
      const r = await fn();
      notifications.show({ color: 'green', message: r.output ? t('players.result', { output: r.output }) : t('common.saved') });
      setDialog(null);
      setReason('');
      void qc.invalidateQueries({ queryKey: ['players'] });
    } catch (e) {
      notifications.show({ color: 'red', message: errorText(e) });
    }
  };

  const online = live.players?.names ?? q.data?.online.map((o) => o.username) ?? [];
  const since = new Map(q.data?.online.map((o) => [o.username, o.since]));
  const accountOf = (name: string) => q.data?.accounts?.find((a) => a.username === name);

  const playerMenu = (name: string, steamId: string | null, onlineNow: boolean) => (
    <Menu position="bottom-end" withinPortal>
      <Menu.Target>
        <ActionIcon variant="subtle" aria-label="…" disabled={!running}>
          <IconDots size={16} />
        </ActionIcon>
      </Menu.Target>
      <Menu.Dropdown>
        {can.kick && onlineNow && <Menu.Item onClick={() => setDialog({ kind: 'kick', name, steamId })}>{t('players.kick')}</Menu.Item>}
        {can.ban && (banByName || (banByAccount && steamId)) && <Menu.Item onClick={() => { setBySteam(banByAccount && !!steamId); setDialog({ kind: 'ban', name, steamId }); }}>{t('players.ban')}</Menu.Item>}
        {can.access && <Menu.Item onClick={() => { setLevel(levels[0]?.id ?? null); setDialog({ kind: 'access', name }); }}>{t('players.access')}</Menu.Item>}
        {can.whitelist && (
          <Menu.Item
            color="red"
            onClick={() =>
              modals.openConfirmModal({
                title: t('players.whitelistRemove'),
                children: <Text size="sm">{t('players.removeConfirm', { name })}</Text>,
                labels: { confirm: t('players.whitelistRemove'), cancel: t('common.cancel') },
                confirmProps: { color: 'red' },
                onConfirm: () => void act(() => sapi('DELETE', `/players/whitelist/${encodeURIComponent(name)}`)),
              })
            }
          >
            {t('players.whitelistRemove')}
          </Menu.Item>
        )}
      </Menu.Dropdown>
    </Menu>
  );

  return (
    <Stack>
      <Group justify="space-between">
        <Title order={2}>{t('players.title')}</Title>
        {can.whitelist && (
          <Button leftSection={<IconUserPlus size={16} />} variant="default" disabled={!running} onClick={() => setDialog({ kind: 'whitelist' })}>
            {t('players.whitelistAdd')}
          </Button>
        )}
      </Group>
      {!running && <Alert variant="light">{t('players.notRunning')}</Alert>}

      <Card withBorder>
        <Text fw={600} mb="xs">
          {t('players.online')} ({online.length})
        </Text>
        {online.length === 0 ? (
          <Text c="dimmed" size="sm">
            {t('players.noneOnline')}
          </Text>
        ) : (
          <Table>
            <Table.Tbody>
              {online.map((name) => (
                <Table.Tr key={name}>
                  <Table.Td>
                    <Text fw={500}>{name}</Text>
                  </Table.Td>
                  <Table.Td>
                    <Text size="sm" c="dimmed">
                      {since.get(name) ? t('players.since', { time: dur(Date.now() - new Date(since.get(name)!).getTime()) }) : ''}
                    </Text>
                  </Table.Td>
                  <Table.Td w={50}>{anyAction && playerMenu(name, accountOf(name)?.steamId ?? null, true)}</Table.Td>
                </Table.Tr>
              ))}
            </Table.Tbody>
          </Table>
        )}
      </Card>

      {q.data?.accounts && has('accounts') && (
        <Card withBorder>
          <Text fw={600}>{t('players.accounts')}</Text>
          <Text size="xs" c="dimmed" mb="xs">
            {t('players.accountsHelp')}
          </Text>
          <Table.ScrollContainer minWidth={560}>
            <Table striped fz="sm">
              <Table.Thead>
                <Table.Tr>
                  <Table.Th>{t('auth.username')}</Table.Th>
                  <Table.Th>{t('players.role')}</Table.Th>
                  <Table.Th>{t('players.lastSeen')}</Table.Th>
                  {steamIds && <Table.Th>{t('players.steamId')}</Table.Th>}
                  <Table.Th w={50} />
                </Table.Tr>
              </Table.Thead>
              <Table.Tbody>
                {q.data.accounts.map((a) => (
                  <Table.Tr key={a.username}>
                    <Table.Td>
                      <Group gap={6}>
                        {a.username}
                        {online.includes(a.username) && (
                          <Badge size="xs" color="green">
                            {t('players.onlineBadge')}
                          </Badge>
                        )}
                      </Group>
                    </Table.Td>
                    <Table.Td>
                      <Badge variant="light" color={levelColor(a.role)}>
                        {levelLabel(a.role)}
                      </Badge>
                    </Table.Td>
                    <Table.Td>{a.lastConnection ?? '—'}</Table.Td>
                    {steamIds && (
                      <Table.Td>
                        {a.steamId ? (
                          <CopyButton value={a.steamId}>
                            {({ copied, copy }) => (
                              <Tooltip label={copied ? t('common.copied') : t('common.copy')}>
                                <Text size="xs" ff="monospace" style={{ cursor: 'pointer' }} onClick={copy}>
                                  {a.steamId}
                                </Text>
                              </Tooltip>
                            )}
                          </CopyButton>
                        ) : (
                          '—'
                        )}
                      </Table.Td>
                    )}
                    <Table.Td>{anyAction && playerMenu(a.username, a.steamId, online.includes(a.username))}</Table.Td>
                  </Table.Tr>
                ))}
              </Table.Tbody>
            </Table>
          </Table.ScrollContainer>
        </Card>
      )}

      {q.data?.bans && has('ban') && (
        <Card withBorder>
          <Text fw={600} mb="xs">
            {t('players.bans')}
          </Text>
          {q.data.bans.steamIds.length === 0 && q.data.bans.ips.length === 0 && (
            <Text size="sm" c="dimmed">
              {t('players.noBans')}
            </Text>
          )}
          {q.data.bans.steamIds.length > 0 && (
            <>
              <Text size="sm" fw={500} mb={4}>
                {t('players.steamBans')}
              </Text>
              <Table fz="sm">
                <Table.Tbody>
                  {q.data.bans.steamIds.map((b) => (
                    <Table.Tr key={b.steamId}>
                      <Table.Td ff="monospace">{b.steamId}</Table.Td>
                      <Table.Td>{b.reason ?? ''}</Table.Td>
                      <Table.Td w={100} ta="right">
                        {can.ban && (
                          <Button size="compact-xs" variant="subtle" disabled={!running} onClick={() => void act(() => sapi('POST', '/players/unban', { steamId: b.steamId }))}>
                            {t('players.unban')}
                          </Button>
                        )}
                      </Table.Td>
                    </Table.Tr>
                  ))}
                </Table.Tbody>
              </Table>
            </>
          )}
          {q.data.bans.ips.length > 0 && (
            <>
              <Text size="sm" fw={500} mt="md" mb={4}>
                {t('players.ipBans')}
              </Text>
              {!q.data.ipBansTrustworthy && (
                <Text size="xs" c="dimmed" mb="xs">
                  {t('players.ipBansNote')}
                </Text>
              )}
              <Table fz="sm">
                <Table.Tbody>
                  {q.data.bans.ips.map((b) => (
                    <Table.Tr key={b.ip}>
                      <Table.Td ff="monospace">{b.ip}</Table.Td>
                      <Table.Td>{b.username ?? ''}</Table.Td>
                      <Table.Td>{b.reason ?? ''}</Table.Td>
                    </Table.Tr>
                  ))}
                </Table.Tbody>
              </Table>
            </>
          )}
        </Card>
      )}

      {history.data && (
        <Card withBorder>
          <Text fw={600} mb="xs">
            {t('players.history')}
          </Text>
          <Table.ScrollContainer minWidth={480}>
            <Table fz="sm" striped>
              <Table.Thead>
                <Table.Tr>
                  <Table.Th>{t('auth.username')}</Table.Th>
                  <Table.Th>{t('players.joined')}</Table.Th>
                  <Table.Th>{t('players.duration')}</Table.Th>
                </Table.Tr>
              </Table.Thead>
              <Table.Tbody>
                {history.data.map((s) => (
                  <Table.Tr key={s.id}>
                    <Table.Td>{s.username}</Table.Td>
                    <Table.Td>{formatDateTime(s.joinedAt, i18n.language)}</Table.Td>
                    <Table.Td>{s.leftAt ? dur(new Date(s.leftAt).getTime() - new Date(s.joinedAt).getTime()) : t('players.stillOnline')}</Table.Td>
                  </Table.Tr>
                ))}
              </Table.Tbody>
            </Table>
          </Table.ScrollContainer>
        </Card>
      )}

      <UnsupportedNote needs={MODERATION} />

      <Modal
        opened={dialog !== null}
        onClose={() => setDialog(null)}
        centered
        title={
          dialog?.kind === 'kick'
            ? t('players.kickTitle', { name: dialog.name })
            : dialog?.kind === 'ban'
              ? t('players.banTitle', { name: dialog.name })
              : dialog?.kind === 'access'
                ? `${t('players.access')}: ${dialog.name}`
                : t('players.whitelistAdd')
        }
      >
        {(dialog?.kind === 'kick' || dialog?.kind === 'ban') && (
          <Stack>
            {dialog.kind === 'ban' && <Text size="sm">{t('players.banHelp')}</Text>}
            <TextInput label={t('players.reason')} value={reason} onChange={(e) => setReason(e.currentTarget.value.replace(/["\r\n]/g, ''))} maxLength={200} data-autofocus />
            {/* Both targets declared: the account is the safer ban; only one: that one, no choice. */}
            {dialog.kind === 'ban' && dialog.steamId && banByAccount && banByName && <Checkbox label={t('players.banBySteam')} checked={bySteam} onChange={(e) => setBySteam(e.currentTarget.checked)} />}
            <Button
              color="red"
              onClick={() =>
                void act(() =>
                  dialog.kind === 'kick'
                    ? sapi('POST', '/players/kick', { username: dialog.name, ...(reason ? { reason } : {}) })
                    : sapi('POST', '/players/ban', bySteam && dialog.steamId ? { steamId: dialog.steamId } : { username: dialog.name, ...(reason ? { reason } : {}) }),
                )
              }
            >
              {dialog.kind === 'kick' ? t('players.kick') : t('players.ban')}
            </Button>
          </Stack>
        )}
        {dialog?.kind === 'access' && (
          <Stack>
            <Text size="sm" c="dimmed">
              {t('players.accessHelp')}
            </Text>
            <Select data={levels.map((x) => ({ value: x.id, label: l(x.label) }))} value={level} onChange={(v) => v && setLevel(v)} allowDeselect={false} aria-label={t('players.access')} />
            <Button disabled={!level} onClick={() => void act(() => sapi('POST', '/players/access', { username: dialog.name, level }))}>
              {t('common.save')}
            </Button>
          </Stack>
        )}
        {dialog?.kind === 'whitelist' && (
          <Stack>
            <Text size="sm" c="dimmed">
              {t('players.whitelistHelp')}
            </Text>
            <TextInput label={t('auth.username')} value={wl.username} onChange={(e) => setWl({ ...wl, username: e.currentTarget.value })} maxLength={32} data-autofocus />
            <TextInput label={t('players.password')} value={wl.password} onChange={(e) => setWl({ ...wl, password: e.currentTarget.value.replace(/["\r\n\s]/g, '') })} maxLength={64} />
            <Button
              disabled={!wl.username.trim() || wl.password.length < 4}
              onClick={() =>
                void act(async () => {
                  const r = await sapi<{ output: string }>('POST', '/players/whitelist', { username: wl.username.trim(), password: wl.password });
                  setWl({ username: '', password: '' });
                  return r;
                })
              }
            >
              {t('players.whitelistAdd')}
            </Button>
          </Stack>
        )}
      </Modal>
    </Stack>
  );
}
