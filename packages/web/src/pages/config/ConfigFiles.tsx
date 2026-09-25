import { Alert, Badge, Button, Drawer, Grid, Group, Loader, NavLink, Paper, ScrollArea, Stack, Text, Tooltip, UnstyledButton } from '@mantine/core';
import { useDebouncedValue } from '@mantine/hooks';
import { modals } from '@mantine/modals';
import { IconAlertTriangle, IconFile, IconFileOff, IconFolder, IconHistory, IconLock, IconSettings } from '@tabler/icons-react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useSearchParams } from 'react-router';
import { formatFor, type ParseIssue } from '@gsp/formats';
import { ApiError } from '../../api/http';
import { useServerApi } from '../../api/server';
import { CodeEditor, type CodeEditorHandle } from '../../components/CodeEditor';
import { useErrorText } from '../../lib/format';
import { getContent, propose, useFileLabel, type FileContent, type FilesView, type ProposalPreview, type ReadonlyReason, type TreeEntry } from './api';
import { FileHistory } from './ConfigHistory';
import { ProposalModal } from './ProposalModal';

/** Reasons a file can't even be opened (the others open read-only). */
const UNREADABLE = new Set<string>(['outside-roots', 'symlink', 'not-a-file', 'too-large', 'binary', 'not-utf8', 'missing']);

function ReasonIcon({ reason }: { reason: string | null }) {
  if (!reason) return <IconFile size={16} />;
  return UNREADABLE.has(reason) ? <IconFileOff size={16} /> : <IconLock size={16} />;
}

function TreeItems({ entries, selected, onOpen }: { entries: TreeEntry[]; selected: string | null; onOpen: (id: string) => void }) {
  const { t } = useTranslation();
  return (
    <>
      {entries.map((e) =>
        e.kind === 'dir' ? (
          <NavLink key={e.id} label={e.name} leftSection={<IconFolder size={16} />} defaultOpened childrenOffset={14}>
            <TreeItems entries={e.children ?? []} selected={selected} onOpen={onOpen} />
          </NavLink>
        ) : (
          <NavLink
            key={e.id}
            label={e.name}
            active={selected === e.id}
            disabled={e.reason !== null && UNREADABLE.has(e.reason)}
            description={e.reason ? t(`files.reasons.${e.reason}`) : undefined}
            leftSection={<ReasonIcon reason={e.reason} />}
            onClick={() => onOpen(e.id)}
          />
        ),
      )}
    </>
  );
}

/** The declared config files first, then each editable folder's tree (CFG-07). */
function FileTree({ view, selected, onOpen }: { view: FilesView; selected: string | null; onOpen: (id: string) => void }) {
  const { t, i18n } = useTranslation();
  const fileLabel = useFileLabel();
  return (
    <Paper withBorder p={4}>
      <ScrollArea.Autosize mah={{ base: '40vh', md: '70vh' }} type="auto">
        <NavLink label={t('files.declared')} leftSection={<IconSettings size={16} />} defaultOpened childrenOffset={14}>
          {view.files.map((f) => (
            <NavLink
              key={f.id}
              label={fileLabel(f.id)}
              active={selected === f.id}
              disabled={!f.exists}
              description={f.reason ? t(`files.reasons.${f.reason}`) : f.rel.split('/').at(-1)}
              leftSection={<ReasonIcon reason={f.reason} />}
              onClick={() => onOpen(f.id)}
            />
          ))}
        </NavLink>
        {view.folders.map((folder) => (
          <NavLink key={folder.id} label={i18n.language.startsWith('en') ? folder.label.en : folder.label.es} leftSection={<IconFolder size={16} />} defaultOpened={folder.entries.length > 0} childrenOffset={14}>
            {folder.entries.length === 0 ? (
              <Text size="xs" c="dimmed" px="sm" py={4}>
                {t('files.emptyFolder', { folder: folder.rel })}
              </Text>
            ) : (
              <TreeItems entries={folder.entries} selected={selected} onOpen={onOpen} />
            )}
            {folder.truncated && (
              <Text size="xs" c="dimmed" px="sm">
                {t('files.truncated')}
              </Text>
            )}
          </NavLink>
        ))}
      </ScrollArea.Autosize>
    </Paper>
  );
}

