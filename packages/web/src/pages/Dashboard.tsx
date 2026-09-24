import { Alert, Badge, Card, Group, Progress, SimpleGrid, Stack, Text, Title } from '@mantine/core';
import { IconAlertTriangle, IconLock, IconPlugConnectedX } from '@tabler/icons-react';
import { useQuery } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import type { AgentStatus } from '@pz/shared';
import { get } from '../api/http';
import { useLive } from '../api/live';
import { OpBanner } from '../components/OpBanner';
import { ServerControls } from '../components/ServerControls';
import { StateBadge } from '../components/StateBadge';
import { formatBytes, useDuration, useRelative } from '../lib/format';

interface StatusResponse {
  panelVersion: string;
  serverName: string;
  agentConnected: boolean;
  agent: AgentStatus | null;
  launch: { memoryMb: number; branch: string; updateOnStart: boolean };
  nextRestart: string | null;
  lastBackup: { at: string; trigger: string; mode: 'hot' | 'cold' } | null;
}

function Stat({ label, children }: { label: string; children: ReactNode }) {
  return (
    <Card withBorder padding="md">
      <Text size="xs" c="dimmed" tt="uppercase" fw={600}>
        {label}
      </Text>
      <Text size="lg" fw={600} mt={4} component="div">
        {children}
      </Text>
    </Card>
  );
}

export function Dashboard() {
  const { t } = useTranslation();
  const live = useLive();
  const dur = useDuration();
  const rel = useRelative();
  const q = useQuery({ queryKey: ['status'], queryFn: () => get<StatusResponse>('/api/status'), refetchInterval: 30_000 });
  const s = live.status ?? q.data?.agent ?? null;
  const connected = live.socket === 'open' ? live.agentConnected : (q.data?.agentConnected ?? false);
  const players = live.players ?? s?.players ?? null;
  const dataDisk = s?.disks[0];
  const drift = s ? Math.round((new Date(s.now).getTime() - Date.now()) / 1000) : 0;

  return (
    <Stack>
      <Group justify="space-between" align="center">
        <Stack gap={0}>
          <Title order={2}>{t('dashboard.title')}</Title>
          <Text c="dimmed" size="sm">
            {t('dashboard.server')}: <b>{q.data?.serverName ?? '…'}</b>
          </Text>
        </Stack>
        <StateBadge state={s?.state} agentConnected={connected} size="lg" />
      </Group>

      <OpBanner />
      <ServerControls />

      {!connected && (
        <Alert color="red" variant="light" icon={<IconPlugConnectedX />}>
          {t('dashboard.agentOffline')}
        </Alert>
      )}
      {s?.lock && (
        <Alert color="blue" variant="light" icon={<IconLock />}>
          {t('dashboard.lock', { holder: s.lock.holder })}
        </Alert>
      )}
      {s?.failure && (
        <Alert color="red" variant="light" icon={<IconAlertTriangle />} title={t('dashboard.failure')}>
          {s.failure}
        </Alert>
      )}
      {Math.abs(drift) > 60 && (
        <Alert color="yellow" variant="light">
          {t('dashboard.clockDrift', { seconds: drift })}
        </Alert>
      )}
      {live.job && !live.job.result && (!live.op || live.op.done) && (
        <Card withBorder>
          <Text size="sm" mb={6}>
            {live.job.message}
          </Text>
          <Progress value={live.job.progress ?? 100} animated striped={live.job.progress === null} />
        </Card>
      )}

      <SimpleGrid cols={{ base: 2, md: 4 }}>
        <Stat label={t('dashboard.players')}>{players ? players.count : '—'}</Stat>
        {s?.state !== 'running' && s?.lastExit ? (
          <Stat label={t('dashboard.lastExit')}>
            <Text size="sm" component="span">
              {rel(s.lastExit.at)} · {s.lastExit.expected ? 'OK' : `code ${s.lastExit.code ?? s.lastExit.signal}`}
            </Text>
          </Stat>
        ) : (
          <Stat label={t('dashboard.uptime')}>{s?.readyAt && s.state === 'running' ? dur(Date.now() - new Date(s.readyAt).getTime()) : '—'}</Stat>
        )}
        <Stat label={t('dashboard.nextRestart')}>{q.data?.nextRestart ? t('time.in', { what: dur(new Date(q.data.nextRestart).getTime() - Date.now()) }) : t('schedules.off')}</Stat>
        <Stat label={t('dashboard.lastBackup')}>{q.data?.lastBackup ? rel(q.data.lastBackup.at) : t('common.never')}</Stat>
        <Stat label={t('dashboard.memory')}>
          {s?.process ? `${formatBytes(s.process.rssBytes)}${s.process.cgroupLimitBytes ? ` / ${formatBytes(s.process.cgroupLimitBytes)}` : ''}` : '—'}
        </Stat>
        <Stat label={t('dashboard.cpu')}>{s?.process ? `${s.process.cpuPercent}%` : '—'}</Stat>
        <Stat label={t('dashboard.disk')}>{dataDisk ? formatBytes(dataDisk.freeBytes) : '—'}</Stat>
        <Stat label={t('dashboard.gameVersion')}>
          {s?.gameVersion ?? '—'}
          {s?.installed && (
            <Text size="xs" c="dimmed">
              {t('dashboard.buildOf', { build: s.installed.buildId, branch: s.installed.branch })}
            </Text>
          )}
        </Stat>
      </SimpleGrid>

      <Card withBorder>
        <Text fw={600} mb="xs">
          {t('dashboard.players')}
        </Text>
        {players && players.count > 0 ? (
          <Group gap="xs">
            {players.names.map((n) => (
              <Badge key={n} variant="light" size="lg">
                {n}
              </Badge>
            ))}
          </Group>
        ) : (
          <Text c="dimmed" size="sm">
            {t('dashboard.noPlayers')}
          </Text>
        )}
      </Card>

      <Text size="xs" c="dimmed" ta="right">
        panel {q.data?.panelVersion ?? '…'} · agent {s?.agentVersion ?? '…'}
      </Text>
    </Stack>
  );
}
