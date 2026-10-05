// The host page (HST-03, HST-07, SRV-05, UX-04), for those who see the host
// overview (the owner and admins on every server): what every server uses
// of this computer now and in all against what it has, with a warning when
// the memory limits add up to more; the computer itself; and what it can't
// do, each limitation with its entry in docs/limitations.md. Cards rather
// than a table, so it reads on a phone (UX-02); refreshed every 10 seconds
// (the panel keeps an overview a few seconds, so this never hammers Docker).
import { Alert, Anchor, Badge, Card, Center, Group, Loader, Progress, SimpleGrid, Stack, Text, Title } from '@mantine/core';
import { IconAlertTriangle, IconInfoCircle } from '@tabler/icons-react';
import { useQuery } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';
import type { ServerState } from '@gsp/shared';
import type { HostLimitation, HostOverview, HostOverviewServer } from '../api/host';
import { api } from '../api/http';
import { localize } from '../api/meta';
import { serverHref } from '../api/server';
import { useSession } from '../api/session';
import { StateBadge } from '../components/StateBadge';
import { formatBytes, useErrorText, useRelative } from '../lib/format';
import { cpuShare, diskParts, formatPercent, memoryBar, memoryWarning, memShare } from '../lib/host';
import { jobPercent } from '../lib/installs';

const MIB = 1024 * 1024;

/** A label and its value, stacked: reads the same on a phone and a wide screen. */
function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <Stack gap={0} style={{ minWidth: 0 }}>
      <Text size="xs" c="dimmed">
        {label}
      </Text>
      <Text size="sm" style={{ overflowWrap: 'anywhere' }}>
        {children}
      </Text>
    </Stack>
  );
}

function ServerCard({ s }: { s: HostOverviewServer }) {
  const { t, i18n } = useTranslation();
  const lang = i18n.language;
  const game = [s.adapterName ? localize(s.adapterName, lang) : s.adapter, s.flavourName ? localize(s.flavourName, lang) : null].filter(Boolean).join(' · ');
  const share = memShare(s);
  const job = s.install?.job ? jobPercent(s.install.job) : null;
  const install = s.install;
  const gameFiles = [
    formatBytes(s.installBytes),
    install?.mode === 'shared' ? (install.sharedWith > 0 ? t('host.servers.shared', { n: install.sharedWith }) : null) : install ? t('host.servers.ownInstall') : null,
  ]
    .filter(Boolean)
    .join(' · ');
  return (
    <Card withBorder padding="sm">
      <Group justify="space-between" align="flex-start" wrap="nowrap" gap="xs">
        <Stack gap={0} style={{ minWidth: 0 }}>
          <Anchor component={Link} to={serverHref(s.id, '/')} fw={600} c="var(--mantine-color-text)" underline="hover" truncate>
            {s.name}
          </Anchor>
          <Text size="xs" c="dimmed" truncate>
            {game}
          </Text>
        </Stack>
        <Stack gap={4} align="flex-end" style={{ flexShrink: 0 }}>
          <StateBadge state={(s.state ?? undefined) as ServerState | undefined} agentConnected={s.state !== null} size="sm" />
          <Badge size="xs" variant="outline" color={s.container === 'running' ? 'green' : 'gray'} tt="none">
            {t(`host.servers.container.${s.container ?? 'none'}`)}
          </Badge>
        </Stack>
      </Group>
      <SimpleGrid cols={2} spacing="xs" verticalSpacing={6} mt="xs">
        <Fact label={t('host.servers.memory')}>
          {s.memBytes !== null ? t('host.servers.memUse', { used: formatBytes(s.memBytes), limit: formatBytes(s.memLimitMb * MIB) }) : t('host.servers.memLimit', { limit: formatBytes(s.memLimitMb * MIB) })}
        </Fact>
        <Fact label={t('host.servers.cpu')}>
          {[s.cpuPercent !== null ? formatPercent(s.cpuPercent, lang) : '—', s.cpus !== null ? t('host.servers.cpuLimit', { cpus: s.cpus }) : null].filter(Boolean).join(' · ')}
        </Fact>
        <Fact label={t('host.servers.files')}>{formatBytes(s.dataBytes)}</Fact>
        <Fact label={t('host.servers.game')}>{gameFiles || '—'}</Fact>
        <Fact label={t('host.servers.backups')}>{t('host.servers.backupsCount', { n: s.backups.count, size: formatBytes(s.backups.bytes) })}</Fact>
      </SimpleGrid>
      {share !== null && <Progress mt="xs" size="sm" value={share} color={share >= 90 ? 'red' : share >= 75 ? 'orange' : 'blue'} aria-label={t('host.servers.memory')} />}
      {install?.state === 'installing' && <Progress mt={6} size="sm" value={job ?? 100} animated striped={job === null} aria-label={t('host.servers.game')} />}
    </Card>
  );
}