/** Problems of the text as typed: the format's own check, and the shape a file the game executes must keep. */
function useLiveIssues(text: string, content: FileContent | undefined): ParseIssue[] {
  const [debounced] = useDebouncedValue(text, 300);
  return useMemo(() => {
    if (!content) return [];
    const format = formatFor({ format: content.format });
    const r = format.parse(debounced);
    if (!r.ok) return r.issues;
    const shape = content.dataOnly && format.checkShape?.(r.doc, content.dataOnly);
    return shape ? [shape] : [];
  }, [debounced, content]);
}

function FileEditor({ id, onDirty }: { id: string; onDirty: (dirty: boolean) => void }) {
  const { t } = useTranslation();
  const errorText = useErrorText();
  const fileLabel = useFileLabel();
  const qc = useQueryClient();
  const sapi = useServerApi();
  const editor = useRef<CodeEditorHandle>(null);
  const q = useQuery({ queryKey: ['config', 'content', id, sapi.sid], queryFn: () => getContent(sapi, id), retry: false });
  // The version being edited; a newer one from the server never replaces unsaved edits.
  const [base, setBase] = useState<FileContent | null>(null);
  const [text, setText] = useState('');
  const [serverIssues, setServerIssues] = useState<ParseIssue[]>([]);
  const [problem, setProblem] = useState<string | null>(null);
  const [stale, setStale] = useState(false);
  const [preview, setPreview] = useState<ProposalPreview | null>(null);
  const [saving, setSaving] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  // A read-only file (a script shown for reference) has nothing to fix.
  const liveIssues = useLiveIssues(text, base && !base.readonlyReason ? base : undefined);
  const issues = serverIssues.length ? serverIssues : liveIssues;
  const dirty = base !== null && text !== base.text;
  const editing = useRef({ base, text });
  editing.current = { base, text };

  const adopt = (c: FileContent) => {
    setBase(c);
    setText(c.text);
    setServerIssues([]);
    setStale(false);
    setProblem(null);
  };

  useEffect(() => {
    const next = q.data;
    if (!next) return;
    const cur = editing.current;
    if (cur.base && cur.text !== cur.base.text) {
      if (next.sha256 !== cur.base.sha256) setStale(true);
      return;
    }
    adopt(next);
  }, [q.data]);

  useEffect(() => {
    onDirty(dirty);
    if (!dirty) return;
    const warn = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty, onDirty]);

  if (q.error) {
    const reason = q.error instanceof ApiError && typeof q.error.extra.reason === 'string' ? q.error.extra.reason : null;
    return <Alert color="blue">{reason ? t(`files.reasons.${reason}`) : errorText(q.error)}</Alert>;
  }
  if (!base) return <Loader />;
  const content = base;
  const readonly: ReadonlyReason | null = content.readonlyReason;
  const reload = () => void q.refetch().then((r) => r.data && adopt(r.data));

  const save = async () => {
    setSaving(true);
    setProblem(null);
    setServerIssues([]);
    try {
      setPreview(await propose(sapi, { fileId: id, text, baseSha256: content.sha256 }));
    } catch (e) {
      if (e instanceof ApiError && e.code === 'invalid-file' && Array.isArray(e.extra.issues)) setServerIssues(e.extra.issues as ParseIssue[]);
      else if (e instanceof ApiError && e.code === 'stale') setStale(true);
      else setProblem(errorText(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Stack>
      <Group justify="space-between" wrap="wrap" gap="xs">
        <Group gap="xs">
          <Text fw={600}>{fileLabel(id)}</Text>
          <Badge variant="light" color="gray" tt="none">
            {content.format}
          </Badge>
          {readonly && (
            <Tooltip label={t(`files.reasons.${readonly}`)}>
              <Badge color="gray" leftSection={<IconLock size={12} />}>
                {t('files.readonly')}
              </Badge>
            </Tooltip>
          )}
        </Group>
        <Group gap="xs">
          <Button variant="subtle" leftSection={<IconHistory size={16} />} onClick={() => setHistoryOpen(true)}>
            {t('files.history')}
          </Button>
          <Button variant="default" disabled={!dirty || saving} onClick={() => setText(content.text)}>
            {t('config.discard')}
          </Button>
          <Button onClick={() => void save()} disabled={!dirty || readonly !== null || liveIssues.length > 0} loading={saving}>
            {t('files.previewSave')}
          </Button>
        </Group>
      </Group>

      {readonly && (
        <Alert color="gray" variant="light" icon={<IconLock />}>
          {t(`files.reasons.${readonly}`)}
        </Alert>
      )}
      {content.managedKeys.length > 0 && (
        <Text size="xs" c="dimmed">
          {t('files.managedNote', { keys: content.managedKeys.join(', ') })}
        </Text>
      )}
      {content.secretKeys.length > 0 && (
        <Text size="xs" c="dimmed">
          {t('files.secretNote')}
        </Text>
      )}
      {stale && (
        <Alert color="orange" variant="light" icon={<IconAlertTriangle />} title={t('errors.stale')}>
          <Group justify="space-between">
            <Text size="sm">{t('files.staleHelp')}</Text>
            <Button size="xs" variant="light" onClick={reload}>
              {t('files.reload')}
            </Button>
          </Group>
        </Alert>
      )}
      {problem && (
        <Alert color="red" variant="light">
          {problem}
        </Alert>
      )}

      <CodeEditor
        ref={editor}
        value={text}
        onChange={(v) => {
          setText(v);
          setServerIssues([]);
        }}
        highlight={content.highlight}
        readOnly={readonly !== null}
        issues={issues}
      />

      {issues.length > 0 && (
        <Alert color="red" variant="light" title={t('files.issues', { count: issues.length })}>
          <Stack gap={2}>
            {issues.map((i, n) => (
              <UnstyledButton key={n} onClick={() => editor.current?.goTo(i.line, i.col)}>
                <Text size="sm">
                  <b>{i.col ? t('files.lineCol', { line: i.line, col: i.col }) : t('files.line', { line: i.line })}</b>: {i.message}
                </Text>
              </UnstyledButton>
            ))}
          </Stack>
        </Alert>
      )}

      <ProposalModal
        preview={preview}
        onClose={() => setPreview(null)}
        onApplied={() => {
          setPreview(null);
          reload();
          void qc.invalidateQueries({ queryKey: ['config'] });
        }}
      />
      <Drawer opened={historyOpen} onClose={() => setHistoryOpen(false)} position="right" size="xl" title={t('files.historyOf', { file: fileLabel(id) })}>
        <FileHistory fileId={id} />
      </Drawer>
    </Stack>
  );
}

/** The text editor for every config file (CFG-07): browse, edit with checks as you type, preview the change, apply, history. */
export function ConfigFiles() {
  const { t } = useTranslation();
  const sapi = useServerApi();
  const errorText = useErrorText();
  const [params, setParams] = useSearchParams();
  const selected = params.get('file');
  const dirty = useRef(false);
  const setDirty = useCallback((d: boolean) => {
    dirty.current = d;
  }, []);
  const files = useQuery({ queryKey: ['config', 'files', sapi.sid], queryFn: () => sapi<FilesView>('GET', '/config/files') });

  const open = (id: string) => {
    if (id === selected) return;
    const go = () =>
      setParams((p) => {
        p.set('tab', 'files');
        p.set('file', id);
        return p;
      });
    if (!dirty.current) return go();
    modals.openConfirmModal({
      title: t('files.unsavedTitle'),
      children: <Text size="sm">{t('files.unsaved')}</Text>,
      labels: { confirm: t('config.discard'), cancel: t('common.cancel') },
      onConfirm: go,
    });
  };

  return (
    <Stack>
      <Text size="sm" c="dimmed">
        {t('files.help')}
      </Text>
      <Grid>
        <Grid.Col span={{ base: 12, md: 4, lg: 3 }}>{files.error ? <Alert color="red">{errorText(files.error)}</Alert> : files.data ? <FileTree view={files.data} selected={selected} onOpen={open} /> : <Loader />}</Grid.Col>
        <Grid.Col span={{ base: 12, md: 8, lg: 9 }}>
          {selected ? (
            <FileEditor key={selected} id={selected} onDirty={setDirty} />
          ) : (
            <Alert color="blue" variant="light">
              {t('files.pick')}
            </Alert>
          )}
        </Grid.Col>
      </Grid>
    </Stack>
  );
}
