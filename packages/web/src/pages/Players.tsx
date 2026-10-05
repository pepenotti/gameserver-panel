import { ActionIcon, Alert, Badge, Button, Card, Checkbox, CopyButton, Group, Menu, Modal, SegmentedControl, Select, Stack, Switch, Table, Text, TextInput, Title, Tooltip } from '@mantine/core';
import { modals } from '@mantine/modals';
import { notifications } from '@mantine/notifications';
import { IconAlertTriangle, IconBan, IconDots, IconUserPlus } from '@tabler/icons-react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useHostAddresses, type AddressView } from '../api/host';
import { useServerApi } from '../api/server';
import { useLive } from '../api/live';
import type { BanTarget, Need } from '../api/meta';
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

/** `GET /api/servers/:sid/players` (mirrors packages/panel/src/routes/players.ts). */
interface PlayersResponse {
  online: { username: string; since: string }[];
  accounts: Account[] | null;
  bans: {
    steamIds: { steamId: string; reason: string | null }[];
    ips: { ip: string; username: string | null; reason: string | null }[];
    /** Bans by player name (games that ban names, not Steam accounts). */
    usernames?: { username: string; id: string | null; reason: string | null }[];
    /** Bans of the id a game client sends. */
    uuids?: { uuid: string; reason: string | null }[];
    /** Bans of accounts the game server keeps. */
    accounts?: { account: string; reason: string | null }[];
  } | null;
  /** The game's whitelist as it stands, where it can be listed. */
  whitelist: { enabled: boolean | null; usernames: string[] } | null;
  /** Who holds a level above the lowest, where the game lists them. */
  levelHolders: { username: string; level: string }[] | null;
  /** A ban of an address names one player's (their own address arrives, or is expected to). */
  ipBansTrustworthy: boolean;
  /** Whether players' addresses reach the game here (HST-07); absent from an older panel. */
  addresses?: AddressView;
}

interface Session {
  id: number;
  username: string;
  joinedAt: string;
  leftAt: string | null;
}

/** Moderation the page offers when the game has it; the note under the page names what it lacks. */
const MODERATION: Need[] = [{ capability: 'kick' }, { capability: 'ban' }, { capability: 'whitelist' }, { capability: 'accessLevels' }, { capability: 'playerHistory' }];