function Limitation({ l }: { l: HostLimitation }) {
  const { t, i18n } = useTranslation();
  return (
    <Alert color={l.level === 'warning' ? 'orange' : 'blue'} variant="light" icon={l.level === 'warning' ? <IconAlertTriangle /> : <IconInfoCircle />} title={localize(l.title, i18n.language)}>
      <Stack gap={4}>
        <Text size="sm">{localize(l.text, i18n.language)}</Text>
        <Group gap={6} wrap="wrap">
          <Badge size="xs" variant="outline" color={l.status === 'measured' ? 'green' : 'gray'} tt="none">
            {t(`host.limitations.${l.status}`)}
          </Badge>
          <Text size="xs" c="dimmed" style={{ overflowWrap: 'anywhere' }}>
            {t('host.limitations.doc', { doc: l.doc })}
          </Text>
        </Group>
      </Stack>
    </Alert>
  );
}

export function Host() {
  const { t, i18n } = useTranslation();
  const lang = i18n.language;
  const errorText = useErrorText();
  const rel = useRelative();
  const { canHost } = useSession();
  const q = useQuery({ queryKey: ['host-overview'], queryFn: () => api<HostOverview>('GET', '/api/host/overview'), refetchInterval: 10_000 });
  if (q.error) return <Alert color="red">{errorText(q.error)}</Alert>;
  const o = q.data;
  if (!o) {
    return (
      <Center mt="xl">
        <Loader />
      </Center>
    );
  }
  const { memory, cpu, disk, backupsDisk } = o.totals;
  const warning = memoryWarning(o);
  const bar = memoryBar(memory);
  const share = cpuShare(cpu);
  const h = o.host;

  return (
    <Stack maw={1100}>
      <Title order={2}>{t('host.title')}</Title>
      <Text size="sm" c="dimmed">
        {t('host.intro')}
      </Text>
      {o.measured.usage ? (
        <Text size="xs" c="dimmed">
          {t('host.refreshed', { when: rel(o.measured.usage) })}
        </Text>
      ) : (
        <Alert color="gray" variant="light">
          {t('host.notMeasured')}
        </Alert>
      )}
      {o.measured.usage && !o.measured.disk && (
        <Alert color="gray" variant="light">
          {t('host.diskNotMeasured')}
        </Alert>
      )}
      {warning && (
        <Alert color={warning.key === 'host.memory.overRunning' ? 'red' : 'orange'} variant="light" icon={<IconAlertTriangle />}>
          {t(warning.key, { limits: formatBytes(warning.limitsBytes), host: formatBytes(warning.hostBytes) })}
        </Alert>
      )}

      <SimpleGrid cols={{ base: 1, sm: 3 }}>
        <Card withBorder>
          <Title order={4}>{t('host.memory.title')}</Title>
          {bar.used !== null && <Progress mt="xs" value={bar.used} color={warning ? 'orange' : 'blue'} aria-label={t('host.memory.title')} />}
          <Stack gap={4} mt="xs">
            {memory.usedBytes !== null && memory.hostBytes !== null && <Text size="sm">{t('host.memory.used', { used: formatBytes(memory.usedBytes), host: formatBytes(memory.hostBytes) })}</Text>}
            <Text size="sm">{t('host.memory.limits', { limits: formatBytes(memory.limitsMb * MIB), running: formatBytes(memory.runningLimitsMb * MIB) })}</Text>
            <Text size="xs" c="dimmed">
              {t('host.memory.besides')}
            </Text>
          </Stack>
        </Card>
        <Card withBorder>
          <Title order={4}>{t('host.cpu.title')}</Title>
          {share !== null && <Progress mt="xs" value={Math.min(100, share)} aria-label={t('host.cpu.title')} />}
          <Stack gap={4} mt="xs">
            {cpu.percent !== null && (
              <Text size="sm">
                {cpu.hostCpus !== null && share !== null
                  ? t('host.cpu.used', { percent: formatPercent(cpu.percent, lang), share: formatPercent(share, lang), cores: cpu.hostCpus })
                  : t('host.cpu.usedNoHost', { percent: formatPercent(cpu.percent, lang) })}
              </Text>
            )}
            <Text size="sm">{cpu.limitsCpus > 0 ? t('host.cpu.limits', { cpus: cpu.limitsCpus, unlimited: cpu.unlimited }) : t('host.cpu.noLimits')}</Text>
            <Text size="xs" c="dimmed">
              {t('host.cpu.note')}
            </Text>
          </Stack>
        </Card>
        <Card withBorder>
          <Title order={4}>{t('host.disk.title')}</Title>
          <Stack gap={2} mt="xs">
            {diskParts(disk).map((p) => (
              <Group key={p.key} justify="space-between" wrap="nowrap" gap="xs">
                <Text size="sm">{t(p.key)}</Text>
                <Text size="sm" ff="monospace" style={{ flexShrink: 0 }}>
                  {formatBytes(p.bytes)}
                </Text>
              </Group>
            ))}
            <Group justify="space-between" wrap="nowrap" gap="xs">
              <Text size="sm" fw={600}>
                {t('host.disk.total')}
              </Text>
              <Text size="sm" ff="monospace" fw={600} style={{ flexShrink: 0 }}>
                {formatBytes(disk.totalBytes)}
              </Text>
            </Group>
            {backupsDisk && (
              <Text size="xs" c="dimmed" mt={4}>
                {t('host.disk.backupsFree', { free: formatBytes(backupsDisk.freeBytes), size: formatBytes(backupsDisk.sizeBytes) })}
              </Text>
            )}
            {canHost('notifications.manage') && (
              <Anchor component={Link} to="/settings" size="xs" mt={4}>
                {t('host.disk.manage')}
              </Anchor>
            )}
          </Stack>
        </Card>
      </SimpleGrid>

      <Title order={3} mt="sm">
        {t('host.servers.title')}
      </Title>
      {o.servers.length === 0 ? (
        <Text size="sm" c="dimmed">
          {t('host.servers.none')}
        </Text>
      ) : (
        <SimpleGrid cols={{ base: 1, md: 2 }}>
          {o.servers.map((s) => (
            <ServerCard key={s.id} s={s} />
          ))}
        </SimpleGrid>
      )}

      <Title order={3} mt="sm">
        {t('host.limitations.title')}
      </Title>
      <Text size="sm" c="dimmed">
        {t('host.limitations.help')}
      </Text>
      {o.limitations.length === 0 ? (
        <Text size="sm" c="dimmed">
          {t('host.limitations.none')}
        </Text>
      ) : (
        <Stack gap="xs">
          {o.limitations.map((l) => (
            <Limitation key={l.id} l={l} />
          ))}
        </Stack>
      )}

      <Card withBorder>
        <Title order={4}>{t('host.facts.title')}</Title>
        {h ? (
          <SimpleGrid cols={{ base: 1, xs: 2, md: 4 }} mt="xs" spacing="sm">
            <Fact label={t('host.facts.arch')}>
              {t(`host.facts.archValue.${h.arch === 'arm64' ? 'arm64' : 'amd64'}`)} · {t('host.facts.cpus', { n: h.cpus })}
            </Fact>
            <Fact label={t('host.facts.memory')}>{formatBytes(h.memBytes)}</Fact>
            <Fact label={t('host.facts.docker')}>
              {[h.docker ? t(`host.facts.dockerValue.${h.docker}`) : h.os, h.platform ? t(`host.facts.platform.${h.platform}`) : null, h.dockerVersion].filter(Boolean).join(' ')}
            </Fact>
            {h.maxMemMb !== null && <Fact label={t('host.facts.maxMem')}>{formatBytes(h.maxMemMb * MIB)}</Fact>}
          </SimpleGrid>
        ) : (
          <Text size="sm" c="dimmed" mt="xs">
            {t('host.facts.unknown')}
          </Text>
        )}
      </Card>
    </Stack>
  );
}
