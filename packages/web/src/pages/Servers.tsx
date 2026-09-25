import { Alert, Card, Center, Group, Loader, SimpleGrid, Stack, Text, Title } from '@mantine/core';
import { useTranslation } from 'react-i18next';
import { Link, Navigate } from 'react-router';
import { localize } from '../api/meta';
import { serverHref, useServers } from '../api/server';
import { StateBadge } from '../components/StateBadge';
import { formatDateTime, useErrorText } from '../lib/format';
import type { ServerState } from '@gsp/shared';

/**
 * Home: the servers this user may see (SRV-02). With exactly one, it opens
 * that server's dashboard straight away. (The full server list, with
 * creation, is M2's UI.)
 */
export function Servers() {
  const { t, i18n } = useTranslation();
  const errorText = useErrorText();
  const q = useServers();

  if (q.isLoading) {
    return (
      <Center mt="xl">
        <Loader />
      </Center>
    );
  }
  if (q.error) return <Alert color="red">{errorText(q.error)}</Alert>;
  const list = q.data ?? [];
  if (list.length === 1) return <Navigate to={serverHref(list[0]!.id, '/')} replace />;

  return (
    <Stack>
      <Title order={2}>{t('servers.title')}</Title>
      {list.length === 0 && <Text c="dimmed">{t('servers.none')}</Text>}
      <SimpleGrid cols={{ base: 1, sm: 2, lg: 3 }}>
        {list.map((s) => (
          <Card key={s.id} withBorder padding="md" component={Link} to={serverHref(s.id, '/')}>
            <Group justify="space-between" wrap="nowrap">
              <Stack gap={0}>
                <Text fw={600}>{s.name}</Text>
                <Text size="xs" c="dimmed">
                  {localize(s.adapterName, i18n.language)}
                  {s.version ? ` · ${s.version}` : ''}
                </Text>
              </Stack>
              <StateBadge state={(s.state ?? undefined) as ServerState | undefined} agentConnected={s.agentConnected} size="sm" />
            </Group>
            <Text size="sm" mt="sm">
              {s.players === null ? '' : t('servers.players', { n: s.players })}
            </Text>
            {s.nextRestart && (
              <Text size="xs" c="dimmed">
                {t('servers.nextRestart', { when: formatDateTime(s.nextRestart, i18n.language, false) })}
              </Text>
            )}
          </Card>
        ))}
      </SimpleGrid>
    </Stack>
  );
}
