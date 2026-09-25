import { Alert, Anchor, Button, Checkbox, Group, Modal, Stack, Text } from '@mantine/core';
import { useDisclosure } from '@mantine/hooks';
import { notifications } from '@mantine/notifications';
import { IconExternalLink, IconFileCertificate } from '@tabler/icons-react';
import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { localize } from '../api/meta';
import { SERVERS_KEY, useServerApi, useServerScope, withServer, type EulaSummary, type ServerSummary } from '../api/server';
import { useSession } from '../api/session';
import { formatDateTime, useErrorText } from '../lib/format';

/** The agreement's name, linked to where it is read (a new tab, nothing of the panel's sent along). */
export function AgreementLink({ agreement }: { agreement: Pick<EulaSummary, 'name' | 'url'> }) {
  const { i18n } = useTranslation();
  return (
    <Anchor href={agreement.url} target="_blank" rel="noopener noreferrer">
      {localize(agreement.name, i18n.language)} <IconExternalLink size={12} style={{ verticalAlign: 'middle' }} />
    </Anchor>
  );
}

/**
 * A game whose license the owner must accept (D6): while it waits, the
 * server can't start. The owner reads the agreement and accepts it here
 * (`POST /api/servers/:sid/eula`); everyone else is told who can. Once
 * accepted, `showAccepted` says who accepted it and when.
 */
export function EulaNotice({ showAccepted = false }: { showAccepted?: boolean }) {
  const { t, i18n } = useTranslation();
  const errorText = useErrorText();
  const { can } = useSession();
  const qc = useQueryClient();
  const sapi = useServerApi();
  const server = useServerScope()?.server ?? null;
  const [open, dialog] = useDisclosure();
  const [read, setRead] = useState(false);
  const [saving, setSaving] = useState(false);
  const eula = server?.eula ?? null;
  if (!server || !eula) return null;

  if (eula.acceptedAt) {
    if (!showAccepted) return null;
    return (
      <Text size="sm" c="dimmed">
        <IconFileCertificate size={14} style={{ verticalAlign: 'middle' }} /> {t('eula.accepted', { by: eula.acceptedBy ?? t('eula.someone'), when: formatDateTime(eula.acceptedAt, i18n.language, false) })} <AgreementLink agreement={eula} />
      </Text>
    );
  }

  const accept = async () => {
    setSaving(true);
    try {
      const next = await sapi<ServerSummary>('POST', '/eula', { accept: true });
      qc.setQueryData<ServerSummary[]>(SERVERS_KEY, (list) => withServer(list, next));
      notifications.show({ color: 'green', message: t('eula.done') });
      dialog.close();
    } catch (e) {
      notifications.show({ color: 'red', message: errorText(e) });
    } finally {
      setSaving(false);
    }
  };

  const owner = can('server.eula');
  return (
    <>
      <Alert color="orange" variant="light" icon={<IconFileCertificate />} title={t('eula.pendingTitle')}>
        <Stack gap="xs">
          <Text size="sm">{t('eula.pending', { game: localize(server.adapterName, i18n.language) })}</Text>
          {owner ? (
            <Group>
              <Button size="xs" color="orange" onClick={dialog.open}>
                {t('eula.review')}
              </Button>
            </Group>
          ) : (
            <Text size="sm">{t('eula.ownerOnly')}</Text>
          )}
        </Stack>
      </Alert>
      {owner && (
        <Modal opened={open} onClose={dialog.close} title={t('eula.dialogTitle')}>
          <Stack>
            <Text size="sm">{t('eula.dialogIntro', { game: localize(server.adapterName, i18n.language) })}</Text>
            <AgreementLink agreement={eula} />
            <Text size="sm" c="dimmed">
              {t('eula.dialogNote')}
            </Text>
            <Checkbox label={t('eula.confirm')} checked={read} onChange={(e) => setRead(e.currentTarget.checked)} />
            <Group justify="flex-end">
              <Button variant="default" onClick={dialog.close}>
                {t('common.cancel')}
              </Button>
              <Button onClick={() => void accept()} loading={saving} disabled={!read}>
                {t('eula.accept')}
              </Button>
            </Group>
          </Stack>
        </Modal>
      )}
    </>
  );
}
