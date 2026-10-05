import { Alert, Badge, Button, Center, Group, Loader, Menu, Stack, Tabs, Text, Title } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { IconAlertTriangle, IconChevronDown, IconGitPullRequest, IconInfoCircle } from '@tabler/icons-react';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useSearchParams } from 'react-router';
import { localize } from '../../api/meta';
import { useServerApi } from '../../api/server';
import { PerAddressNote } from '../../components/AddressNote';
import { formatDateTime, useErrorText } from '../../lib/format';
import { getProposal, propose, useConfigMeta, useFileLabel, type ConfigMeta, type FileDecl, type Proposal, type ProposalPreview, type Value } from './api';
import { ConfigFiles } from './ConfigFiles';
import { ConfigHistory } from './ConfigHistory';
import { OptionsForm } from './OptionsForm';
import { ProposalModal } from './ProposalModal';

function Missing() {
  const { t } = useTranslation();
  return <Alert color="blue">{t('config.missing')}</Alert>;
}

function FormTab({ file, meta }: { file: FileDecl; meta: ConfigMeta }) {
  const { t, i18n } = useTranslation();
  const sapi = useServerApi();
  const errorText = useErrorText();
  const [presetPreview, setPresetPreview] = useState<ProposalPreview | null>(null);
  const q = useQuery({ queryKey: ['config', 'values', file.id, sapi.sid], queryFn: () => sapi<{ values: Record<string, Value>; missing: boolean }>('GET', `/config/values?id=${encodeURIComponent(file.id)}`) });
  if (q.error) return <Alert color="red">{errorText(q.error)}</Alert>;
  if (!q.data) return <Loader />;
  if (q.data.missing) return <Missing />;
  const presets = meta.presetFile === file.id ? meta.presets : [];
  const previewPreset = (name: string) =>
    void propose(sapi, { fileId: file.id, preset: name }).then(setPresetPreview, (e: unknown) => notifications.show({ color: 'red', message: errorText(e) }));
  return (
    <Stack>
      {file.note && (
        <Alert variant="light" color="blue" icon={<IconInfoCircle />}>
          {localize(file.note, i18n.language)}
        </Alert>
      )}
      <PerAddressNote fileId={file.id} />
      {(file.managedKeys.length > 0 || file.restartKeys === '*') && (
        <Alert variant="light" color="blue" icon={<IconInfoCircle />}>
          {[file.restartKeys === '*' ? t('config.restartAllNote') : '', file.managedKeys.length > 0 ? t('config.managedNote') : ''].filter(Boolean).join(' ')}
        </Alert>
      )}
      <OptionsForm
        metas={meta.schemas[file.schemaId!] ?? []}
        values={q.data.values}
        groups={meta.groups[file.schemaId!] ?? []}
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
        onPropose={(changes) => propose(sapi, { fileId: file.id, changes })}
      />
      <ProposalModal preview={presetPreview} title={t('config.presetPreview')} onClose={() => setPresetPreview(null)} onApplied={() => setPresetPreview(null)} />
    </Stack>
  );
}

/** Changes waiting for someone to approve them (AST-03): submitted through the API, or left open. */
function PendingProposals() {
  const { t, i18n } = useTranslation();
  const sapi = useServerApi();
  const errorText = useErrorText();
  const fileLabel = useFileLabel();
  const [review, setReview] = useState<ProposalPreview | null>(null);
  const q = useQuery({ queryKey: ['config', 'proposals', 'pending', sapi.sid], queryFn: () => sapi<Proposal[]>('GET', '/config/proposals?status=pending'), refetchInterval: 30_000 });
  const open = (id: string) =>
    void getProposal(sapi, id).then(
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
  const sapi = useServerApi();
  const fileLabel = useFileLabel();
  const [params, setParams] = useSearchParams();
  const meta = useConfigMeta();
  const pending = useQuery({ queryKey: ['config', 'pending', sapi.sid], queryFn: () => sapi<{ since: string; reasons: string[] } | null>('GET', '/config/pending'), refetchInterval: 30_000 });
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
              {fileLabel(f.id)}
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
