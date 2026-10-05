// A server's game files (HST-09, D12): the shared install it runs from (its
// version, size, and how many other servers share it), the job's progress
// while one is being made, why it failed, and the move that waits for its
// next start; an admin of the server can move a stopped server now (or try
// a failed install again). Game-neutral: the version is the install's own.
import { Alert, Button, Card, Group, Progress, Stack, Text } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import type { InstallProgress, ServerInstallView } from '../api/installs';
import { useLive } from '../api/live';
import { SERVERS_KEY, useServerApi, type ServerSummary } from '../api/server';
import { useSession } from '../api/session';
import { formatBytes, useErrorText } from '../lib/format';
import { canMoveNow, jobPercent, nextMoveLine, serverInstallLine } from '../lib/installs';
import { PendingBadge } from './PendingBadge';

/** Something about the install moves now: a job runs, or it waits for one. */
const active = (v: ServerInstallView | null | undefined) => !!v && (v.waiting || v.state === 'installing' || v.job !== null || v.next?.state === 'installing' || (v.next?.job ?? null) !== null);

function JobBar({ job }: { job: InstallProgress | null }) {
  const pct = jobPercent(job);
  return (
    <Stack gap={4}>
      {job?.message ? (
        <Text size="xs" c="dimmed" style={{ overflowWrap: 'anywhere' }}>
          {job.message}
        </Text>
      ) : null}
      <Progress value={pct ?? 100} animated striped={pct === null} />
    </Stack>
  );
}

export function InstallCard({ server }: { server: ServerSummary }) {
  const { t } = useTranslation();
  const errorText = useErrorText();
  const qc = useQueryClient();
  const sapi = useServerApi();
  const live = useLive();
  const { can } = useSession();
  const q = useQuery({
    queryKey: ['install', sapi.sid],
    queryFn: () => sapi<ServerInstallView | null>('GET', '/install'),
    // Followed closely only while something about it moves (a job's progress).
    refetchInterval: (query) => (active(query.state.data ?? server.install) ? 2000 : false),
  });
  const v = q.data ?? server.install;
  // Once it settles, the server's summary (its pending reasons, its container) is asked again.
  const was = useRef(active(v));
  useEffect(() => {
    const now = active(v);
    if (was.current && !now) void qc.invalidateQueries({ queryKey: SERVERS_KEY });
    was.current = now;
  }, [v, qc]);
  if (!v) return null;
  const line = serverInstallLine(v);
  const waitingMove = nextMoveLine(v);
  const state = live.status?.state ?? null;
  const runs = state === 'running' || state === 'starting' || state === 'stopping' || state === 'installing';
  const busy = !!live.op && !live.op.done;
  const move = () =>
    void sapi('POST', '/install')
      .then(() => qc.invalidateQueries({ queryKey: ['install', sapi.sid] }))
      .catch((e: unknown) => notifications.show({ color: 'red', message: errorText(e) }));

  return (
    <Card withBorder>
      <Group justify="space-between" mb={4} wrap="nowrap">
        <Text fw={600}>{t('server.install.title')}</Text>
        {v.next && <PendingBadge reasons={['install']} size="sm" />}
      </Group>
      <Text size="sm" c="dimmed" mb="xs">
        {t('server.install.help')}
      </Text>
      <Stack gap="xs">
        {line.kind === 'shared' && (
          <Stack gap={2}>
            <Text size="sm" style={{ overflowWrap: 'anywhere' }}>
              {[line.label ? t('server.install.version', { label: line.label }) : null, line.bytes !== null ? t('server.install.size', { size: formatBytes(line.bytes) }) : null].filter(Boolean).join(' · ')}
            </Text>
            <Text size="xs" c="dimmed">
              {line.sharedWith > 0 ? t('server.install.sharedWith', { count: line.sharedWith }) : t('server.install.sharedAlone')}
            </Text>
          </Stack>
        )}
        {line.kind === 'installing' && (
          <>
            <Text size="sm">{line.job?.phase === 'copy' ? t('server.install.copying') : t('server.install.installing')}</Text>
            <JobBar job={line.job} />
            <Text size="xs" c="dimmed">
              {t('server.install.installingHelp')}
            </Text>
          </>
        )}
        {line.kind === 'failed' && (
          <Alert color="red" variant="light">
            <Text size="sm" style={{ overflowWrap: 'anywhere' }}>
              {t('server.install.failed', { error: line.error ?? '—' })}
            </Text>
            <Text size="xs" c="dimmed" mt={4}>
              {t('server.install.failedHelp')}
            </Text>
          </Alert>
        )}
        {line.kind === 'own' && <Text size="sm">{t('server.install.own')}</Text>}
        {v.next && waitingMove && (
          <Stack gap={4}>
            <Text size="sm" c="orange">
              {t(waitingMove.key, waitingMove.values)}
            </Text>
            {v.next.state === 'installing' && (
              <>
                <Text size="xs" c="dimmed">
                  {t('server.install.nextPreparing')}
                </Text>
                <JobBar job={v.next.job} />
              </>
            )}
          </Stack>
        )}
        {can('server.update') && server.managed && canMoveNow(v) && (
          <Group justify="space-between" wrap="wrap" gap="xs">
            <Text size="xs" c="dimmed">
              {t('server.install.moveHelp')}
            </Text>
            <Button size="xs" variant="default" disabled={busy || runs} onClick={move}>
              {v.state === 'failed' ? t('server.install.retry') : t('server.install.moveNow')}
            </Button>
          </Group>
        )}
      </Stack>
    </Card>
  );
}
