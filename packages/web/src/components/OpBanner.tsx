import { Alert, Button, Group, Loader, Progress, Text } from '@mantine/core';
import { IconCheck, IconX } from '@tabler/icons-react';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { post } from '../api/http';
import { useLive } from '../api/live';
import { useSession } from '../api/session';
import { useDuration, useErrorText } from '../lib/format';

/** Shows the running operation (with a live countdown), or the outcome of the last one for a few seconds. */
export function OpBanner() {
  const { t } = useTranslation();
  const dur = useDuration();
  const errorText = useErrorText();
  const { op, job } = useLive();
  const { can } = useSession();
  const [now, setNow] = useState(Date.now());
  const [cancelError, setCancelError] = useState<string | null>(null);

  useEffect(() => {
    const i = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(i);
  }, []);

  if (!op) return null;
  const finishedAgo = op.done ? now - new Date(op.startedAt).getTime() : 0;
  // Keep failures visible; hide successes after a moment.
  if (op.done && op.ok && finishedAgo > 20_000) return null;

  const title = t(`ops.kind.${op.kind}`, { defaultValue: op.kind });
  const left = op.countdownEndsAt ? Math.max(0, new Date(op.countdownEndsAt).getTime() - now) : 0;
  const step = t(`ops.step.${op.step}`, { defaultValue: op.step, time: dur(left) });
  const color = op.done ? (op.ok ? 'green' : op.step === 'cancelled' ? 'gray' : 'red') : 'blue';
  const showJob = !op.done && job && !job.result && (op.step === 'updating' || op.step === 'validating' || op.step === 'starting');

  return (
    <Alert
      color={color}
      variant="light"
      icon={op.done ? op.ok ? <IconCheck size={18} /> : <IconX size={18} /> : <Loader size={16} />}
      title={
        <Group gap="xs">
          <span>{title}</span>
          {op.startedBy && (
            <Text span size="xs" c="dimmed">
              {t('ops.by', { user: op.startedBy })}
            </Text>
          )}
        </Group>
      }
    >
      <Group justify="space-between" wrap="nowrap" align="center">
        <Text size="sm">
          {step}
          {op.error ? ` — ${op.error}` : ''}
          {cancelError ? ` — ${cancelError}` : ''}
        </Text>
        {op.cancellable && !op.done && can('server.control') && (
          <Button size="xs" variant="default" onClick={() => void post(`/api/ops/${op.id}/cancel`).catch((e: unknown) => setCancelError(errorText(e)))}>
            {t('ops.cancel')}
          </Button>
        )}
      </Group>
      {showJob && (
        <>
          <Text size="xs" c="dimmed" mt={6}>
            {job.message}
          </Text>
          <Progress mt={4} value={job.progress ?? 100} animated striped={job.progress === null} />
        </>
      )}
    </Alert>
  );
}
