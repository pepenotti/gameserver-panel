import { Badge, Button, Group, Select, Stack, Table, Text, TextInput, Title } from '@mantine/core';
import { useDebouncedValue } from '@mantine/hooks';
import { useInfiniteQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '../api/http';
import { useServers } from '../api/server';
import { useSession } from '../api/session';
import type { AuditEntry } from '../api/types';
import { AddressNote } from '../components/AddressNote';
import { formatDateTime } from '../lib/format';

const PAGE = 100;
/** The filter values that aren't a server id; `-` is also what the API takes for the panel's own entries. */
const ALL = '*';
const HOST = '-';

/**
 * The activity log (ACC-03, AST-02): every entry names its server (or none,
 * for accounts, sign-ins and the panel's settings) and who acted as what.
 * Filtered by server through the API; an admin of some servers sees only
 * theirs.
 */
export function Audit() {
  const { t, i18n } = useTranslation();
  const { canHost } = useSession();
  const servers = useServers();
  const everywhere = canHost('audit.view');
  const [filter, setFilter] = useState('');
  const [server, setServer] = useState<string>(ALL);
  const [debounced] = useDebouncedValue(filter.trim().toLowerCase().replace(/[^a-z0-9.-]/g, ''), 300);
  // A server id, or HOST: entries about no server, filtered by the API like a server's.
  const byServer = server !== ALL ? server : null;
  const q = useInfiniteQuery({
    queryKey: ['audit', debounced, byServer],
    initialPageParam: 0,
    queryFn: ({ pageParam }) =>
      api<AuditEntry[]>(
        'GET',
        `/api/audit?limit=${PAGE}${pageParam ? `&before=${pageParam}` : ''}${debounced ? `&action=${debounced}` : ''}${byServer ? `&server=${encodeURIComponent(byServer)}` : ''}`,
      ),
    getNextPageParam: (last) => (last.length === PAGE ? last[last.length - 1]!.id : undefined),
  });
  const rows = q.data?.pages.flat() ?? [];
  const nameOf = (sid: string) => servers.data?.find((s) => s.id === sid)?.name ?? sid;
  // Everyone sees the servers they may audit; the panel's own entries only with the permission everywhere.
  const options = [
    { value: ALL, label: everywhere ? t('audit.allEntries') : t('audit.allMine') },
    ...(everywhere ? [{ value: HOST, label: t('audit.hostOnly') }] : []),
    ...(servers.data ?? []).filter((s) => everywhere || s.permissions.includes('audit.view')).map((s) => ({ value: s.id, label: s.name })),
  ];
  const who = (r: AuditEntry) => {
    if (r.actorType === 'user') return r.username ?? <Text c="dimmed" size="sm">{t('audit.system')}</Text>;
    const kind = t(`audit.actors.${r.actorType}`, { defaultValue: r.actorType });
    return (
      <Group gap={4} wrap="nowrap">
        <Badge size="xs" variant="outline" color="gray" tt="none">
          {kind}
        </Badge>
        {r.username && <Text size="sm">{r.username}</Text>}
      </Group>
    );
  };

  return (
    <Stack>
      <Group justify="space-between" align="flex-end">
        <Title order={2}>{t('audit.title')}</Title>
        <Group gap="xs" wrap="wrap">
          <Select aria-label={t('audit.server')} data={options} value={server} onChange={(v) => v && setServer(v)} allowDeselect={false} w={{ base: '100%', xs: 220 }} searchable={options.length > 8} />
          <TextInput placeholder={t('audit.filter')} aria-label={t('audit.filter')} value={filter} onChange={(e) => setFilter(e.currentTarget.value)} w={{ base: '100%', xs: 220 }} />
        </Group>
      </Group>
      {/* HST-07: where every visitor arrives from one address, the address column tells nobody apart. */}
      <AddressNote />
      <Table.ScrollContainer minWidth={920}>
        <Table striped fz="sm">
          <Table.Thead>
            <Table.Tr>
              <Table.Th>{t('audit.when')}</Table.Th>
              <Table.Th>{t('audit.server')}</Table.Th>
              <Table.Th>{t('audit.who')}</Table.Th>
              <Table.Th>{t('audit.action')}</Table.Th>
              <Table.Th>{t('audit.target')}</Table.Th>
              <Table.Th>{t('audit.detail')}</Table.Th>
              <Table.Th>{t('audit.address')}</Table.Th>
              <Table.Th>{t('audit.result')}</Table.Th>
            </Table.Tr>
          </Table.Thead>
          <Table.Tbody>
            {rows.map((r) => (
              <Table.Tr key={r.id}>
                <Table.Td style={{ whiteSpace: 'nowrap' }}>{formatDateTime(r.at, i18n.language)}</Table.Td>
                <Table.Td>{r.serverId === null ? <Text size="sm" c="dimmed">{t('audit.host')}</Text> : nameOf(r.serverId)}</Table.Td>
                <Table.Td>{who(r)}</Table.Td>
                <Table.Td>
                  <code>{r.action}</code>
                </Table.Td>
                <Table.Td>{r.target ?? ''}</Table.Td>
                <Table.Td>
                  <Text size="xs" lineClamp={2} title={r.detail ?? ''}>
                    {r.detail ?? ''}
                  </Text>
                </Table.Td>
                <Table.Td ff="monospace" fz="xs">
                  {r.ip ?? ''}
                </Table.Td>
                <Table.Td>
                  <Badge color={r.ok ? 'green' : 'red'} variant="light" size="sm">
                    {r.ok ? t('audit.ok') : t('audit.failed')}
                  </Badge>
                </Table.Td>
              </Table.Tr>
            ))}
          </Table.Tbody>
        </Table>
      </Table.ScrollContainer>
      {rows.length === 0 && !q.isLoading && (
        <Text size="sm" c="dimmed">
          {q.hasNextPage ? t('audit.noneYetOlder') : t('audit.none')}
        </Text>
      )}
      {q.hasNextPage && (
        <Button variant="default" onClick={() => void q.fetchNextPage()} loading={q.isFetchingNextPage}>
          {t('audit.loadMore')}
        </Button>
      )}
    </Stack>
  );
}
