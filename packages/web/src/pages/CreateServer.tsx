import { Alert, Anchor, Badge, Button, Card, Center, Checkbox, Group, Loader, Modal, NumberInput, Progress, Radio, Select, SimpleGrid, Stack, Text, TextInput, Title } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { IconAlertTriangle, IconInfoCircle } from '@tabler/icons-react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useNavigate } from 'react-router';
import { api, ApiError } from '../api/http';
import { forFlavour, impliedBy, localize, preferredChoice, type AdapterSummary, type AdaptersResponse, type LaunchChoices } from '../api/meta';
import { serverHref, SERVERS_KEY, useServers, withServer, type ServerSummary } from '../api/server';
import { useSession } from '../api/session';
import { AgreementLink } from '../components/Eula';
import { LaunchField, launchDefault, launchKey } from '../components/LaunchField';
import { useErrorText } from '../lib/format';
import { createErrorField, formatRanges, idProblem, MAX_PORT, maxGameMemory, MIN_PORT, nameProblem, portProblem, publishedPorts, slugify, suggestPorts, type CreateField } from '../lib/servers';

type Launch = Record<string, unknown>;

/**
 * A launch form's starting values: each setting's default from the schema,
 * the memory one from the adapter, lowered to what the host gives one
 * server (`maxGameMb`) when that is less.
 */
function launchDefaults(a: AdapterSummary, maxGameMb: number | null): Launch {
  const memoryKey = launchKey(a.launch.schema, 'memory');
  return Object.fromEntries(
    a.launch.schema.map((o) => {
      if (o.key !== memoryKey) return [o.key, launchDefault(o)];
      const dflt = o.default === undefined ? a.memory.defaultMb : Number(o.default);
      return [o.key, maxGameMb !== null && maxGameMb < dflt ? Math.max(maxGameMb, a.memory.minMb, o.min ?? 0) : dflt];
    }),
  );
}

/** Why this host can't run a game (HST-05), or null. */
function useUnsupported(host: AdaptersResponse['host']): (a: AdapterSummary) => string | null {
  const { t } = useTranslation();
  return (a) => (a.supported === false ? t('create.archUnsupported', { arch: a.arch.join(', '), host: host?.arch ?? '?' }) : null);
}

/**
 * Creating a server (SRV-01): the game (games this host can't run are shown
 * but can't be picked, HST-05), its flavour, a name and id, the ports
 * players connect to and its memory. The panel checks everything again;
 * what it refuses is shown on the field it is about.
 */
