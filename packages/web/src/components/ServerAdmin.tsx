// Renaming and deleting a server (SRV-04, `PATCH`/`DELETE /api/servers/:sid`),
// from its own pages and from the server list.
import { Alert, Button, Checkbox, Group, Modal, Stack, Text, TextInput } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { IconAlertTriangle } from '@tabler/icons-react';
import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router';
import { serverApi } from '../api/http';
import { SERVERS_KEY, withServer, type ServerSummary } from '../api/server';
import { useSession } from '../api/session';
import { useErrorText } from '../lib/format';
import { nameProblem } from '../lib/servers';

/** `DELETE /api/servers/:sid`. */
interface DeleteResult {
  ok: boolean;
  /** The final backup's archive name; null when none was taken. */
  finalBackup: string | null;
  forced?: boolean;
  /** Forced only: why the final backup couldn't be taken. */
  finalBackupError?: string | null;
}

/** States in which a server can't be deleted without forcing it (the API answers `server-running`). */
const UP = new Set(['running', 'starting', 'stopping', 'installing']);

export function RenameServerModal({ server, opened, onClose }: { server: ServerSummary; opened: boolean; onClose: () => void }) {
  const { t } = useTranslation();
  const errorText = useErrorText();
  const qc = useQueryClient();
  const [name, setName] = useState(server.name);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    if (opened) {
      setName(server.name);
      setError(null);
    }
  }, [opened, server.name]);
  const others = (qc.getQueryData<ServerSummary[]>(SERVERS_KEY) ?? []).filter((s) => s.id !== server.id).map((s) => s.name);
  const problem = nameProblem(name, others);

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      const sapi = serverApi(server.id);
      const next = await sapi<ServerSummary>('PATCH', '', { name: name.trim() });
      qc.setQueryData<ServerSummary[]>(SERVERS_KEY, (list) => withServer(list, next));
      notifications.show({ color: 'green', message: t('servers.renamed', { name: next.name }) });
      onClose();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal opened={opened} onClose={onClose} title={t('servers.renameTitle', { name: server.name })} centered>
      <Stack>
        <TextInput
          label={t('servers.name')}
          description={t('servers.renameHelp', { id: server.id })}
          value={name}
          onChange={(e) => setName(e.currentTarget.value)}
          maxLength={64}
          error={name.trim() !== server.name && problem ? t(`errors.${problem}`) : undefined}
          data-autofocus
        />
        {error && <Alert color="red">{error}</Alert>}
        <Group justify="flex-end">
          <Button variant="default" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button onClick={() => void save()} loading={saving} disabled={!!problem || name.trim() === server.name}>
            {t('common.save')}
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}

/**
 * Deleting a server (SRV-04): typing its name, after a final backup that is
 * kept with its other backups. Skipping that backup, or deleting its
 * backups too, is the owner's choice alone.
 */
export function DeleteServerModal({ server, opened, onClose }: { server: ServerSummary; opened: boolean; onClose: () => void }) {
  const { t } = useTranslation();
  const errorText = useErrorText();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const { session } = useSession();
  const owner = session?.user.role === 'owner';
  const [confirm, setConfirm] = useState('');
  const [skipBackup, setSkipBackup] = useState(false);
  const [dropBackups, setDropBackups] = useState(false);
  const [force, setForce] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);
  useEffect(() => {
    if (opened) {
      setConfirm('');
      setSkipBackup(false);
      setDropBackups(false);
      setForce(false);
      setError(null);
    }
  }, [opened]);
  const up = server.state !== null && UP.has(server.state);
  // Its agent doesn't answer: only a forced removal goes on (the API answers `server-unreachable`).
  const unreachable = server.managed && !server.agentConnected;

  const remove = async () => {
    setDeleting(true);
    setError(null);
    try {
      const sapi = serverApi(server.id);
      const r = await sapi<DeleteResult>('DELETE', '', {
        confirm: confirm.trim(),
        ...(owner && skipBackup ? { finalBackup: false } : {}),
        ...(owner && dropBackups ? { keepBackups: false } : {}),
        ...(owner && force ? { force: true } : {}),
      });
      qc.setQueryData<ServerSummary[]>(SERVERS_KEY, (list) => (list ?? []).filter((s) => s.id !== server.id));
      qc.removeQueries({ predicate: (q) => q.queryKey.includes(server.id) });
      // A forced removal goes on without the final backup when it can't be taken: say so, and why.
      const noBackup = r.forced && r.finalBackupError;
      notifications.show({
        color: noBackup ? 'orange' : 'green',
        autoClose: noBackup ? false : 10_000,
        message: noBackup
          ? t('servers.deletedNoBackup', { name: server.name, reason: r.finalBackupError })
          : r.finalBackup
            ? t('servers.deletedWithBackup', { name: server.name, file: r.finalBackup })
            : t('servers.deleted', { name: server.name }),
      });
      onClose();
      navigate('/servers');
    } catch (e) {
      setError(errorText(e));
    } finally {
      setDeleting(false);
    }
  };

  return (
    <Modal opened={opened} onClose={deleting ? () => undefined : onClose} title={t('servers.deleteTitle', { name: server.name })} centered size="lg">
      <Stack>
        <Text size="sm">{t('servers.deleteIntro')}</Text>
        <Text size="sm">{dropBackups ? t('servers.deleteBackupsGone') : skipBackup ? t('servers.deleteNoFinal') : t('servers.deleteFinal')}</Text>
        {!server.managed && (
          <Alert color="blue" variant="light">
            {t('servers.unmanagedNote')}
          </Alert>
        )}
        {unreachable && !force ? (
          <Alert color="orange" variant="light" icon={<IconAlertTriangle />}>
            {owner ? t('servers.deleteUnreachableOrForce') : t('servers.deleteUnreachable')}
          </Alert>
        ) : (
          up &&
          !force && (
            <Alert color="orange" variant="light" icon={<IconAlertTriangle />}>
              {owner ? t('servers.deleteStopFirstOrForce') : t('servers.deleteStopFirst')}
            </Alert>
          )
        )}
        {owner && (
          <Stack gap="xs">
            {/* Deleting the backups too leaves nothing to keep a final backup in. */}
            <Checkbox label={t('servers.skipFinal')} description={t('servers.skipFinalHelp')} checked={skipBackup || dropBackups} disabled={dropBackups} onChange={(e) => setSkipBackup(e.currentTarget.checked)} />
            <Checkbox color="red" label={t('servers.dropBackups')} description={t('servers.dropBackupsHelp')} checked={dropBackups} onChange={(e) => setDropBackups(e.currentTarget.checked)} />
            <Checkbox color="red" label={t('servers.force')} description={t('servers.forceHelp')} checked={force} onChange={(e) => setForce(e.currentTarget.checked)} />
          </Stack>
        )}
        <TextInput label={t('servers.deleteConfirm', { name: server.name })} value={confirm} onChange={(e) => setConfirm(e.currentTarget.value)} autoComplete="off" spellCheck={false} data-autofocus />
        {error && <Alert color="red">{error}</Alert>}
        {deleting && (
          <Text size="sm" c="dimmed">
            {skipBackup || dropBackups || !server.managed ? t('servers.deleting') : t('servers.deletingBackup')}
          </Text>
        )}
        <Group justify="flex-end">
          <Button variant="default" onClick={onClose} disabled={deleting}>
            {t('common.cancel')}
          </Button>
          <Button color="red" onClick={() => void remove()} loading={deleting} disabled={confirm.trim() !== server.name}>
            {t('servers.delete')}
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}
