import { Badge, Button, Group, Stack, Table, Text, TextInput, Title } from '@mantine/core';
import { useDebouncedValue } from '@mantine/hooks';
import { useInfiniteQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { get } from '../api/http';
import type { AuditEntry } from '../api/types';
import { formatDateTime } from '../lib/format';

const PAGE = 100;

export function Audit() {
  const { t, i18n } = useTranslation();
  const [filter, setFilter] = useState('');
  const [debounced] = useDebouncedValue(filter.trim().toLowerCase().replace(/[^a-z0-9.-]/g, ''), 300);
  const q = useInfiniteQuery({
    queryKey: ['audit', debounced],
    initialPageParam: 0,
    queryFn: ({ pageParam }) => get<AuditEntry[]>(`/api/audit?limit=${PAGE}${pageParam ? `&before=${pageParam}` : ''}${debounced ? `&action=${debounced}` : ''}`),
    getNextPageParam: (last) => (last.length === PAGE ? last[last.length - 1]!.id : undefined),
  });
  const rows = q.data?.pages.flat() ?? [];

  return (
    <Stack>
      <Group justify="space-between">
        <Title order={2}>{t('audit.title')}</Title>
        <TextInput placeholder={t('audit.filter')} value={filter} onChange={(e) => setFilter(e.currentTarget.value)} w={220} />
      </Group>
      <Table.ScrollContainer minWidth={700}>
        <Table striped fz="sm">
          <Table.Thead>
            <Table.Tr>
              <Table.Th>{t('audit.when')}</Table.Th>
              <Table.Th>{t('audit.who')}</Table.Th>
              <Table.Th>{t('audit.action')}</Table.Th>
              <Table.Th>{t('audit.target')}</Table.Th>
              <Table.Th>{t('audit.detail')}</Table.Th>
              <Table.Th>{t('audit.result')}</Table.Th>
            </Table.Tr>
          </Table.Thead>
          <Table.Tbody>
            {rows.map((r) => (
              <Table.Tr key={r.id}>
                <Table.Td style={{ whiteSpace: 'nowrap' }}>{formatDateTime(r.at, i18n.language)}</Table.Td>
                <Table.Td>{r.username ?? <Text c="dimmed" size="sm">{t('audit.system')}</Text>}</Table.Td>
                <Table.Td>
                  <code>{r.action}</code>
                </Table.Td>
                <Table.Td>{r.target ?? ''}</Table.Td>
                <Table.Td>
                  <Text size="xs" lineClamp={2} title={r.detail ?? ''}>
                    {r.detail ?? ''}
                  </Text>
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
      {q.hasNextPage && (
        <Button variant="default" onClick={() => void q.fetchNextPage()} loading={q.isFetchingNextPage}>
          {t('audit.loadMore')}
        </Button>
      )}
    </Stack>
  );
}
