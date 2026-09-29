import { ActionIcon, Alert, Anchor, Badge, Button, Card, Checkbox, FileButton, Group, Image, Stack, Switch, Text, Textarea, TextInput, Title, Tooltip } from '@mantine/core';
import { modals } from '@mantine/modals';
import { notifications } from '@mantine/notifications';
import { IconAlertTriangle, IconArrowDown, IconArrowUp, IconExternalLink, IconTrash, IconUpload } from '@tabler/icons-react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ApiError } from '../api/http';
import { useServerApi } from '../api/server';
import { useLive } from '../api/live';
import type { Capability, ModSourceMeta } from '../api/meta';
import { useMeta } from '../api/useMeta';
import { OpBanner } from '../components/OpBanner';
import { formatBytes, formatDateTime, useErrorText } from '../lib/format';

interface ScannedMod {
  modId: string;
  name: string;
  versionFolder: string | null;
  compatible: boolean;
  reason: string | null;
  require: string[];
  /** Map folders the mod adds, for games with maps. */
  maps?: string[];
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
  // The API also sends the config lines the enabled list turns into (`lines`, keyed by the game's own
  // setting names); the page doesn't show them.
}

/** How the web shows a mod source, by its capability; a source without a view here is named but not browsable. */
const VIEWS: Partial<Record<Capability, { itemUrl: (id: string) => string }>> = {
  // Steam Workshop items (any Steam game's Workshop): today's list with load order.
  'mods:workshop': { itemUrl: (id) => `https://steamcommunity.com/sharedfiles/filedetails/?id=${encodeURIComponent(id)}` },
};

/**
 * The server's mod sources, each its own way: a catalogue's items and load
 * order (the panel serves one catalogue per server), or plugin files people
 * bring (MOD-06).
 */
export function Mods() {
  const { t } = useTranslation();
  const { meta, l } = useMeta();
  const sources = meta?.modSources ?? [];
  if (sources.length === 0) return null;
  return (
    <Stack gap="xl">
      {sources.map((source) => {
        if (source.kind === 'files') return <PluginFiles key={source.id} source={source} />;
        const view = VIEWS[source.capability];
        if (!view) {
          return (
            <Stack key={source.id} maw={640}>
              <Title order={2}>{t('mods.title')}</Title>
              <Alert variant="light">{t('mods.noView', { source: l(source.label) })}</Alert>
            </Stack>
          );
        }
        return <SourceMods key={source.id} sourceName={l(source.label)} itemUrl={view.itemUrl} />;
      })}
    </Stack>
  );
}

