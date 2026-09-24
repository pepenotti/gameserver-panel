import { Alert, Badge, Button, Card, Group, Radio, SegmentedControl, Select, Stack, Switch, Text, TextInput, Title } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { IconAlertTriangle } from '@tabler/icons-react';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { get, post } from '../api/http';
import { useLive } from '../api/live';
import { useSession } from '../api/session';
import { OpBanner } from '../components/OpBanner';
import { useErrorText } from '../lib/format';

type Scope = 'world' | 'full' | 'factory';

export function Reset() {
  const { t } = useTranslation();
  const errorText = useErrorText();
  const { can } = useSession();
  const live = useLive();
  const status = useQuery({ queryKey: ['status'], queryFn: () => get<{ serverName: string }>('/api/status') });
  const meta = useQuery({ queryKey: ['config', 'meta'], queryFn: () => get<{ presets: string[] }>('/api/config/meta'), enabled: can('config.edit'), staleTime: Infinity });
  const [scope, setScope] = useState<Scope>('world');
  const [newSeed, setNewSeed] = useState(false);
  const [preset, setPreset] = useState<string | null>(null);
  const [countdown, setCountdown] = useState('300');
  const [confirm, setConfirm] = useState('');
  const serverName = status.data?.serverName ?? '';
  const busy = !!live.op && !live.op.done;
  const playersOnline = (live.players?.count ?? 0) > 0 && live.status?.state === 'running';
  const allowed: Record<Scope, boolean> = { world: can('reset.world'), full: can('reset.full'), factory: can('reset.factory') };

  const go = () =>
    void post('/api/reset', { scope, confirm, countdownSec: playersOnline ? Number(countdown) : 0, newSeed: scope !== 'factory' && newSeed, ...(preset && scope === 'world' ? { preset } : {}) }).then(
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
        <Radio.Group label={t('reset.scope')} value={scope} onChange={(v) => setScope(v as Scope)}>
          <Stack mt="xs" gap="sm">
            {(['world', 'full', 'factory'] as Scope[]).map((s) => (
              <Radio
                key={s}
                value={s}
                disabled={!allowed[s]}
                label={
                  <Group gap={6}>
                    {t(`reset.scopes.${s}`)}
                    {s !== 'world' && (
                      <Badge size="xs" variant="outline" color="gray">
                        {t('reset.ownerOnly')}
                      </Badge>
                    )}
                  </Group>
                }
                description={t(`reset.scopes.${s}Help`)}
              />
            ))}
          </Stack>
        </Radio.Group>

        {scope !== 'factory' && (
          <Switch mt="md" label={t('reset.newSeed')} description={t('reset.newSeedHelp')} checked={newSeed} onChange={(e) => setNewSeed(e.currentTarget.checked)} />
        )}
        {scope === 'world' && (meta.data?.presets.length ?? 0) > 0 && (
          <Select
            mt="md"
            w={320}
            label={t('reset.preset')}
            value={preset}
            onChange={setPreset}
            clearable
            placeholder={t('reset.presetNone')}
            data={meta.data!.presets}
          />
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
            <Button color="red" disabled={busy || !allowed[scope] || confirm.trim() !== serverName || !serverName} onClick={go}>
              {t('reset.go')}
            </Button>
          </Group>
        </Stack>
      </Card>
    </Stack>
  );
}
