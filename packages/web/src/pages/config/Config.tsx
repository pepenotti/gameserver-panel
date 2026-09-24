import { Alert, Badge, Button, Center, Group, Loader, Menu, Stack, Tabs, Text, Title } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { IconAlertTriangle, IconChevronDown, IconGitPullRequest } from '@tabler/icons-react';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useSearchParams } from 'react-router';
import { get } from '../../api/http';
import { formatDateTime, useErrorText } from '../../lib/format';
import { getProposal, propose, useFileLabel, type ConfigMeta, type FileDecl, type Proposal, type ProposalPreview, type Value } from './api';
import { ConfigFiles } from './ConfigFiles';
import { ConfigHistory } from './ConfigHistory';
import { OptionsForm } from './OptionsForm';
import { ProposalModal } from './ProposalModal';

/** How a form groups its options, which groups are rare ("Advanced", CFG-10), and a help line. */
interface FormLayout {
  groupOf: (key: string) => string;
  order: string[];
  advanced: string[];
  groupLabel: (g: string) => string;
  help?: string;
}

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

/**
 * Forms by schema id; a schema without one here groups by dotted prefix.
 * FALLBACK until the adapter contract carries option groups and "advanced"
 * flags (`OptionMeta`): these layouts match one adapter's schema ids (`ini`,
 * `sandbox`) and stay dormant for every other game.
 */
function useLayouts(): (schemaId: string) => FormLayout {
  const { t } = useTranslation();
  const dotted = (k: string) => (k.includes('.') ? k.split('.')[0]! : 'general');
  const layouts: Record<string, FormLayout> = {
    ini: {
      groupOf: (k) => INI_GROUPS.find(([, test]) => test(k))?.[0] ?? 'other',
      order: ['general', 'players', 'pvp', 'safehouses', 'chat', 'backups', 'anticheat', 'other'],
      advanced: ['backups', 'anticheat', 'other'],
      groupLabel: (g) => t(`config.groups.${g}`),
      help: t('config.managedHelp'),
    },
    sandbox: {
      groupOf: dotted,
      order: ['general', 'ZombieLore', 'Map', 'ZombieConfig', 'MultiplierConfig', 'Basement'],
      advanced: ['ZombieConfig', 'MultiplierConfig', 'Basement'],
      groupLabel: (g) => t(`config.sandboxGroups.${g}`, { defaultValue: g }),
      help: t('config.worldHelp'),
    },
  };
  return (schemaId) => layouts[schemaId] ?? { groupOf: dotted, order: ['general'], advanced: [], groupLabel: (g) => (g === 'general' ? t('config.groups.general') : g) };
}

function Missing() {
  const { t } = useTranslation();
  return <Alert color="blue">{t('config.missing')}</Alert>;
}

function FormTab({ file, meta }: { file: FileDecl; meta: ConfigMeta }) {
  const { t } = useTranslation();
  const errorText = useErrorText();
  const layout = useLayouts()(file.schemaId!);
  const [presetPreview, setPresetPreview] = useState<ProposalPreview | null>(null);
  const q = useQuery({ queryKey: ['config', 'values', file.id], queryFn: () => get<{ values: Record<string, Value>; missing: boolean }>(`/api/config/values?id=${encodeURIComponent(file.id)}`) });
  if (q.error) return <Alert color="red">{errorText(q.error)}</Alert>;
  if (!q.data) return <Loader />;
  if (q.data.missing) return <Missing />;
  const presets = meta.presetFile === file.id ? meta.presets : [];
  const previewPreset = (name: string) =>
    void propose({ fileId: file.id, preset: name }).then(setPresetPreview, (e: unknown) => notifications.show({ color: 'red', message: errorText(e) }));
  return (
    <Stack>
      {layout.help && (
        <Alert variant="light" icon={<IconAlertTriangle />}>
          {layout.help}
        </Alert>
      )}
      <OptionsForm
        metas={(meta.schemas[file.schemaId!] ?? []).filter((m) => m.key !== 'VERSION')}
        values={q.data.values}
        groupOf={layout.groupOf}
        groupOrder={layout.order}
        advancedGroups={layout.advanced}
        groupLabel={layout.groupLabel}
        managed={new Set(file.managedKeys)}
        secret={new Set(file.secretKeys)}
        restartOnly={new Set(file.restartKeys === '*' ? [] : file.restartKeys)}
        toolbar={
          presets.length > 0 && (
            <Menu>
              <Menu.Target>
                <Button size="xs" variant="default" rightSection={<IconChevronDown size={14} />}>
                  {t('config.presets')}
                </Button>
              </Menu.Target>
              <Menu.Dropdown>
                {presets.map((p) => (
                  <Menu.Item key={p} onClick={() => previewPreset(p)}>
                    {p}
                  </Menu.Item>
                ))}
              </Menu.Dropdown>
            </Menu>
          )
        }
        onPropose={(changes) => propose({ fileId: file.id, changes })}
      />
      <ProposalModal preview={presetPreview} title={t('config.presetPreview')} onClose={() => setPresetPreview(null)} onApplied={() => setPresetPreview(null)} />
    </Stack>
  );
}

