import { Badge, Button, Group, Modal, Select, Stack, Table, Text } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { useQuery } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { diffLines, withContext } from '@gsp/shared';
import { get } from '../../api/http';
import { formatDateTime, useErrorText } from '../../lib/format';
import { propose, useFileLabel, type FileDecl, type ProposalPreview } from './api';
import { DiffView } from './DiffView';
import { ProposalModal } from './ProposalModal';

interface VersionRow {
  id: number;
  file: string;
  at: string;
  username: string | null;
  note: string | null;
  size: number;
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
    m = /^preset (.+)$/.exec(note);
    if (m) return t('config.history.preset', { name: m[1] });
    return note;
  };
}

/** One file's versions: each one's diff against the one before, and a revert that is previewed like any change (CFG-03). */
export function FileHistory({ fileId }: { fileId: string }) {
  const { t, i18n } = useTranslation();
  const errorText = useErrorText();
  const noteText = useNoteText();
  const [viewing, setViewing] = useState<number | null>(null);
  const [revert, setRevert] = useState<ProposalPreview | null>(null);
  const list = useQuery({ queryKey: ['config', 'history', fileId], queryFn: () => get<VersionRow[]>(`/api/config/history?file=${encodeURIComponent(fileId)}`) });
  const version = useQuery({
    queryKey: ['config', 'version', viewing],
    queryFn: () => get<{ row: VersionRow; content: string; previous: string | null }>(`/api/config/history/${viewing}`),
    enabled: viewing !== null,
  });
  const lines = useMemo(() => (version.data ? withContext(diffLines(version.data.previous ?? '', version.data.content)) : []), [version.data]);

  const previewRevert = (id: number) =>
    void propose({ fileId, revert: id }).then(
      (p) => {
        setViewing(null);
        setRevert(p);
      },
      (e: unknown) => notifications.show({ color: 'red', message: errorText(e) }),
    );

  if (list.error) return <Text c="red">{errorText(list.error)}</Text>;
  return (
    <Stack>
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
                  <Table.Td>
                    {v.username ?? (
                      <Badge size="xs" variant="outline" color="gray">
                        {t('config.history.external')}
                      </Badge>
                    )}
                  </Table.Td>
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
            <DiffView lines={lines} height="60vh" />
            <Group justify="flex-end">
              <Button onClick={() => previewRevert(version.data.row.id)}>{t('config.history.revert')}</Button>
            </Group>
          </Stack>
        )}
      </Modal>
      <ProposalModal preview={revert} title={t('config.history.revertPreview')} onClose={() => setRevert(null)} onApplied={() => setRevert(null)} />
    </Stack>
  );
}

/** The history tab: pick a declared file. The editor shows the history of any file it opens. */
export function ConfigHistory({ files }: { files: FileDecl[] }) {
  const { t } = useTranslation();
  const fileLabel = useFileLabel();
  const [file, setFile] = useState<string>(files[0]?.id ?? '');
  return (
    <Stack>
      <Select w={280} label={t('config.history.file')} value={file} onChange={(v) => v && setFile(v)} allowDeselect={false} data={files.map((f) => ({ value: f.id, label: fileLabel(f.id) }))} />
      {file && <FileHistory fileId={file} />}
    </Stack>
  );
}