function SourceMods({ sourceName, itemUrl }: { sourceName: string; itemUrl: (id: string) => string }) {
  const { t } = useTranslation();
  const errorText = useErrorText();
  const qc = useQueryClient();
  const live = useLive();
  const sapi = useServerApi();
  const q = useQuery({ queryKey: ['mods', sapi.sid], queryFn: () => sapi<ModsResponse>('GET', '/mods') });
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
      const r = await sapi<{ restartNeeded: boolean }>('PUT', '/mods/enabled', { enabled });
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
      const r = await sapi<{ added: string[] }>('POST', '/mods', { refs: list });
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
              void sapi<{ updates: string[] }>('POST', '/mods/check', {}).then((r) => {
                notifications.show({ color: r.updates.length ? 'orange' : 'green', message: r.updates.length ? t('mods.updatesFound', { count: r.updates.length }) : t('mods.noUpdates') });
                refresh();
              }, fail)
            }
          >
            {t('mods.check')}
          </Button>
          <Button variant="default" size="xs" disabled={busy || !data?.items.length} onClick={() => void sapi('POST', '/mods/download', {}).catch(fail)}>
            {t('mods.download')}
          </Button>
        </Group>
      </Group>
      <Text size="sm" c="dimmed">
        {t('mods.intro', { source: sourceName })}
      </Text>
      <OpBanner />

      <Card withBorder>
        <Stack gap="xs">
          <Textarea value={refs} onChange={(e) => setRefs(e.currentTarget.value)} placeholder={t('mods.addPlaceholder', { source: sourceName })} autosize minRows={2} maxRows={6} aria-label={t('mods.add')} />
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
          <Button size="compact-xs" variant="default" disabled={enabled.length < 2} onClick={() => void sapi('POST', '/mods/sort', {}).then(refresh, fail)}>
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

      <Text fw={600}>{t('mods.installed', { source: sourceName })}</Text>
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
                  <Anchor href={itemUrl(item.workshopId)} target="_blank" rel="noreferrer noopener" size="xs">
                    <Group gap={2}>
                      {t('mods.open', { source: sourceName })} <IconExternalLink size={12} />
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
                        onConfirm: () => void sapi('DELETE', `/mods/${item.workshopId}`).then(refresh, fail),
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
                        {!!m.maps?.length && (
                          <Badge size="xs" color="teal" variant="light">
                            map: {(m.maps ?? []).join(', ')}
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

// ------------------------------------------------------------------ plugin files (MOD-06)

type FilesSource = Extract<ModSourceMeta, { kind: 'files' }>;

interface PluginEntry {
  name: string;
  enabled: boolean;
  /** The server runs with this very file (put in place for its last start). */
  active: boolean;
  size: number;
  sha256: string;
  mtimeMs: number;
  origin: { addedAt: string; addedBy: string | null; from: { upload: string; size: number; sha256: string | null } | { url: string } } | null;
}

interface PluginAdd {
  added: PluginEntry[];
  replaced: string[];
  skipped: string[];
  restartNeeded: boolean;
}

/**
 * Plugin files people bring (MOD-06): uploaded (a plugin file or a zip of
 * them) or added from a release link the server downloads itself; enabled,
 * disabled and removed, each taking effect at the next start. A plugin runs
 * code inside the server: the source's warning is on the page, and asked
 * again before every add.
 */
function PluginFiles({ source }: { source: FilesSource }) {
  const { t, i18n } = useTranslation();
  const { l } = useMeta();
  const errorText = useErrorText();
  const qc = useQueryClient();
  const sapi = useServerApi();
  const q = useQuery({ queryKey: ['plugins', sapi.sid], queryFn: () => sapi<{ plugins: PluginEntry[]; restartNeeded: boolean }>('GET', '/plugins') });
  const [link, setLink] = useState('');
  const [adding, setAdding] = useState(false);
  const refresh = () => void qc.invalidateQueries({ queryKey: ['plugins'] });
  const accept = [...source.extensions, '.zip'];
  const max = formatBytes(source.maxBytes);

  const fail = (e: unknown) => {
    if (e instanceof ApiError && e.code === 'plugin-refused') {
      const reason = String(e.extra.reason ?? '');
      notifications.show({
        color: 'red',
        title: t(`mods.plugins.refused.${reason}`, { defaultValue: t('errors.plugin-refused') }),
        message: typeof e.extra.message === 'string' ? e.extra.message : '',
      });
      return;
    }
    notifications.show({ color: 'red', message: errorText(e) });
  };

  const added = (r: PluginAdd) => {
    const names = r.added.map((f) => f.name).join(', ');
    const more = [r.replaced.length ? t('mods.plugins.replaced', { names: r.replaced.join(', ') }) : '', r.skipped.length ? t('mods.plugins.skipped', { names: r.skipped.join(', ') }) : ''].filter(Boolean).join(' · ');
    notifications.show({ color: r.restartNeeded ? 'orange' : 'green', title: t(r.restartNeeded ? 'mods.plugins.addedRestart' : 'mods.plugins.added', { names }), message: more });
    refresh();
  };

  /** Every add waits for the warning to be read and accepted. */
  const confirmAdd = (what: string, go: () => Promise<PluginAdd>) =>
    modals.openConfirmModal({
      title: t('mods.plugins.confirmTitle'),
      children: (
        <Stack gap="xs">
          <Alert color="orange" variant="light" icon={<IconAlertTriangle size={18} />}>
            {l(source.warning)}
          </Alert>
          <Text size="sm" ff="monospace" style={{ wordBreak: 'break-all' }}>
            {what}
          </Text>
        </Stack>
      ),
      labels: { confirm: t('mods.plugins.confirmAdd'), cancel: t('common.cancel') },
      confirmProps: { color: 'orange' },
      onConfirm: () => {
        setAdding(true);
        void go()
          .then(added, fail)
          .finally(() => setAdding(false));
      },
    });

  const upload = (file: File | null) => {
    if (!file) return;
    if (file.size > source.maxBytes) {
      notifications.show({ color: 'red', title: t('mods.plugins.refused.too-large'), message: t('mods.plugins.tooLarge', { name: file.name, max }) });
      return;
    }
    confirmAdd(file.name, () => {
      const form = new FormData();
      form.append('file', file);
      return sapi<PluginAdd>('POST', '/plugins/upload', form);
    });
  };

  const addLink = () => {
    const url = link.trim();
    if (!url) return;
    confirmAdd(url, async () => {
      const r = await sapi<PluginAdd>('POST', '/plugins', { url });
      setLink('');
      return r;
    });
  };

  const setEnabled = (p: PluginEntry, enabled: boolean) =>
    void sapi<{ changed: boolean; restartNeeded: boolean }>('PUT', `/plugins/${encodeURIComponent(p.name)}`, { enabled }).then((r) => {
      if (r.restartNeeded) notifications.show({ color: 'orange', message: t('mods.plugins.restartNeeded') });
      refresh();
    }, fail);

  const remove = (p: PluginEntry) =>
    modals.openConfirmModal({
      title: t('mods.remove'),
      children: <Text size="sm">{t('mods.plugins.removeConfirm', { name: p.name })}</Text>,
      labels: { confirm: t('mods.remove'), cancel: t('common.cancel') },
      confirmProps: { color: 'red' },
      onConfirm: () =>
        void sapi<{ restartNeeded: boolean }>('DELETE', `/plugins/${encodeURIComponent(p.name)}`).then((r) => {
          if (r.restartNeeded) notifications.show({ color: 'orange', message: t('mods.plugins.restartNeeded') });
          refresh();
        }, fail),
    });

  const origin = (p: PluginEntry) => {
    if (!p.origin) return t('mods.plugins.originUnknown');
    const from = 'url' in p.origin.from ? p.origin.from.url : p.origin.from.upload;
    return t('mods.plugins.origin', { by: p.origin.addedBy ?? t('mods.plugins.bySystem'), date: formatDateTime(p.origin.addedAt, i18n.language, false), from });
  };

  const plugins = q.data?.plugins ?? [];
  return (
    <Stack>
      <Title order={2}>{l(source.label)}</Title>
      <Text size="sm" c="dimmed">
        {t('mods.plugins.intro', { extensions: source.extensions.join(', '), max })}
      </Text>
      <Alert color="orange" variant="light" icon={<IconAlertTriangle size={18} />} title={t('mods.plugins.warningTitle')}>
        {l(source.warning)}
      </Alert>
      {q.data?.restartNeeded && (
        <Alert color="orange" variant="light">
          {t('mods.plugins.restartNeeded')}
        </Alert>
      )}

      <Card withBorder>
        <Stack gap="sm">
          <Group justify="space-between" wrap="wrap">
            <Text fw={600}>{t('mods.plugins.add')}</Text>
            <FileButton onChange={upload} accept={accept.join(',')}>
              {(props) => (
                <Button {...props} variant="default" leftSection={<IconUpload size={16} />} loading={adding}>
                  {t('mods.plugins.upload')}
                </Button>
              )}
            </FileButton>
          </Group>
          {source.linkHint && (
            <Group align="flex-end" wrap="nowrap">
              <TextInput
                style={{ flex: 1, minWidth: 0 }}
                label={t('mods.plugins.link')}
                description={l(source.linkHint)}
                placeholder="https://"
                value={link}
                onChange={(e) => setLink(e.currentTarget.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') addLink();
                }}
              />
              <Button onClick={addLink} disabled={!link.trim()} loading={adding}>
                {t('mods.plugins.addLink')}
              </Button>
            </Group>
          )}
        </Stack>
      </Card>

      {q.data && plugins.length === 0 && (
        <Text size="sm" c="dimmed">
          {t('mods.plugins.empty')}
        </Text>
      )}
      {plugins.map((p) => (
        <Card key={p.name} withBorder padding="sm">
          <Group justify="space-between" wrap="nowrap" align="flex-start">
            <Stack gap={4} style={{ flex: 1, minWidth: 0 }}>
              <Group gap={6}>
                <Switch size="sm" checked={p.enabled} onChange={(e) => setEnabled(p, e.currentTarget.checked)} aria-label={t('mods.plugins.enabled')} />
                <Text size="sm" ff="monospace" fw={600} style={{ wordBreak: 'break-all' }}>
                  {p.name}
                </Text>
                <Text size="xs" c="dimmed">
                  {formatBytes(p.size)}
                </Text>
                {p.enabled && !p.active && (
                  <Badge size="xs" color="orange">
                    {t('mods.plugins.pendingOn')}
                  </Badge>
                )}
                {!p.enabled && p.active && (
                  <Badge size="xs" color="orange">
                    {t('mods.plugins.pendingOff')}
                  </Badge>
                )}
                {p.enabled && p.active && (
                  <Badge size="xs" color="teal" variant="light">
                    {t('mods.plugins.active')}
                  </Badge>
                )}
              </Group>
              <Text size="xs" c="dimmed" style={{ wordBreak: 'break-all' }}>
                {origin(p)}
              </Text>
              <Tooltip label={p.sha256} multiline w={300}>
                <Text size="xs" c="dimmed" ff="monospace" w="fit-content">
                  {t('mods.plugins.sha')} {p.sha256.slice(0, 16)}…
                </Text>
              </Tooltip>
            </Stack>
            <ActionIcon variant="subtle" color="red" aria-label={t('mods.remove')} onClick={() => remove(p)}>
              <IconTrash size={16} />
            </ActionIcon>
          </Group>
        </Card>
      ))}
    </Stack>
  );
}