/** Changes waiting for someone to approve them (AST-03): submitted through the API, or left open. */
function PendingProposals() {
  const { t, i18n } = useTranslation();
  const errorText = useErrorText();
  const fileLabel = useFileLabel();
  const [review, setReview] = useState<ProposalPreview | null>(null);
  const q = useQuery({ queryKey: ['config', 'proposals', 'pending'], queryFn: () => get<Proposal[]>('/api/config/proposals?status=pending'), refetchInterval: 30_000 });
  const open = (id: string) =>
    void getProposal(id).then(
      (p) => setReview({ ...p, id: p.id, fileId: p.fileId }),
      (e: unknown) => notifications.show({ color: 'red', message: errorText(e) }),
    );
  if (!q.data?.length && !review) return null;
  return (
    <>
      {q.data && q.data.length > 0 && (
        <Alert color="violet" variant="light" icon={<IconGitPullRequest />} title={t('config.proposals.title', { count: q.data.length })}>
          <Stack gap={4}>
            {q.data.map((p) => (
              <Group key={p.id} justify="space-between" wrap="nowrap">
                <Text size="sm" style={{ minWidth: 0 }} truncate>
                  <b>{fileLabel(p.fileId)}</b> — {p.note ?? ''} · {t('config.proposals.by', { user: p.createdBy ?? t('audit.system'), when: formatDateTime(p.createdAt, i18n.language) })}
                  {p.actorType !== 'user' && (
                    <Badge ml={6} size="xs" variant="outline">
                      {t(`config.proposals.actor.${p.actorType}`, { defaultValue: p.actorType })}
                    </Badge>
                  )}
                </Text>
                <Button size="compact-xs" variant="light" onClick={() => open(p.id)}>
                  {t('config.proposals.review')}
                </Button>
              </Group>
            ))}
          </Stack>
        </Alert>
      )}
      <ProposalModal preview={review} mode="review" onClose={() => setReview(null)} onApplied={() => setReview(null)} />
    </>
  );
}

export function Config() {
  const { t } = useTranslation();
  const [params, setParams] = useSearchParams();
  const meta = useQuery({ queryKey: ['config', 'meta'], queryFn: () => get<ConfigMeta>('/api/config/meta'), staleTime: Infinity });
  const pending = useQuery({ queryKey: ['config', 'pending'], queryFn: () => get<{ since: string; reasons: string[] } | null>('/api/config/pending'), refetchInterval: 30_000 });
  const forms = meta.data?.files.filter((f) => f.schemaId && meta.data.schemas[f.schemaId]) ?? [];
  const requested = params.get('tab');
  const tab = requested && (['files', 'history'].includes(requested) || forms.some((f) => f.id === requested)) ? requested : (forms[0]?.id ?? 'files');

  return (
    <Stack>
      <Title order={2}>{t('config.title')}</Title>
      {pending.data && (
        <Alert color="orange" variant="light" icon={<IconAlertTriangle />}>
          {t('config.pendingRestart', { reasons: pending.data.reasons.join(', ') })}
        </Alert>
      )}
      <PendingProposals />
      <Tabs value={tab} onChange={(v) => v && setParams({ tab: v })} keepMounted={false}>
        <Tabs.List>
          {forms.map((f) => (
            <Tabs.Tab key={f.id} value={f.id}>
              {t(`config.tabs.${f.id}`, { defaultValue: f.id })}
            </Tabs.Tab>
          ))}
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
              {forms.map((f) => (
                <Tabs.Panel key={f.id} value={f.id}>
                  <FormTab file={f} meta={meta.data} />
                </Tabs.Panel>
              ))}
              <Tabs.Panel value="files">
                <ConfigFiles />
              </Tabs.Panel>
              <Tabs.Panel value="history">
                <ConfigHistory files={meta.data.files} />
              </Tabs.Panel>
            </>
          )}
        </Stack>
      </Tabs>
    </Stack>
  );
}
