import { Alert, Button, Center, Loader, Menu, Stack, Tabs, Text, Title } from '@mantine/core';
import { modals } from '@mantine/modals';
import { notifications } from '@mantine/notifications';
import { IconAlertTriangle, IconChevronDown } from '@tabler/icons-react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { useSearchParams } from 'react-router';
import { get, post, put } from '../../api/http';
import { useErrorText } from '../../lib/format';
import { ConfigFiles } from './ConfigFiles';
import { ConfigHistory } from './ConfigHistory';
import type { ApplyResult, ConfigMeta, Value } from './options';
import { OptionsForm } from './OptionsForm';

const INI_GROUPS: [string, (k: string) => boolean][] = [
  ['general', (k) => ['PublicName', 'PublicDescription', 'ServerWelcomeMessage', 'Public', 'Open', 'Password', 'MaxPlayers', 'PauseEmpty', 'SaveWorldEveryMinutes', 'Seed', 'ResetID'].includes(k)],
  ['pvp', (k) => /^(PVP|Safety|ShowSafety|War)/.test(k)],
  ['safehouses', (k) => /^(PlayerSafehouse|AdminSafehouse|Safehouse|SafeHouse|MaxSafezoneSize|DisableSafehouse|Faction)/.test(k)],
  ['chat', (k) => /^(GlobalChat|ChatStreams|ChatMessage|Voice|BadWord|GoodWord|DisableRadio)/.test(k)],
  ['backups', (k) => k.startsWith('Backups')],
  ['anticheat', (k) => /^(AntiCheat|DoLuaChecksum|SteamVAC|MaxPacketsPerSecond|SpeedLimit|ClientCommandFilter|ClientActionLogs|PerkLogs|ItemNumbersLimit)/.test(k)],
  [
    'players',
    (k) =>
      /^(SpawnItems|SpawnPoint|Sleep|PlayerRespawn|DropOffWhiteList|MaxAccountsPerUser|AllowNonAscii|DisplayUserName|ShowFirstAndLastName|MouseOverToSeeDisplayName|HidePlayersBehindYou|Announce|KnockedDownAllowed|AllowCoop|UsernameDisguises|HideDisguisedUserName|PlayerBumpPlayer|MapRemotePlayerVisibility|ShowCoordinates|RemovePlayerCorpses)/.test(k),
  ],
];
const iniGroupOf = (k: string) => INI_GROUPS.find(([, test]) => test(k))?.[0] ?? 'other';
const INI_ORDER = ['general', 'players', 'pvp', 'safehouses', 'chat', 'backups', 'anticheat', 'other'];
const SANDBOX_ORDER = ['general', 'ZombieLore', 'ZombieConfig', 'MultiplierConfig', 'Map', 'Basement'];
const sandboxGroupOf = (k: string) => (k.includes('.') ? k.split('.')[0]! : 'general');

function Missing() {
  const { t } = useTranslation();
  return <Alert color="blue">{t('config.missing')}</Alert>;
}

function ServerTab({ meta }: { meta: ConfigMeta }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['config', 'server'], queryFn: () => get<{ values: Record<string, string>; missing: boolean }>('/api/config/server') });
  if (!q.data) return <Loader />;
  if (q.data.missing) return <Missing />;
  return (
    <Stack>
      <Text size="sm" c="dimmed">
        {t('config.managedHelp')}
      </Text>
      <OptionsForm
        metas={meta.ini}
        values={q.data.values}
        groupOf={iniGroupOf}
        groupOrder={INI_ORDER}
        groupLabel={(g) => t(`config.groups.${g}`)}
        managed={new Set(meta.managed)}
        secret={new Set(meta.secret)}
        restartOnly={new Set(meta.restartOnly)}
        onSave={async (changes: Record<string, Value>) => {
          const r = await put<ApplyResult>('/api/config/server', { changes: Object.fromEntries(Object.entries(changes).map(([k, v]) => [k, String(v ?? '')])) });
          await qc.invalidateQueries({ queryKey: ['config'] });
          return r;
        }}
      />
    </Stack>
  );
}

