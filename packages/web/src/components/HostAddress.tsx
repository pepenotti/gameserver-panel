// The host's addresses (HST-08): the public address friends use to reach
// this computer, and its address on the home network, which every server's
// connection info uses (SRV-08). The owner's alone. "Detect" asks one fixed
// public service for this computer's public IP address, only when pressed,
// and saves nothing (NFR-09).
import { Alert, Button, Card, Group, Stack, Text, TextInput } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { DetectedAddress, HostAddressView } from '@gsp/shared';
import { api } from '../api/http';
import { addressProblemKey } from '../lib/connection';
import { useErrorText } from '../lib/format';

const KEY = ['host-address'];

export function HostAddressSettings() {
  const { t } = useTranslation();
  const errorText = useErrorText();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: KEY, queryFn: () => api<HostAddressView>('GET', '/api/host/address') });
  const [pub, setPub] = useState('');
  const [home, setHome] = useState('');
  const [saving, setSaving] = useState(false);
  const [detecting, setDetecting] = useState(false);
  const [found, setFound] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const reset = (v: HostAddressView) => {
    setPub(v.publicSource === 'set' ? (v.public ?? '') : '');
    setHome(v.homeSource === 'set' ? (v.home ?? '') : '');
  };
  useEffect(() => {
    if (q.data) reset(q.data);
  }, [q.data]);

  if (q.error) return <Alert color="red">{errorText(q.error)}</Alert>;
  const v = q.data;
  if (!v) return null;
  const pubProblem = addressProblemKey(pub);
  const homeProblem = addressProblemKey(home);
  const defaultLine = (address: string | null, source: 'duckdns' | 'lan') =>
    address ? t('hostSettings.address.defaultIs', { address, source: t(`hostSettings.address.sources.${source}`) }) : t('hostSettings.address.noDefault');

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      const next = await api<HostAddressView>('PUT', '/api/host/address', { public: pub.trim() || null, home: home.trim() || null });
      qc.setQueryData(KEY, next);
      reset(next);
      setFound(null);
      // Every server's connection info uses them.
      void qc.invalidateQueries({ queryKey: ['connection'] });
      notifications.show({ color: 'green', message: t('common.saved') });
    } catch (e) {
      setError(errorText(e));
    } finally {
      setSaving(false);
    }
  };

  const detect = async () => {
    setDetecting(true);
    setError(null);
    try {
      const r = await api<DetectedAddress>('POST', '/api/host/address/detect', {});
      setPub(r.address);
      setFound(r.address);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setDetecting(false);
    }
  };

  return (
    <Card withBorder>
      <Text fw={600}>{t('hostSettings.address.title')}</Text>
      <Text size="xs" c="dimmed" mb="sm">
        {t('hostSettings.address.help')}
      </Text>
      <Stack>
        <Stack gap={6}>
          <TextInput
            label={t('hostSettings.address.public')}
            description={t('hostSettings.address.publicHelp')}
            placeholder={v.defaults.public ?? 'example.duckdns.org'}
            value={pub}
            onChange={(e) => setPub(e.currentTarget.value)}
            error={pubProblem ? t(pubProblem) : undefined}
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
          />
          <Text size="xs" c="dimmed">
            {defaultLine(v.defaults.public, 'duckdns')}
          </Text>
          <Group gap="sm" wrap="nowrap" align="flex-start">
            <Button variant="default" size="xs" onClick={() => void detect()} loading={detecting} style={{ flexShrink: 0 }}>
              {t('hostSettings.address.detect')}
            </Button>
            {/* NFR-09: what pressing it sends, and to whom, next to the button. */}
            <Text size="xs" c="dimmed">
              {t('hostSettings.address.detectHelp', { service: v.detectService.replace(/^https:\/\//, '') })}
            </Text>
          </Group>
          {found && (
            <Text size="xs" c="green">
              {t('hostSettings.address.detected', { address: found })}
            </Text>
          )}
        </Stack>
        <Stack gap={6}>
          <TextInput
            label={t('hostSettings.address.home')}
            description={t('hostSettings.address.homeHelp')}
            placeholder={v.defaults.home ?? '192.168.1.50'}
            value={home}
            onChange={(e) => setHome(e.currentTarget.value)}
            error={homeProblem ? t(homeProblem) : undefined}
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
          />
          <Text size="xs" c="dimmed">
            {defaultLine(v.defaults.home, 'lan')}
          </Text>
        </Stack>
        {error && <Alert color="red">{error}</Alert>}
        <Group>
          <Button onClick={() => void save()} loading={saving} disabled={pubProblem !== null || homeProblem !== null}>
            {t('common.save')}
          </Button>
        </Group>
      </Stack>
    </Card>
  );
}
