import { Alert, Badge, Button, Card, Group, NumberInput, Stack, Table, Text, Title } from '@mantine/core';
import { useDisclosure } from '@mantine/hooks';
import { modals } from '@mantine/modals';
import { notifications } from '@mantine/notifications';
import { IconAlertTriangle } from '@tabler/icons-react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '../api/http';
import type { AdaptersResponse } from '../api/meta';
import { SERVERS_KEY, useServerApi, useServerScope, withServer, type ServerSummary } from '../api/server';
import { useLive } from '../api/live';
import { useSession } from '../api/session';
import { useMeta } from '../api/useMeta';
import { LaunchField, launchKey } from '../components/LaunchField';
import { DeleteServerModal, RenameServerModal } from '../components/ServerAdmin';
import { UnsupportedNote } from '../components/Supported';
import { formatBytes, useErrorText } from '../lib/format';

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

/** The server's name and id (SRV-02), renamed in place; the id stays (addresses, folders). */
function NameCard() {
  const { t } = useTranslation();
  const server = useServerScope()?.server ?? null;
  const [open, rename] = useDisclosure();
  if (!server) return null;
  return (
    <Card withBorder>
      <Group justify="space-between" wrap="nowrap" align="flex-start">
        <Stack gap={2} style={{ minWidth: 0 }}>
          <Text fw={600}>{server.name}</Text>
          <Text size="xs" c="dimmed">
            {t('servers.idLine', { id: server.id })}
          </Text>
        </Stack>
        <Button size="xs" variant="default" onClick={rename.open} style={{ flexShrink: 0 }}>
          {t('servers.rename')}
        </Button>
      </Group>
      <RenameServerModal server={server} opened={open} onClose={rename.close} />
    </Card>
  );
}

/**
 * The server's container limits (SRV-05): memory and CPUs, changed through
 * `PATCH /api/servers/:sid`. A stopped server's container is recreated with
 * them at once; a running one's at its game's next start (the list says so
 * until then). The stack's own server has Compose's limits.
 */
