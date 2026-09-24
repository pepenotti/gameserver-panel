import { Badge, Box, Button, Group, Modal, ScrollArea, Select, Stack, Table, Text } from '@mantine/core';
import { modals } from '@mantine/modals';
import { notifications } from '@mantine/notifications';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { get, post } from '../../api/http';
import { diffLines, withContext } from '../../lib/diff';
import { formatDateTime, useErrorText } from '../../lib/format';

type FileKey = 'ini' | 'sandbox' | 'spawnregions' | 'spawnpoints';

interface VersionRow {
  id: number;
  file: FileKey;
  at: string;
  username: string | null;
  note: string | null;
  size: number;
}

function Diff({ before, after }: { before: string | null; after: string }) {
  const { t } = useTranslation();
  const lines = useMemo(() => withContext(diffLines(before ?? '', after)), [before, after]);
  if (!lines.some((l) => l && l.kind !== 'same')) return <Text c="dimmed">{t('config.history.noDiff')}</Text>;
  return (
    <ScrollArea h="60vh" type="auto">
      <Box ff="monospace" fz={12} style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
        {lines.map((l, i) =>
          l === null ? (
            <Text key={i} c="dimmed" ff="monospace" fz={12}>
              ⋯
            </Text>
          ) : (
            <div
              key={i}
              style={{
                background: l.kind === 'add' ? 'rgba(64, 192, 87, 0.15)' : l.kind === 'del' ? 'rgba(250, 82, 82, 0.15)' : undefined,
                color: l.kind === 'same' ? 'var(--mantine-color-dimmed)' : undefined,
              }}
            >
              {l.kind === 'add' ? '+ ' : l.kind === 'del' ? '- ' : '  '}
              {l.text}
            </div>
          ),
        )}
      </Box>
    </ScrollArea>
  );
}

/** Server-side notes are English and structured; show them in the user's language. */
function useNoteText(): (note: string | null) => string {
  const { t } = useTranslation();
  return (note) => {
    if (!note) return '';
    if (note === 'on disk before this change') return t('config.history.external');
    if (note === 'first-run defaults') return t('config.history.firstRun');
    if (note === 'raw edit') return t('config.history.rawEdit');
    let m = /^changed (.+)$/.exec(note);
    if (m) return t('config.history.changed', { keys: m[1] });
    m = /^revert to version (\d+)$/.exec(note);
    if (m) return t('config.history.revertedTo', { id: m[1] });
    return note;
  };
}

export function ConfigHistory() {
  const { t, i18n } = useTranslation();
  const errorText = useErrorText();
  const noteText = useNoteText();
  const qc = useQueryClient();
  const [file, setFile] = useState<FileKey>('ini');
  const [viewing, setViewing] = useState<number | null>(null);
  const list = useQuery({ queryKey: ['config', 'history', file], queryFn: () => get<VersionRow[]>(`/api/config/history?file=${file}`) });
  const version = useQuery({
    queryKey: ['config', 'version', viewing],
    queryFn: () => get<{ row: VersionRow; content: string; previous: string | null }>(`/api/config/history/${viewing}`),
    enabled: viewing !== null,
  });

  const revert = (id: number) =>
    modals.openConfirmModal({
      title: t('config.history.revert'),
      children: <Text size="sm">{t('config.history.revertConfirm')}</Text>,
      labels: { confirm: t('config.history.revert'), cancel: t('common.cancel') },
      onConfirm: () =>
        void post(`/api/config/history/${id}/revert`).then(
          () => {
            notifications.show({ color: 'green', message: t('config.history.reverted') });
            setViewing(null);
            void qc.invalidateQueries({ queryKey: ['config'] });
          },
          (e: unknown) => notifications.show({ color: 'red', message: errorText(e) }),
        ),
    });

  return (
    <Stack>
      <Select
        w={280}
        label={t('config.history.file')}
        value={file}
        onChange={(v) => v && setFile(v as FileKey)}
        allowDeselect={false}
        data={(['ini', 'sandbox', 'spawnregions', 'spawnpoints'] as FileKey[]).map((k) => ({ value: k, label: t(`config.files.${k}`) }))}
      />
      {list.data?.length === 0 ? (
        <Text c="dimmed">{t('config.history.empty')}</Text>
      ) : (
        <Table.ScrollContainer minWidth={520}>
          <Table striped fz="sm">
            <Table.Thead>
              <Table.Tr>
                <Table.Th>{t('config.history.when')}</Table.Th>
                <Table.Th>{t('config.history.who')}</Table.Th>
                <Table.Th>{t('config.history.note')}</Table.Th>
                <Table.Th />
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {list.data?.map((v) => (
                <Table.Tr key={v.id}>
                  <Table.Td style={{ whiteSpace: 'nowrap' }}>{formatDateTime(v.at, i18n.language)}</Table.Td>
                  <Table.Td>{v.username ?? <Badge size="xs" variant="outline" color="gray">{t('config.history.external')}</Badge>}</Table.Td>
                  <Table.Td>
                    <Text size="sm" lineClamp={1}>
                      {noteText(v.note)}
                    </Text>
                  </Table.Td>
                  <Table.Td ta="right">
                    <Button size="compact-xs" variant="subtle" onClick={() => setViewing(v.id)}>
                      {t('config.history.view')}
                    </Button>
                  </Table.Td>
                </Table.Tr>
              ))}
            </Table.Tbody>
          </Table>
        </Table.ScrollContainer>
      )}
      <Modal opened={viewing !== null} onClose={() => setViewing(null)} size="xl" title={version.data ? `${formatDateTime(version.data.row.at, i18n.language)} — ${noteText(version.data.row.note)}` : ''}>
        {version.data && (
          <Stack>
            <Diff before={version.data.previous} after={version.data.content} />
            <Group justify="flex-end">
              <Button onClick={() => revert(version.data.row.id)}>{t('config.history.revert')}</Button>
            </Group>
          </Stack>
        )}
      </Modal>
    </Stack>
  );
}