function WorldTab({ meta }: { meta: ConfigMeta }) {
  const { t } = useTranslation();
  const errorText = useErrorText();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['config', 'sandbox'], queryFn: () => get<{ values: Record<string, Value>; missing: boolean }>('/api/config/sandbox') });
  if (!q.data) return <Loader />;
  if (q.data.missing) return <Missing />;
  const applyPreset = (name: string) =>
    modals.openConfirmModal({
      title: t('config.presets'),
      children: <Text size="sm">{t('config.presetConfirm', { name })}</Text>,
      labels: { confirm: t('common.confirm'), cancel: t('common.cancel') },
      onConfirm: () =>
        void post<{ applied_keys: number }>(`/api/config/sandbox/presets/${encodeURIComponent(name)}`).then(
          (r) => {
            notifications.show({ color: 'green', message: t('config.presetApplied', { count: r.applied_keys }) });
            void qc.invalidateQueries({ queryKey: ['config'] });
          },
          (e: unknown) => notifications.show({ color: 'red', message: errorText(e) }),
        ),
    });
  return (
    <Stack>
      <Alert variant="light" icon={<IconAlertTriangle />}>
        {t('config.worldHelp')}
      </Alert>
      <OptionsForm
        metas={meta.sandbox.filter((m) => m.key !== 'VERSION')}
        values={q.data.values}
        groupOf={sandboxGroupOf}
        groupOrder={SANDBOX_ORDER}
        groupLabel={(g) => t(`config.sandboxGroups.${g}`, { defaultValue: g })}
        toolbar={
          meta.presets.length > 0 && (
            <Menu>
              <Menu.Target>
                <Button size="xs" variant="default" rightSection={<IconChevronDown size={14} />}>
                  {t('config.presets')}
                </Button>
              </Menu.Target>
              <Menu.Dropdown>
                {meta.presets.map((p) => (
                  <Menu.Item key={p} onClick={() => applyPreset(p)}>
                    {p}
                  </Menu.Item>
                ))}
              </Menu.Dropdown>
            </Menu>
          )
        }
        onSave={async (changes) => {
          const r = await put<ApplyResult>('/api/config/sandbox', { changes });
          await qc.invalidateQueries({ queryKey: ['config'] });
          return r;
        }}
      />
    </Stack>
  );
}

export function Config() {
  const { t } = useTranslation();
  const [params, setParams] = useSearchParams();
  const tab = params.get('tab') ?? 'server';
  const meta = useQuery({ queryKey: ['config', 'meta'], queryFn: () => get<ConfigMeta>('/api/config/meta'), staleTime: Infinity });
  const pending = useQuery({ queryKey: ['config', 'pending'], queryFn: () => get<{ since: string; reasons: string[] } | null>('/api/config/pending'), refetchInterval: 30_000 });

  return (
    <Stack>
      <Title order={2}>{t('config.title')}</Title>
      {pending.data && (
        <Alert color="orange" variant="light" icon={<IconAlertTriangle />}>
          {t('config.pendingRestart', { reasons: pending.data.reasons.join(', ') })}
        </Alert>
      )}
      <Tabs value={tab} onChange={(v) => v && setParams({ tab: v })} keepMounted={false}>
        <Tabs.List>
          <Tabs.Tab value="server">{t('config.tabs.server')}</Tabs.Tab>
          <Tabs.Tab value="world">{t('config.tabs.world')}</Tabs.Tab>
          <Tabs.Tab value="files">{t('config.tabs.files')}</Tabs.Tab>
          <Tabs.Tab value="history">{t('config.tabs.history')}</Tabs.Tab>
        </Tabs.List>
        <Stack pt="md">
          {!meta.data ? (
            <Center>
              <Loader />
            </Center>
          ) : (
            <>
              <Tabs.Panel value="server">
                <ServerTab meta={meta.data} />
              </Tabs.Panel>
              <Tabs.Panel value="world">
                <WorldTab meta={meta.data} />
              </Tabs.Panel>
              <Tabs.Panel value="files">
                <ConfigFiles />
              </Tabs.Panel>
              <Tabs.Panel value="history">
                <ConfigHistory />
              </Tabs.Panel>
            </>
          )}
        </Stack>
      </Tabs>
    </Stack>
  );
}