type Dialog = { kind: 'kick' | 'ban'; name: string; steamId: string | null } | { kind: 'banAny' } | { kind: 'access'; name: string } | { kind: 'whitelist' } | null;

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
  const hostAddresses = useHostAddresses();
  const history = useQuery({ queryKey: ['players', 'history', sapi.sid], queryFn: () => sapi<Session[]>('GET', '/players/history?limit=50'), enabled: canRole('accounts.view') && has('playerHistory') });
  const [dialog, setDialog] = useState<Dialog>(null);
  const [reason, setReason] = useState('');
  const [bySteam, setBySteam] = useState(true);
  const levels = meta?.accessLevels ?? [];
  const [level, setLevel] = useState<string | null>(null);
  const [wl, setWl] = useState({ username: '', password: '' });
  const [banBy, setBanBy] = useState<BanTarget>('username');
  const [banWho, setBanWho] = useState('');
  const running = live.status?.state === 'running';
  // What this user may do and this game supports.
  const can = {
    kick: canRole('players.moderate') && has('kick'),
    ban: canRole('players.moderate') && has('ban'),
    access: canRole('players.accessLevel') && has('accessLevels') && levels.length > 0,
    whitelist: canRole('whitelist.manage') && has('whitelist'),
  };
  const anyAction = can.kick || can.ban || can.access || can.whitelist;
  /** Whitelist entries are accounts with a password (the game's own way), or just names; the adapter says. */
  const withPassword = meta?.whitelist?.password !== false;
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
  const banTargets: BanTarget[] = meta?.banTargets?.length ? meta.banTargets : ['username'];
  const banByAccount = banTargets.includes('steamId');
  const banByName = banTargets.includes('username');
  const banByIp = banTargets.includes('ip');
  /** The game bans the address a player joined from, whatever the ban names: warn before, and lift by address. */
  const byAddress = meta?.banByAddress === true;
  /** The game keeps its bans in memory: they are lifted while it is stopped. */
  const unbanStopped = meta?.stoppedOnly?.includes('unban') === true;
  const steamIds = !!q.data?.accounts?.some((a) => a.steamId);
  const targetLabel: Record<BanTarget, string> = { username: t('players.byName'), steamId: t('players.steamId'), ip: t('players.byIp'), uuid: t('players.byUuid'), account: t('players.byAccount') };
  /**
   * Before a ban of an address: behind Docker Desktop (untrustworthy addresses) everyone shares one, so it is a
   * warning; where the host's trait says so (HST-07), with its docs/limitations.md entry.
   */
  const addressWarning = byAddress && (
    <Alert color={q.data?.ipBansTrustworthy ? 'yellow' : 'red'} variant="light" icon={<IconAlertTriangle />}>
      {q.data?.ipBansTrustworthy ? t('players.addressBanNote') : t('players.addressBanWarning')}
      {q.data?.addresses === 'hidden' && hostAddresses && (
        <Text size="xs" c="dimmed" mt={4}>
          {t('host.addresses.doc', { doc: hostAddresses.doc })}
        </Text>
      )}
    </Alert>
  );

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

  const removeFromWhitelist = (name: string) =>
    modals.openConfirmModal({
      title: withPassword ? t('players.whitelistRemove') : t('players.whitelistRemoveName'),
      children: <Text size="sm">{withPassword ? t('players.removeConfirm', { name }) : t('players.removeNameConfirm', { name })}</Text>,
      labels: { confirm: withPassword ? t('players.whitelistRemove') : t('players.whitelistRemoveName'), cancel: t('common.cancel') },
      confirmProps: { color: 'red' },
      onConfirm: () => void act(() => sapi('DELETE', `/players/whitelist/${encodeURIComponent(name)}`)),
    });

  const playerMenu = (name: string, steamId: string | null, onlineNow: boolean) => (
    <Menu position="bottom-end" withinPortal>
      <Menu.Target>
        <ActionIcon variant="subtle" aria-label="…" disabled={!running}>
          <IconDots size={16} />
        </ActionIcon>
      </Menu.Target>
      <Menu.Dropdown>
        {can.kick && onlineNow && <Menu.Item onClick={() => setDialog({ kind: 'kick', name, steamId })}>{t('players.kick')}</Menu.Item>}
        {can.ban && (banByName || (banByAccount && steamId)) && (
          <Menu.Item
            onClick={() => {
              setBySteam(banByAccount && !!steamId);
              setDialog({ kind: 'ban', name, steamId });
            }}
          >
            {t('players.ban')}
          </Menu.Item>
        )}
        {can.access && (
          <Menu.Item
            onClick={() => {
              setLevel(levels[0]?.id ?? null);
              setDialog({ kind: 'access', name });
            }}
          >
            {t('players.access')}
          </Menu.Item>
        )}
        {can.whitelist && (
          <Menu.Item color="red" onClick={() => removeFromWhitelist(name)}>
            {withPassword ? t('players.whitelistRemove') : t('players.whitelistRemoveName')}
          </Menu.Item>
        )}
      </Menu.Dropdown>
    </Menu>
  );

  // Most games lift a ban while they run; one that keeps its bans in memory, while it is stopped.
  const unbanButton = (body: Record<string, string>) =>
    can.ban && (
      <Button size="compact-xs" variant="subtle" disabled={unbanStopped ? running || !live.status : !running} onClick={() => void act(() => sapi('POST', '/players/unban', body))}>
        {t('players.unban')}
      </Button>
    );

  const bans = q.data?.bans ?? null;
  const nameBans = bans?.usernames ?? [];
  const uuidBans = bans?.uuids ?? [];
  const accountBans = bans?.accounts ?? [];
  /** A simple list of bans of one kind: what it names, its reason, and the unban button. */
  const banTable = (title: string, rows: { key: string; body: Record<string, string>; reason: string | null }[], mono = false) =>
    rows.length > 0 && (
      <>
        <Text size="sm" fw={500} mt="md" mb={4}>
          {title}
        </Text>
        <Table fz="sm">
          <Table.Tbody>
            {rows.map((r) => (
              <Table.Tr key={r.key}>
                <Table.Td ff={mono ? 'monospace' : undefined}>{r.key}</Table.Td>
                <Table.Td>{r.reason ?? ''}</Table.Td>
                <Table.Td w={100} ta="right">
                  {unbanButton(r.body)}
                </Table.Td>
              </Table.Tr>
            ))}
          </Table.Tbody>
        </Table>
      </>
    );
  const whitelist = q.data?.whitelist ?? null;
  const holders = q.data?.levelHolders ?? null;
  const banTypes = banTargets.filter((x) => x !== 'steamId' || banByAccount);

  return (
    <Stack>
      <Group justify="space-between">
        <Title order={2}>{t('players.title')}</Title>
        <Group gap="xs">
          {can.ban && (
            <Button
              leftSection={<IconBan size={16} />}
              variant="default"
              disabled={!running}
              onClick={() => {
                setBanBy(banTypes[0] ?? 'username');
                setBanWho('');
                setDialog({ kind: 'banAny' });
              }}
            >
              {t('players.banAny')}
            </Button>
          )}
          {can.whitelist && (
            <Button leftSection={<IconUserPlus size={16} />} variant="default" disabled={!running} onClick={() => setDialog({ kind: 'whitelist' })}>
              {withPassword ? t('players.whitelistAdd') : t('players.whitelistAddName')}
            </Button>
          )}
        </Group>
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

      {whitelist && has('whitelist') && (
        <Card withBorder>
          <Group justify="space-between" mb={4} wrap="wrap">
            <Text fw={600}>{t('players.whitelist')}</Text>
            {meta?.whitelist?.toggle && can.whitelist && whitelist.enabled !== null && (
              <Switch
                label={t('players.whitelistEnforced')}
                checked={whitelist.enabled}
                disabled={!running}
                onChange={(e) => {
                  const enabled = e.currentTarget.checked;
                  void act(() => sapi('POST', '/players/whitelist/enabled', { enabled }));
                }}
              />
            )}
          </Group>
          <Text size="xs" c="dimmed" mb="xs">
            {whitelist.enabled === true ? t('players.whitelistOn') : whitelist.enabled === false ? t('players.whitelistOff') : t('players.whitelistUnknown')}
          </Text>
          {whitelist.usernames.length === 0 ? (
            <Text size="sm" c="dimmed">
              {t('players.whitelistEmpty')}
            </Text>
          ) : (
            <Table fz="sm">
              <Table.Tbody>
                {whitelist.usernames.map((name) => (
                  <Table.Tr key={name}>
                    <Table.Td>
                      <Group gap={6}>
                        {name}
                        {online.includes(name) && (
                          <Badge size="xs" color="green">
                            {t('players.onlineBadge')}
                          </Badge>
                        )}
                      </Group>
                    </Table.Td>
                    <Table.Td w={100} ta="right">
                      {can.whitelist && (
                        <Button size="compact-xs" variant="subtle" color="red" disabled={!running} onClick={() => removeFromWhitelist(name)}>
                          {t('players.remove')}
                        </Button>
                      )}
                    </Table.Td>
                  </Table.Tr>
                ))}
              </Table.Tbody>
            </Table>
          )}
        </Card>
      )}

      {holders && has('accessLevels') && (
        <Card withBorder>
          <Text fw={600}>{t('players.levelHolders')}</Text>
          <Text size="xs" c="dimmed" mb="xs">
            {t('players.levelHoldersHelp')}
          </Text>
          {holders.length === 0 ? (
            <Text size="sm" c="dimmed">
              {t('players.levelHoldersEmpty')}
            </Text>
          ) : (
            <Table fz="sm">
              <Table.Tbody>
                {holders.map((h) => (
                  <Table.Tr key={h.username}>
                    <Table.Td>{h.username}</Table.Td>
                    <Table.Td>
                      <Badge variant="light" color={levelColor(h.level)}>
                        {levelLabel(h.level)}
                      </Badge>
                    </Table.Td>
                    <Table.Td w={50}>{anyAction && playerMenu(h.username, null, online.includes(h.username))}</Table.Td>
                  </Table.Tr>
                ))}
              </Table.Tbody>
            </Table>
          )}
        </Card>
      )}

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

      {bans && has('ban') && (
        <Card withBorder>
          <Text fw={600} mb="xs">
            {t('players.bans')}
          </Text>
          {unbanStopped && (
            <Text size="xs" c="dimmed" mb="xs">
              {t('players.unbanStopped')}
            </Text>
          )}
          {bans.steamIds.length === 0 && bans.ips.length === 0 && nameBans.length === 0 && uuidBans.length === 0 && accountBans.length === 0 && (
            <Text size="sm" c="dimmed">
              {t('players.noBans')}
            </Text>
          )}
          {nameBans.length > 0 && (
            <>
              <Text size="sm" fw={500} mb={4}>
                {t('players.nameBans')}
              </Text>
              <Table fz="sm">
                <Table.Tbody>
                  {nameBans.map((b) => (
                    <Table.Tr key={b.username}>
                      <Table.Td>{b.username}</Table.Td>
                      <Table.Td>{b.reason ?? ''}</Table.Td>
                      <Table.Td w={100} ta="right">
                        {unbanButton({ username: b.username })}
                      </Table.Td>
                    </Table.Tr>
                  ))}
                </Table.Tbody>
              </Table>
            </>
          )}
          {bans.steamIds.length > 0 && (
            <>
              <Text size="sm" fw={500} mt={nameBans.length ? 'md' : undefined} mb={4}>
                {t('players.steamBans')}
              </Text>
              <Table fz="sm">
                <Table.Tbody>
                  {bans.steamIds.map((b) => (
                    <Table.Tr key={b.steamId}>
                      <Table.Td ff="monospace">{b.steamId}</Table.Td>
                      <Table.Td>{b.reason ?? ''}</Table.Td>
                      <Table.Td w={100} ta="right">
                        {unbanButton({ steamId: b.steamId })}
                      </Table.Td>
                    </Table.Tr>
                  ))}
                </Table.Tbody>
              </Table>
            </>
          )}
          {bans.ips.length > 0 && (
            <>
              <Text size="sm" fw={500} mt="md" mb={4}>
                {t('players.ipBans')}
              </Text>
              {byAddress ? (
                <Text size="xs" c="dimmed" mb="xs">
                  {q.data!.ipBansTrustworthy ? t('players.addressBanNote') : t('players.addressBanWarning')}
                </Text>
              ) : (
                !q.data!.ipBansTrustworthy && (
                  <Text size="xs" c="dimmed" mb="xs">
                    {banByAccount ? t('players.ipBansNote') : t('players.ipBansNoteNames')}
                  </Text>
                )
              )}
              <Table fz="sm">
                <Table.Tbody>
                  {bans.ips.map((b) => (
                    <Table.Tr key={b.ip}>
                      <Table.Td ff="monospace">{b.ip}</Table.Td>
                      <Table.Td>{b.username ?? ''}</Table.Td>
                      <Table.Td>{b.reason ?? ''}</Table.Td>
                      {/* Lifted by address only where the game bans addresses itself. */}
                      <Table.Td w={100} ta="right">
                        {(banByIp || byAddress) && unbanButton({ ip: b.ip })}
                      </Table.Td>
                    </Table.Tr>
                  ))}
                </Table.Tbody>
              </Table>
            </>
          )}
          {banTable(
            t('players.uuidBans'),
            uuidBans.map((b) => ({ key: b.uuid, body: { uuid: b.uuid }, reason: b.reason })),
            true,
          )}
          {banTable(
            t('players.accountBans'),
            accountBans.map((b) => ({ key: b.account, body: { account: b.account }, reason: b.reason })),
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
              : dialog?.kind === 'banAny'
                ? t('players.banAny')
                : dialog?.kind === 'access'
                  ? `${t('players.access')}: ${dialog.name}`
                  : withPassword
                    ? t('players.whitelistAdd')
                    : t('players.whitelistAddName')
        }
      >
        {(dialog?.kind === 'kick' || dialog?.kind === 'ban') && (
          <Stack>
            {dialog.kind === 'ban' && <Text size="sm">{t('players.banHelp')}</Text>}
            {dialog.kind === 'ban' && addressWarning}
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
        {dialog?.kind === 'banAny' && (
          <Stack>
            <Text size="sm">{byAddress ? t('players.banAnyOnlineHelp') : t('players.banAnyHelp')}</Text>
            {addressWarning}
            {/* Two kinds side by side; more (name, address, client ID, account) in a list that fits a phone. */}
            {banTypes.length > 2 ? (
              <Select label={t('players.banBy')} value={banBy} onChange={(v) => v && setBanBy(v as BanTarget)} data={banTypes.map((x) => ({ value: x, label: targetLabel[x] }))} allowDeselect={false} />
            ) : (
              banTypes.length > 1 && <SegmentedControl value={banBy} onChange={(v) => setBanBy(v as BanTarget)} data={banTypes.map((x) => ({ value: x, label: targetLabel[x] }))} />
            )}
            <TextInput
              label={targetLabel[banBy]}
              value={banWho}
              // Names and accounts may have spaces inside (the game says whether it takes them); addresses and ids never do.
              onChange={(e) => setBanWho(banBy === 'username' || banBy === 'account' ? e.currentTarget.value.replace(/["\r\n]/g, '') : e.currentTarget.value.replace(/[\s"]/g, ''))}
              maxLength={banBy === 'ip' ? 45 : banBy === 'uuid' ? 64 : 32}
              data-autofocus
            />
            {banBy === 'ip' && !q.data?.ipBansTrustworthy && (
              <Text size="xs" c="dimmed">
                {banByAccount ? t('players.ipBansNote') : t('players.ipBansNoteNames')}
              </Text>
            )}
            <TextInput label={t('players.reason')} value={reason} onChange={(e) => setReason(e.currentTarget.value.replace(/["\r\n]/g, ''))} maxLength={200} />
            <Button color="red" disabled={!banWho.trim()} onClick={() => void act(() => sapi('POST', '/players/ban', { [banBy]: banWho.trim(), ...(reason && banBy !== 'steamId' ? { reason } : {}) }))}>
              {t('players.ban')}
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
              {withPassword ? t('players.whitelistHelp') : t('players.whitelistNameHelp')}
            </Text>
            <TextInput label={t('auth.username')} value={wl.username} onChange={(e) => setWl({ ...wl, username: e.currentTarget.value })} maxLength={32} data-autofocus />
            {withPassword && <TextInput label={t('players.password')} value={wl.password} onChange={(e) => setWl({ ...wl, password: e.currentTarget.value.replace(/["\r\n\s]/g, '') })} maxLength={64} />}
            <Button
              disabled={!wl.username.trim() || (withPassword && wl.password.length < 4)}
              onClick={() =>
                void act(async () => {
                  const r = await sapi<{ output: string }>('POST', '/players/whitelist', { username: wl.username.trim(), ...(withPassword ? { password: wl.password } : {}) });
                  setWl({ username: '', password: '' });
                  return r;
                })
              }
            >
              {withPassword ? t('players.whitelistAdd') : t('players.whitelistAddName')}
            </Button>
          </Stack>
        )}
      </Modal>
    </Stack>
  );
}
