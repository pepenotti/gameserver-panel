import { Alert, Badge, Button, Card, Group, Radio, SegmentedControl, Select, Stack, Switch, Text, TextInput, Title } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { IconAlertTriangle } from '@tabler/icons-react';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { PERMISSIONS } from '@gsp/shared';
import { get, post } from '../api/http';
import { useLive } from '../api/live';
import type { Meta } from '../api/meta';
import { useSession } from '../api/session';
import { useMeta } from '../api/useMeta';
import { OpBanner } from '../components/OpBanner';
import { useErrorText } from '../lib/format';

type ResetDecl = Meta['resets'][number];

/**
 * A reset that deletes every backup part starts the server from scratch (a
 * factory reset): there are no world settings left for a new seed or a preset
 * to go into. Until the contract says which options each reset takes, the
 * others offer both.
 */
const keepsSettings = (r: ResetDecl, m: Meta) => m.backupParts.some((p) => !r.removeParts.includes(p.id));

export function Reset() {
  const { t } = useTranslation();
  const errorText = useErrorText();
  const { can } = useSession();
  const live = useLive();
  const { meta, has, l } = useMeta();
  const presets = useQuery({ queryKey: ['config', 'meta'], queryFn: () => get<{ presets: string[] }>('/api/config/meta'), enabled: can('config.edit') && has('presets'), staleTime: Infinity });
  const resets = meta?.resets ?? [];
  const [picked, setPicked] = useState<string | null>(null);
  const [newSeed, setNewSeed] = useState(false);
  const [preset, setPreset] = useState<string | null>(null);
  const [countdown, setCountdown] = useState('300');
  const [confirm, setConfirm] = useState('');
  if (!meta) return null;

  const scope = resets.find((r) => r.id === picked) ?? resets.find((r) => can(r.permission)) ?? resets[0];
  const serverName = meta.server.gameName;
  const busy = !!live.op && !live.op.done;
  const playersOnline = (live.players?.count ?? 0) > 0 && live.status?.state === 'running';
  const options = scope !== undefined && keepsSettings(scope, meta);
  const presetList = options && has('presets') ? (presets.data?.presets ?? []) : [];
  const partLabel = (id: string) => l(meta.backupParts.find((p) => p.id === id)?.label) || id;
  const summary = (r: ResetDecl) => {
    const kept = meta.backupParts.filter((p) => !r.removeParts.includes(p.id)).map((p) => l(p.label));
    const deleted = t('reset.deletes', { parts: r.removeParts.map(partLabel).join('; ') });
    return kept.length ? `${deleted} ${t('reset.keeps', { parts: kept.join('; ') })}` : `${deleted} ${t('reset.keepsNothing')}`;
  };

  const go = () =>
    scope &&
    void post('/api/reset', {
      scope: scope.id,
      confirm,
      countdownSec: playersOnline ? Number(countdown) : 0,
      newSeed: options && newSeed,
      ...(preset && presetList.includes(preset) ? { preset } : {}),
    }).then(
      () => setConfirm(''),
      (e: unknown) => notifications.show({ color: 'red', message: errorText(e) }),
    );

  return (
    <Stack maw={720}>
      <Title order={2}>{t('reset.title')}</Title>
      <Text size="sm" c="dimmed">
        {t('reset.intro')}
      </Text>
      <OpBanner />

      <Card withBorder>
        <Radio.Group label={t('reset.scope')} value={scope?.id ?? null} onChange={setPicked}>
          <Stack mt="xs" gap="sm">
            {resets.map((r) => (
              <Radio
                key={r.id}
                value={r.id}
                disabled={!can(r.permission)}
                label={
                  <Group gap={6}>
                    {l(r.label)}
                    {PERMISSIONS[r.permission] === 'owner' && (
                      <Badge size="xs" variant="outline" color="gray">
                        {t('reset.ownerOnly')}
                      </Badge>
                    )}
                  </Group>
                }
                description={summary(r)}
              />
            ))}
          </Stack>
        </Radio.Group>

        {options && <Switch mt="md" label={t('reset.newSeed')} description={t('reset.newSeedHelp')} checked={newSeed} onChange={(e) => setNewSeed(e.currentTarget.checked)} />}
        {presetList.length > 0 && (
          <Select mt="md" w={{ base: '100%', xs: 320 }} label={t('reset.preset')} value={preset} onChange={setPreset} clearable placeholder={t('reset.presetNone')} data={presetList} />
        )}
        {playersOnline && (
          <Group gap="xs" mt="md">
            <Text size="sm" c="dimmed">
              {t('reset.when')}:
            </Text>
            <SegmentedControl
              size="xs"
              value={countdown}
              onChange={setCountdown}
              data={[
                { value: '0', label: t('controls.now') },
                { value: '60', label: t('controls.in1') },
                { value: '300', label: t('controls.in5') },
                { value: '900', label: t('controls.in15') },
              ]}
            />
          </Group>
        )}
      </Card>

      <Card withBorder style={{ borderColor: 'var(--mantine-color-red-8)' }}>
        <Stack>
          <Alert color="red" variant="light" icon={<IconAlertTriangle />}>
            {t('reset.warning')}
          </Alert>
          <TextInput label={t('reset.confirmLabel', { name: serverName })} value={confirm} onChange={(e) => setConfirm(e.currentTarget.value)} autoComplete="off" spellCheck={false} />
          <Group>
            <Button color="red" disabled={busy || !scope || !can(scope.permission) || confirm.trim() !== serverName || !serverName} onClick={go}>
              {t('reset.go')}
            </Button>
          </Group>
        </Stack>
      </Card>
    </Stack>
  );
}