export function CreateServer() {
  const { t, i18n } = useTranslation();
  const errorText = useErrorText();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const servers = useServers();
  const adapters = useQuery({ queryKey: ['adapters'], queryFn: () => api<AdaptersResponse>('GET', '/api/adapters'), staleTime: 60_000 });
  const unsupported = useUnsupported(adapters.data?.host ?? null);
  const l = (v: Parameters<typeof localize>[0]) => localize(v, i18n.language);
  // D6: only the owner accepts a game's license.
  const mayAcceptEula = useSession().can('server.eula');

  const [adapterId, setAdapterId] = useState<string | null>(null);
  const [flavour, setFlavour] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [id, setId] = useState('');
  const [idEdited, setIdEdited] = useState(false);
  const [ports, setPorts] = useState<Record<string, number | null>>({});
  const [launch, setLaunch] = useState<Launch>({});
  const [memLimitMb, setMemLimitMb] = useState<number | null>(null);
  const [eula, setEula] = useState(false);
  const [tried, setTried] = useState(false);
  const [creating, setCreating] = useState(false);
  const [apiErrors, setApiErrors] = useState<Partial<Record<CreateField, string>>>({});
  const [general, setGeneral] = useState<string | null>(null);
  /** The game and flavour whose versions were last picked for you (`adapter/flavour`). */
  const [picked, setPicked] = useState<string | null>(null);

  const list = useMemo(() => servers.data ?? [], [servers.data]);
  const adapter = adapters.data?.adapters.find((a) => a.id === adapterId) ?? null;
  const published = useMemo(() => (adapter ? publishedPorts(adapter.ports) : []), [adapter]);
  const taken = useMemo(() => list.flatMap((s) => s.ports.map((p) => ({ port: p.port, proto: p.proto, by: s.name }))), [list]);
  const host = adapters.data?.host ?? null;
  const ranges = host?.hostPorts ?? null;
  const suggested = useMemo(() => (adapter ? suggestPorts(adapter.ports, taken, ranges) : null), [adapter, taken, ranges]);
  const memoryKey = adapter ? launchKey(adapter.launch.schema, 'memory') : undefined;
  const memoryOption = adapter?.launch.schema.find((o) => o.key === memoryKey);
  // What the host gives one server (SRV-05): the game's memory can't take the container above it.
  const maxGameMb = adapter ? maxGameMemory(host?.maxMemMb, adapter.memory.overheadMb, memoryOption?.step) : null;

  // What the version (and what depends on it) may be, from the game's download services (UPD-02): asked
  // again as the flavour and version change; the list stays up meanwhile.
  const versionKey = adapter ? launchKey(adapter.launch.schema, 'version') : undefined;
  const versionValue = versionKey && typeof launch[versionKey] === 'string' ? (launch[versionKey] as string) : '';
  const flavourReady = !!adapter && (adapter.flavours.length === 0 ? flavour === null : adapter.flavours.some((f) => f.id === flavour));
  const choices = useQuery({
    queryKey: ['choices', adapter?.id ?? null, flavour, versionValue],
    queryFn: () => {
      const q = new URLSearchParams();
      if (flavour) q.set('flavour', flavour);
      if (versionValue) q.set('version', versionValue);
      return api<LaunchChoices>('GET', `/api/adapters/${encodeURIComponent(adapter!.id)}/choices?${q.toString()}`);
    },
    enabled: !!adapter?.launch.choices && flavourReady,
    staleTime: 5 * 60_000,
    retry: false,
    placeholderData: (prev, prevQuery) => (prevQuery?.queryKey[1] === (adapter?.id ?? null) && prevQuery?.queryKey[2] === flavour ? prev : undefined),
  });

  // The first game this host can run is picked for you (once the other servers' ports are known).
  useEffect(() => {
    if (adapterId || !adapters.data || !servers.data) return;
    const first = adapters.data.adapters.find((a) => a.supported !== false);
    if (first) setAdapterId(first.id);
  }, [adapters.data, servers.data, adapterId]);

  // Another game: its flavour, suggested ports, launch defaults and memory. Only when the game changes,
  // so a refreshed server list never overwrites what was typed.
  const pickedId = adapter?.id;
  useEffect(() => {
    if (!adapter) return;
    setFlavour(adapter.flavours[0]?.id ?? null);
    setLaunch(launchDefaults(adapter, maxGameMb));
    const total = adapter.memory.defaultMb + adapter.memory.overheadMb;
    setMemLimitMb(host?.maxMemMb ? Math.min(total, host.maxMemMb) : total);
    setPorts(suggested ?? Object.fromEntries(published.map((d) => [d.id, null])));
    setEula(false);
    setApiErrors({});
    // Its versions are picked for you again once they are listed.
    setPicked(null);
    // The rest is read as it is when the game changes.
  }, [pickedId]);

  // A game or flavour listed for the first time: its newest version that needs no warning (Q13), and what it implies.
  useEffect(() => {
    if (!adapter || !versionKey || !choices.data || choices.isPlaceholderData) return;
    const key = `${adapter.id}/${flavour ?? ''}`;
    if (picked === key) return;
    setPicked(key);
    const versions = choices.data[versionKey];
    const pick = preferredChoice(versions);
    if (pick && versions) setLaunch((cur) => ({ ...cur, [versionKey]: pick.value, ...impliedBy(pick, versions, adapter.launch.schema) }));
  }, [adapter, versionKey, choices.data, choices.isPlaceholderData, flavour, picked]);

  if (adapters.isLoading || servers.isLoading) {
    return (
      <Center mt="xl">
        <Loader />
      </Center>
    );
  }
  if (adapters.error) return <Alert color="red">{errorText(adapters.error)}</Alert>;
  const data = adapters.data!;

  // What's wrong before sending (the API says the same, and more).
  const names = list.map((s) => s.name);
  const ids = list.map((s) => s.id);
  const nameErr = nameProblem(name, names);
  const idErr = idProblem(id, ids);
  const portErr = (pid: string): string | null => {
    const p = portProblem(pid, ports, adapter?.ports ?? [], taken, ranges);
    if (!p) return null;
    switch (p.kind) {
      case 'outside':
        return t('errors.invalid-port-ranges', { ranges: formatRanges(ranges ?? []) });
      case 'invalid':
        return t('errors.invalid-port', { min: MIN_PORT, max: MAX_PORT });
      case 'twice':
        return t('create.portTwice');
      case 'taken':
        return t('create.portTaken', { port: ports[pid], server: p.by });
    }
  };
  const gameMemory = memoryKey && typeof launch[memoryKey] === 'number' ? (launch[memoryKey] as number) : null;
  const memMin = adapter ? Math.max(memoryOption?.min ?? 0, adapter.memory.minMb) : 0;
  const hostMax = host?.maxMemMb ?? null;
  const memErr = (() => {
    if (!adapter) return null;
    // The game can't fit in what the host gives one server, whatever is typed.
    if (hostMax !== null && hostMax < adapter.memory.minMb + adapter.memory.overheadMb) return t('create.hostTooSmall', { max: hostMax, need: adapter.memory.minMb + adapter.memory.overheadMb });
    if (memoryKey) {
      if (gameMemory === null || gameMemory < memMin) return t('create.memoryMin', { min: memMin });
      if (memoryOption?.step && gameMemory % memoryOption.step !== 0) return t('create.memoryStep', { step: memoryOption.step });
      if (maxGameMb !== null && gameMemory > maxGameMb) return t('create.memoryMax', { max: maxGameMb, limit: hostMax });
      return null;
    }
    if (memLimitMb === null || memLimitMb < adapter.memory.minMb + adapter.memory.overheadMb) return t('create.memoryMin', { min: adapter.memory.minMb + adapter.memory.overheadMb });
    if (hostMax !== null && memLimitMb > hostMax) return t('create.memoryMax', { max: hostMax, limit: hostMax });
    return null;
  })();
  const launchMissing = adapter ? adapter.launch.schema.some((o) => o.key !== memoryKey && (o.type === 'integer' || o.type === 'decimal') && typeof launch[o.key] !== 'number') : false;
  const valid = !!adapter && unsupported(adapter) === null && !nameErr && !idErr && published.every((d) => portErr(d.id) === null) && !memErr && !launchMissing && (!adapter.eula || !mayAcceptEula || eula);
  // Typing clears what the API said about that field.
  const clear = (f: CreateField) => setApiErrors((e) => ({ ...e, [f]: undefined }));
  const shown = (f: CreateField, local: string | null, touched: boolean) => apiErrors[f] ?? (touched || tried ? (local ?? undefined) : undefined);

  const onName = (v: string) => {
    setName(v);
    clear('name');
    if (!idEdited) {
      setId(slugify(v));
      clear('id');
    }
  };

  const create = async () => {
    setTried(true);
    if (!valid || !adapter) return;
    setCreating(true);
    setGeneral(null);
    setApiErrors({});
    // Ports left empty are the panel's to pick, inside what the host allows.
    const sentPorts = Object.fromEntries(published.flatMap((d) => (typeof ports[d.id] === 'number' ? [[d.id, ports[d.id]!]] : [])));
    try {
      const created = await api<ServerSummary>('POST', '/api/servers', {
        id,
        name: name.trim(),
        adapter: adapter.id,
        ...(adapter.flavours.length ? { flavour } : {}),
        launch,
        ports: sentPorts,
        ...(memoryKey ? {} : { memLimitMb }),
        ...(adapter.eula && mayAcceptEula ? { eulaAccepted: eula } : {}),
      });
      qc.setQueryData<ServerSummary[]>(SERVERS_KEY, (cur) => withServer(cur, created));
      notifications.show({ color: 'green', message: t('create.created', { name: created.name }) });
      navigate(serverHref(created.id, '/'));
    } catch (e) {
      if (e instanceof ApiError) {
        const { field, port } = createErrorField(e.code, e.extra, adapter.ports, sentPorts);
        const text = e.code === 'port-conflict' && port !== undefined ? t('errors.port-conflict', { port }) : errorText(e);
        if (field) setApiErrors({ [field]: text });
        else setGeneral(text);
      } else setGeneral(errorText(e));
    } finally {
      setCreating(false);
    }
  };

  const overhead = adapter?.memory.overheadMb ?? 0;

  return (
    <Stack maw={760}>
      <Group justify="space-between">
        <Title order={2}>{t('create.title')}</Title>
        <Anchor component={Link} to="/servers" size="sm">
          {t('common.cancel')}
        </Anchor>
      </Group>
      <Text size="sm" c="dimmed">
        {t('create.intro')}
      </Text>

      <Card withBorder>
        <Text fw={600} mb="xs">
          {t('create.game')}
        </Text>
        {data.host === null && (
          <Alert color="yellow" variant="light" icon={<IconAlertTriangle />} mb="sm">
            {t('create.hostUnknown')}
          </Alert>
        )}
        {data.adapters.length === 0 ? (
          <Text size="sm" c="dimmed">
            {t('create.noGames')}
          </Text>
        ) : (
          <Radio.Group value={adapterId} onChange={setAdapterId}>
            <SimpleGrid cols={{ base: 1, sm: 2 }}>
              {data.adapters.map((a) => {
                const why = unsupported(a);
                return (
                  <Radio.Card key={a.id} value={a.id} disabled={why !== null} p="sm" radius="md" style={{ opacity: why ? 0.6 : 1 }}>
                    <Group wrap="nowrap" align="flex-start">
                      <Radio.Indicator disabled={why !== null} />
                      <Stack gap={2}>
                        <Text fw={600} size="sm">
                          {l(a.name)}
                        </Text>
                        {why ? (
                          <Text size="xs" c="orange">
                            {why}
                          </Text>
                        ) : (
                          <Text size="xs" c="dimmed">
                            {t('create.gameLine', { ports: publishedPorts(a.ports).length, memory: a.memory.defaultMb })}
                          </Text>
                        )}
                      </Stack>
                    </Group>
                  </Radio.Card>
                );
              })}
            </SimpleGrid>
          </Radio.Group>
        )}
        {adapter && adapter.flavours.length > 0 && (
          <Select mt="md" w={{ base: '100%', xs: 320 }} label={t('create.flavour')} data={adapter.flavours.map((f) => ({ value: f.id, label: l(f.name) }))} value={flavour} onChange={setFlavour} allowDeselect={false} />
        )}
        {apiErrors.game && (
          <Alert color="red" mt="sm">
            {apiErrors.game}
          </Alert>
        )}
      </Card>

      {adapter && (
        <>
          <Card withBorder>
            <Text fw={600} mb="xs">
              {t('create.naming')}
            </Text>
            <SimpleGrid cols={{ base: 1, sm: 2 }}>
              <TextInput label={t('servers.name')} description={t('create.nameHelp')} value={name} onChange={(e) => onName(e.currentTarget.value)} maxLength={64} error={shown('name', nameErr && t(`errors.${nameErr}`), name !== '')} data-autofocus />
              <TextInput
                label={t('create.id')}
                description={t('create.idHelp')}
                value={id}
                onChange={(e) => {
                  setId(e.currentTarget.value.toLowerCase().replace(/[^a-z0-9-]/g, ''));
                  setIdEdited(true);
                  clear('id');
                }}
                maxLength={24}
                error={shown('id', idErr && t(`errors.${idErr}`), id !== '')}
                autoComplete="off"
                spellCheck={false}
              />
            </SimpleGrid>
          </Card>

          {published.length > 0 && (
            <Card withBorder>
              <Group justify="space-between" mb={4}>
                <Text fw={600}>{t('create.ports')}</Text>
                {suggested && (
                  <Button size="compact-xs" variant="subtle" onClick={() => setPorts(suggested)}>
                    {t('create.suggest')}
                  </Button>
                )}
              </Group>
              <Text size="xs" c="dimmed" mb="sm">
                {t('create.portsHelp')} {ranges?.length ? t('create.portsAllowed', { ranges: formatRanges(ranges) }) : ''}
              </Text>
              <SimpleGrid cols={{ base: 1, sm: 2 }}>
                {published.map((d) => (
                  <NumberInput
                    key={d.id}
                    label={`${l(d.label)} (${d.proto.toUpperCase()})`}
                    value={ports[d.id] ?? ''}
                    onChange={(v) => {
                      setPorts({ ...ports, [d.id]: v === '' ? null : Number(v) });
                      clear(`port:${d.id}`);
                    }}
                    min={MIN_PORT}
                    max={MAX_PORT}
                    allowDecimal={false}
                    hideControls
                    placeholder={t('create.portAuto')}
                    error={shown(`port:${d.id}`, portErr(d.id), true)}
                  />
                ))}
              </SimpleGrid>
            </Card>
          )}

          <Card withBorder>
            <Text fw={600} mb={4}>
              {t('create.memory')}
            </Text>
            <Text size="xs" c="dimmed" mb="sm">
              {t('create.memoryHelp', { overhead })} {hostMax !== null ? t('create.memoryHostMax', { max: hostMax }) : ''}
            </Text>
            <Stack>
              {memoryOption ? (
                <LaunchField
                  o={memoryOption}
                  value={launch[memoryOption.key]}
                  min={memMin}
                  max={maxGameMb !== null ? Math.min(maxGameMb, memoryOption.max ?? maxGameMb) : undefined}
                  onChange={(v) => {
                    setLaunch({ ...launch, [memoryOption.key]: v });
                    clear('memory');
                  }}
                  error={shown('memory', memErr, true)}
                />
              ) : (
                <NumberInput
                  label={t('create.memLimit')}
                  value={memLimitMb ?? ''}
                  onChange={(v) => {
                    setMemLimitMb(v === '' ? null : Number(v));
                    clear('memory');
                  }}
                  min={adapter.memory.minMb + overhead}
                  max={hostMax ?? undefined}
                  step={256}
                  allowDecimal={false}
                  maw={260}
                  error={shown('memory', memErr, true)}
                />
              )}
              {memoryOption && gameMemory !== null && (
                <Text size="xs" c="dimmed">
                  {t('create.containerTotal', { total: gameMemory + overhead })}
                </Text>
              )}
              {choices.error && (
                <Alert color="yellow" variant="light" icon={<IconAlertTriangle />}>
                  {t('create.choicesUnavailable', { error: errorText(choices.error) })}
                </Alert>
              )}
              {adapter.launch.schema
                // Settings of other flavours (a loader's own) are kept at their defaults, out of sight.
                .filter((o) => o.key !== memoryKey && forFlavour(o, flavour))
                .map((o) => {
                  const list = choices.data?.[o.key];
                  return (
                    <LaunchField
                      key={o.key}
                      o={o}
                      value={launch[o.key]}
                      choices={list}
                      warnings={adapter.launch.warnings}
                      onChange={(v) => {
                        setLaunch({ ...launch, [o.key]: v });
                        clear('launch');
                      }}
                      onChoice={(c) => list && setLaunch((cur) => ({ ...cur, [o.key]: c.value, ...impliedBy(c, list, adapter.launch.schema) }))}
                    />
                  );
                })}
              {apiErrors.launch && <Alert color="red">{apiErrors.launch}</Alert>}
              {adapter.launch.secrets.length > 0 && (
                <Text size="xs" c="dimmed">
                  {t('create.secrets', { list: adapter.launch.secrets.map((s) => l(s.label)).join('; ') })}
                </Text>
              )}
            </Stack>
          </Card>

          {adapter.eula && (
            <Card withBorder>
              {/* D6: only the owner accepts a game's license; anyone else creates the server with it waiting for them. */}
              {mayAcceptEula ? (
                <Stack gap="xs">
                  {adapter.agreement && <AgreementLink agreement={adapter.agreement} />}
                  <Checkbox label={t('create.eula', { game: l(adapter.name) })} checked={eula} onChange={(e) => setEula(e.currentTarget.checked)} error={tried && !eula ? t('errors.eula-required') : undefined} />
                </Stack>
              ) : (
                <Text size="sm">{t('create.eulaOwner', { game: l(adapter.name) })}</Text>
              )}
            </Card>
          )}

          {general && (
            <Alert color="red" icon={<IconAlertTriangle />}>
              {general}
            </Alert>
          )}
          <Group justify="space-between" wrap="wrap">
            <Text size="sm" c="dimmed">
              {valid ? t('create.ready', { name: name.trim(), game: l(adapter.name) }) : tried ? t('create.fix') : ''}
            </Text>
            <Button onClick={() => void create()} loading={creating} disabled={tried && !valid}>
              {t('create.submit')}
            </Button>
          </Group>
        </>
      )}

      <Modal opened={creating} onClose={() => undefined} withCloseButton={false} centered closeOnClickOutside={false} closeOnEscape={false}>
        <Stack>
          <Group gap="sm" wrap="nowrap">
            <Loader size="sm" />
            <Text fw={600}>{t('create.creating', { name: name.trim() })}</Text>
          </Group>
          <Progress value={100} animated striped />
          <Group gap={6} wrap="nowrap" align="flex-start">
            <IconInfoCircle size={16} style={{ flexShrink: 0, marginTop: 2 }} />
            <Text size="sm" c="dimmed">
              {t('create.creatingHelp')}
            </Text>
          </Group>
          <Badge variant="light" tt="none" style={{ alignSelf: 'flex-start' }}>
            {id}
          </Badge>
        </Stack>
      </Modal>
    </Stack>
  );
}
