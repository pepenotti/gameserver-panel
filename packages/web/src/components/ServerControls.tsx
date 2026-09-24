import { Button, Card, Group, Modal, SegmentedControl, Stack, Text, Textarea } from '@mantine/core';
import { useDisclosure } from '@mantine/hooks';
import { modals } from '@mantine/modals';
import { notifications } from '@mantine/notifications';
import { IconDeviceFloppy, IconMessage, IconPlayerPlay, IconPlayerStop, IconRefresh } from '@tabler/icons-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { post } from '../api/http';
import { useLive } from '../api/live';
import { useSession } from '../api/session';
import { useErrorText } from '../lib/format';

export function ServerControls() {
  const { t } = useTranslation();
  const errorText = useErrorText();
  const { can } = useSession();
  const live = useLive();
  const [countdown, setCountdown] = useState('300');
  const [msgOpen, msg] = useDisclosure();
  const [message, setMessage] = useState('');
  const state = live.status?.state;
  const busy = !!live.op && !live.op.done;
  const playersOnline = (live.players?.count ?? 0) > 0 && state === 'running';
  const up = state === 'running' || state === 'starting';
  const down = !state || state === 'stopped' || state === 'failed' || state === 'crashed';

  if (!can('server.control') && !can('server.broadcast')) return null;

  const run = (path: string, body: unknown = {}) =>
    post(path, body).catch((e: unknown) => notifications.show({ color: 'red', message: errorText(e) }));

  const confirm = (text: string, onConfirm: () => void) =>
    modals.openConfirmModal({
      title: t('common.confirm'),
      children: <Text size="sm">{text}</Text>,
      labels: { confirm: t('common.confirm'), cancel: t('common.cancel') },
      onConfirm,
    });

  const cd = playersOnline ? Number(countdown) : 0;

  return (
    <Card withBorder>
      <Stack gap="sm">
        {can('server.control') && (
          <Group gap="xs">
            <Button leftSection={<IconPlayerPlay size={16} />} color="green" disabled={!down || busy || !live.agentConnected} onClick={() => void run('/api/server/start')}>
              {t('controls.start')}
            </Button>
            <Button leftSection={<IconRefresh size={16} />} disabled={!up || busy} onClick={() => confirm(t('controls.restartConfirm'), () => void run('/api/server/restart', { countdownSec: cd }))}>
              {t('controls.restart')}
            </Button>
            <Button leftSection={<IconPlayerStop size={16} />} color="red" variant="light" disabled={!up || busy} onClick={() => confirm(t('controls.stopConfirm'), () => void run('/api/server/stop', { countdownSec: cd }))}>
              {t('controls.stop')}
            </Button>
            <Button
              leftSection={<IconDeviceFloppy size={16} />}
              variant="default"
              disabled={state !== 'running'}
              onClick={() => void post('/api/server/save').then(() => notifications.show({ color: 'green', message: t('controls.saved') }), (e: unknown) => notifications.show({ color: 'red', message: errorText(e) }))}
            >
              {t('controls.save')}
            </Button>
            {can('server.broadcast') && (
              <Button leftSection={<IconMessage size={16} />} variant="default" disabled={state !== 'running'} onClick={msg.open}>
                {t('controls.broadcast')}
              </Button>
            )}
          </Group>
        )}
        {can('server.control') && playersOnline && (
          <Group gap="xs" align="center">
            <Text size="sm" c="dimmed">
              {t('controls.when')}:
            </Text>
            <SegmentedControl
              size="xs"
              value={countdown}
              onChange={setCountdown}
              data={[
                { value: '0', label: t('controls.now') },
                { value: '60', label: t('controls.in1') },
                { value: '300', label: t('controls.in5') },
                { value: '900', label: t('controls.in15') },
              ]}
            />
            <Text size="xs" c="dimmed">
              {t('controls.countdownHint')}
            </Text>
          </Group>
        )}
      </Stack>

      <Modal opened={msgOpen} onClose={msg.close} title={t('controls.broadcast')} centered>
        <Stack>
          <Textarea value={message} onChange={(e) => setMessage(e.currentTarget.value.replace(/[\r\n"]/g, ''))} placeholder={t('controls.broadcastPlaceholder')} maxLength={300} autosize minRows={2} data-autofocus />
          <Button
            disabled={!message.trim()}
            onClick={() =>
              void post('/api/server/broadcast', { message: message.trim() }).then(
                () => {
                  notifications.show({ color: 'green', message: t('controls.sent') });
                  setMessage('');
                  msg.close();
                },
                (e: unknown) => notifications.show({ color: 'red', message: errorText(e) }),
              )
            }
          >
            {t('controls.send')}
          </Button>
        </Stack>
      </Modal>
    </Card>
  );
}
