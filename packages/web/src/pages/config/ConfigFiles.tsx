import { Alert, Button, Group, Loader, Select, Stack, Text } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ApiError, get, put } from '../../api/http';
import { CodeEditor } from '../../components/CodeEditor';
import { useErrorText } from '../../lib/format';
import type { ApplyResult } from './options';

type FileKey = 'ini' | 'sandbox' | 'spawnregions' | 'spawnpoints';
const ENDPOINT: Record<FileKey, string> = {
  ini: '/api/config/server/raw',
  sandbox: '/api/config/sandbox/raw',
  spawnregions: '/api/config/spawnregions/raw',
  spawnpoints: '/api/config/spawnpoints/raw',
};

export function ConfigFiles() {
  const { t } = useTranslation();
  const errorText = useErrorText();
  const qc = useQueryClient();
  const [file, setFile] = useState<FileKey>('ini');
  const q = useQuery({ queryKey: ['config', 'raw', file], queryFn: () => get<{ text: string }>(ENDPOINT[file]), retry: false });
  const [text, setText] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (q.data) setText(q.data.text);
    setError(null);
  }, [q.data]);

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      const r = await put<ApplyResult>(ENDPOINT[file], { text });
      notifications.show({
        color: r.warnings.length ? 'orange' : 'green',
        message: [r.applied === 'live' ? t('config.appliedLive') : r.applied === 'unchanged' ? t('config.unchanged') : t('config.appliedNext'), r.warnings.length ? t('config.rejected', { list: r.warnings.join('; ') }) : ''].join(' '),
      });
      await qc.invalidateQueries({ queryKey: ['config'] });
    } catch (e) {
      if (e instanceof ApiError && e.code === 'invalid-lua' && typeof e.extra.message === 'string') {
        setError(typeof e.extra.line === 'number' ? t('config.invalidLua', { line: e.extra.line, message: e.extra.message }) : e.extra.message);
      } else setError(errorText(e));
    } finally {
      setSaving(false);
    }
  };

  const dirty = q.data && text !== q.data.text;

  return (
    <Stack>
      <Text size="sm" c="dimmed">
        {t('config.rawHelp')}
      </Text>
      <Group justify="space-between">
        <Select
          w={280}
          value={file}
          onChange={(v) => v && setFile(v as FileKey)}
          allowDeselect={false}
          data={(Object.keys(ENDPOINT) as FileKey[]).map((k) => ({ value: k, label: t(`config.files.${k}`) }))}
        />
        <Group gap="xs">
          <Button variant="default" disabled={!dirty} onClick={() => q.data && setText(q.data.text)}>
            {t('config.discard')}
          </Button>
          <Button onClick={() => void save()} disabled={!dirty} loading={saving}>
            {t('common.save')}
          </Button>
        </Group>
      </Group>
      {error && (
        <Alert color="red" variant="light">
          {error}
        </Alert>
      )}
      {q.isLoading ? <Loader /> : q.error ? <Alert color="blue">{errorText(q.error)}</Alert> : <CodeEditor value={text} onChange={setText} language={file === 'ini' ? 'ini' : 'lua'} />}
    </Stack>
  );
}