function ContainerCard({ server, needMb }: { server: ServerSummary; needMb: number | null }) {
  const { t } = useTranslation();
  const errorText = useErrorText();
  const qc = useQueryClient();
  const sapi = useServerApi();
  const { canHost } = useSession();
  // What the host gives one server; only those who may create servers can ask (the API refuses more anyway).
  const adapters = useQuery({ queryKey: ['adapters'], queryFn: () => api<AdaptersResponse>('GET', '/api/adapters'), enabled: canHost('servers.create'), staleTime: 60_000 });
  const host = adapters.data?.host ?? null;
  const [mem, setMem] = useState<number | null>(server.memLimitMb);
  const [cpus, setCpus] = useState<number | null>(server.cpus);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    setMem(server.memLimitMb);
    setCpus(server.cpus);
  }, [server.memLimitMb, server.cpus]);
  const changed = mem !== server.memLimitMb || cpus !== server.cpus;

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      const next = await sapi<ServerSummary>('PATCH', '', { ...(mem !== server.memLimitMb && mem !== null ? { memLimitMb: mem } : {}), ...(cpus !== server.cpus ? { cpus } : {}) });
      qc.setQueryData<ServerSummary[]>(SERVERS_KEY, (list) => withServer(list, next));
      notifications.show({ color: 'green', message: next.containerPending ? t('server.limitsNextStart') : t('server.limitsApplied') });
    } catch (e) {
      setError(errorText(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card withBorder>
      <Group justify="space-between" mb={4}>
        <Text fw={600}>{t('server.container')}</Text>
        {server.containerPending && (
          <Badge color="orange" variant="light" tt="none">
            {t('servers.pendingStart')}
          </Badge>
        )}
      </Group>
      {!server.managed ? (
        <Text size="sm" c="dimmed">
          {t('server.containerUnmanaged', { limit: server.memLimitMb })}
        </Text>
      ) : (
        <Stack>
          <Text size="sm" c="dimmed">
            {t('server.containerHelp')}
          </Text>
          <Group align="flex-start" gap="md">
            <NumberInput
              label={t('server.memLimit')}
              description={needMb !== null ? t('server.memLimitMin', { min: needMb }) : undefined}
              value={mem ?? ''}
              onChange={(v) => setMem(v === '' ? null : Number(v))}
              min={needMb ?? 256}
              max={host?.maxMemMb ?? undefined}
              step={256}
              allowDecimal={false}
              w={{ base: '100%', xs: 220 }}
            />
            <NumberInput
              label={t('server.cpus')}
              description={t('server.cpusHelp')}
              placeholder={t('server.cpusNone')}
              value={cpus ?? ''}
              onChange={(v) => setCpus(v === '' ? null : Number(v))}
              min={0.25}
              max={host?.cpus ?? undefined}
              step={0.5}
              decimalScale={2}
              w={{ base: '100%', xs: 220 }}
            />
          </Group>
          {host?.maxMemMb && (
            <Text size="xs" c="dimmed">
              {t('create.memoryHostMax', { max: host.maxMemMb })}
            </Text>
          )}
          {error && <Alert color="red">{error}</Alert>}
          <Group>
            <Button onClick={() => void save()} loading={saving} disabled={!changed || mem === null}>
              {t('common.save')}
            </Button>
          </Group>
        </Stack>
      )}
    </Card>
  );
}

export function Server() {
  const { t } = useTranslation();
  const errorText = useErrorText();
  const qc = useQueryClient();
  const live = useLive();
  const sapi = useServerApi();
  const { can } = useSession();
  const server = useServerScope()?.server ?? null;
  const { meta, has } = useMeta();
  const [deleteOpen, del] = useDisclosure();
  const schema = meta?.launch.schema ?? [];
  const launch = useQuery({ queryKey: ['launch', sapi.sid], queryFn: () => sapi<Launch>('GET', '/server/launch') });
  const [form, setForm] = useState<Launch | null>(null);
  useEffect(() => {
    if (launch.data && !form) setForm(launch.data);
  }, [launch.data, form]);
  // Asking for versions runs a job on the server (steamcmd for Steam games): only on request.
  const updates = useQuery({ queryKey: ['updates', sapi.sid], queryFn: () => sapi<Updates>('GET', '/server/updates'), enabled: false, retry: false });
  const body = (l: Launch) => Object.fromEntries(schema.map((o) => [o.key, l[o.key]]));
  const save = useMutation({
    mutationFn: (l: Launch) => sapi<Launch>('PUT', '/server/launch', body(l)),
    onSuccess: (l) => {
      qc.setQueryData(['launch', sapi.sid], l);
      // The game's memory may have moved its container's limit (and left it waiting for the next start).
      void qc.invalidateQueries({ queryKey: SERVERS_KEY });
      setForm(l);
      notifications.show({ color: 'green', message: t('common.saved') });
    },
    onError: (e) => notifications.show({ color: 'red', message: errorText(e) }),
  });
  const busy = !!live.op && !live.op.done;
  const overheadMb = meta?.adapter.memory.overheadMb ?? 0;

  // The adapter names the setting that pins the version and the one that sizes the game (LaunchOption.role).
  const versionKey = launchKey(schema, 'version');
  const memoryKey = launchKey(schema, 'memory');
  const versions = versionKey ? Array.from(new Set([...(updates.data?.branches.map((b) => b.name) ?? []), String(form?.[versionKey] ?? '')])).filter(Boolean) : undefined;
  const versionChanged = versionKey !== undefined && form !== null && launch.data !== undefined && form[versionKey] !== launch.data[versionKey];
  // A managed server's container limit follows the game's memory (the panel moves it, keeping the room above it);
  // the stack's own server keeps Compose's limit, which the game's memory plus the adapter's overhead must fit in.
  const gameMb = memoryKey && typeof form?.[memoryKey] === 'number' ? (form[memoryKey] as number) : null;
  const savedGameMb = memoryKey && typeof launch.data?.[memoryKey] === 'number' ? (launch.data[memoryKey] as number) : null;
  const limitMb = server?.memLimitMb ?? null;
  const tooBig = !server?.managed && gameMb !== null && limitMb !== null && gameMb + overheadMb > limitMb;
  // The least the container may have for the saved launch settings.
  const needMb = savedGameMb !== null ? savedGameMb + overheadMb : null;

  const act = (call: () => Promise<unknown>) => call().catch((e: unknown) => notifications.show({ color: 'red', message: errorText(e) }));
  const countdown = () => ((live.players?.count ?? 0) > 0 ? 300 : 0);

  return (
    <Stack maw={760}>
      <Title order={2}>{t('server.title')}</Title>

      <NameCard />

      <Card withBorder>
        <Text fw={600}>{t('server.launch')}</Text>
        <Text size="sm" c="dimmed" mb="sm">
          {t('server.launchHelp')}
        </Text>
        {launch.error && <Alert color="red">{errorText(launch.error)}</Alert>}
        {form && (
          <Stack>
            {schema.map((o) => (
              <LaunchField key={o.key} o={o} value={form[o.key]} onChange={(v) => setForm({ ...form, [o.key]: v })} versions={o.key === versionKey && o.type === 'string' ? versions : undefined} />
            ))}
            {versionChanged && (
              <Alert color="orange" variant="light" icon={<IconAlertTriangle />}>
                {t('server.versionWarn')}
              </Alert>
            )}
            {limitMb !== null && overheadMb > 0 && memoryKey && (
              <Text size="xs" c={tooBig ? 'orange' : 'dimmed'}>
                {t('server.containerLimit', { limit: formatBytes(limitMb * 1024 * 1024), overhead: formatBytes(overheadMb * 1024 * 1024) })}{' '}
                {server?.managed ? t('server.containerFollows') : tooBig ? t('server.containerTooSmall', { max: limitMb - overheadMb }) : ''}
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

      {server && <ContainerCard server={server} needMb={needMb} />}

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
                <Button size="xs" disabled={busy} onClick={() => void act(() => sapi('POST', '/server/update', { countdownSec: countdown() }))}>
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
          <Button size="xs" variant="default" disabled={busy} onClick={() => void act(() => sapi('POST', '/server/update', { validate: true, countdownSec: countdown() }))}>
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
                onConfirm: () => void act(() => sapi('POST', '/server/kill', {})),
              })
            }
          >
            {t('server.kill')}
          </Button>
        </Group>
        {can('server.delete') && server && (
          <Group justify="space-between" mt="md">
            <Text size="sm" c="dimmed" maw={480}>
              {t('servers.deleteHelp')}
            </Text>
            <Button color="red" onClick={del.open}>
              {t('servers.delete')}
            </Button>
          </Group>
        )}
      </Card>
      {server && <DeleteServerModal server={server} opened={deleteOpen} onClose={del.close} />}
    </Stack>
  );
}
