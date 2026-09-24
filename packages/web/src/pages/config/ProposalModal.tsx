import { Alert, Badge, Button, Group, List, Modal, Stack, Text } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { IconInfoCircle } from '@tabler/icons-react';
import { useQueryClient } from '@tanstack/react-query';
import { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useErrorText } from '../../lib/format';
import { applyProposal, rejectProposal, useFileLabel, type ApplyOutcome, type ApplyResult, type ProposalPreview } from './api';
import { DiffView } from './DiffView';

/** Tells what an applied change did: live or at the next start, restart needed, values the game rejected. */
export function useApplyNotice(): (r: ApplyResult) => void {
  const { t } = useTranslation();
  return (r) =>
    notifications.show({
      color: r.warnings.length ? 'orange' : 'green',
      message: [
        r.applied === 'live' ? t('config.appliedLive') : r.applied === 'next-start' ? t('config.appliedNext') : t('config.unchanged'),
        r.restartNeeded ? t('config.restartNeeded') : '',
        r.warnings.length ? t('config.rejected', { list: r.warnings.join('; ') }) : '',
      ]
        .filter(Boolean)
        .join(' '),
      autoClose: r.warnings.length ? false : 6000,
    });
}

interface Props {
  /** Null keeps the modal closed. */
  preview: ProposalPreview | null;
  /**
   * `own`: a change this person just made; closing it discards the proposal.
   * `review`: a pending proposal (someone else's, or submitted through the API); closing keeps it pending.
   */
  mode?: 'own' | 'review';
  title?: string;
  onClose(): void;
  onApplied(r: ApplyOutcome): void;
}

/** The preview every change goes through (AST-03): the diff, what the panel keeps, when it applies; then apply or discard. */
export function ProposalModal({ preview, mode = 'own', title, onClose, onApplied }: Props) {
  const { t } = useTranslation();
  const errorText = useErrorText();
  const fileLabel = useFileLabel();
  const notice = useApplyNotice();
  const qc = useQueryClient();
  const [busy, setBusy] = useState<'apply' | 'reject' | null>(null);
  const [error, setError] = useState<string | null>(null);

  const close = () => {
    setError(null);
    onClose();
  };
  const reject = async () => {
    if (preview?.id) {
      setBusy('reject');
      try {
        await rejectProposal(preview.id);
      } catch {
        // Already decided elsewhere: nothing left to discard.
      }
      setBusy(null);
      void qc.invalidateQueries({ queryKey: ['config', 'proposals'] });
    }
    close();
  };
  const apply = async () => {
    if (!preview?.id) return;
    setBusy('apply');
    setError(null);
    try {
      const r = await applyProposal(preview.id);
      notice(r);
      await qc.invalidateQueries({ queryKey: ['config'] });
      onApplied(r);
    } catch (e) {
      setError(errorText(e));
      void qc.invalidateQueries({ queryKey: ['config', 'proposals'] });
    } finally {
      setBusy(null);
    }
  };

  // The last preview stays on screen while the modal fades out.
  const last = useRef(preview);
  if (preview) last.current = preview;
  const p = preview ?? last.current;
  return (
    <Modal opened={preview !== null} onClose={() => void (mode === 'own' ? reject() : close())} size="xl" title={title ?? (p ? t('config.preview.title', { file: fileLabel(p.fileId) }) : '')}>
      {p && (
        <Stack>
          {p.id === null ? (
            <Alert color="blue" icon={<IconInfoCircle />}>
              {t('config.preview.nothing')}
            </Alert>
          ) : (
            <Group gap="xs">
              <Badge color={p.applies === 'live' ? 'green' : 'orange'} variant="light">
                {t(`config.preview.applies.${p.applies}`)}
              </Badge>
              {p.changedKeys.slice(0, 12).map((k) => (
                <Badge key={k} variant="outline" color="gray" tt="none">
                  {k}
                </Badge>
              ))}
              {p.changedKeys.length > 12 && <Text size="xs">{t('config.preview.more', { count: p.changedKeys.length - 12 })}</Text>}
            </Group>
          )}
          {p.reapplied.length > 0 && (
            <Alert color="blue" variant="light" title={t('config.preview.reappliedTitle')}>
              <Text size="sm">{t('config.preview.reappliedHelp')}</Text>
              <List size="sm" mt={4}>
                {p.reapplied.map((r) => (
                  <List.Item key={r.key}>
                    <b>{r.key}</b>: {r.value === null ? t('config.preview.removed') : t(`config.preview.why.${r.why}`, { value: r.value })}
                  </List.Item>
                ))}
              </List>
            </Alert>
          )}
          {p.issues.length > 0 && (
            <Alert color="yellow" variant="light" title={t('config.preview.warningsTitle')}>
              <List size="sm">
                {p.issues.map((i, n) => (
                  <List.Item key={n}>
                    {t('files.line', { line: i.line })}: {i.message}
                  </List.Item>
                ))}
              </List>
            </Alert>
          )}
          {p.id !== null && <DiffView lines={p.diff} />}
          {error && (
            <Alert color="red" variant="light">
              {error}
            </Alert>
          )}
          <Group justify="flex-end">
            {mode === 'review' ? (
              <>
                <Button variant="default" onClick={close} disabled={busy !== null}>
                  {t('common.close')}
                </Button>
                <Button color="red" variant="light" onClick={() => void reject()} loading={busy === 'reject'} disabled={busy === 'apply'}>
                  {t('config.preview.reject')}
                </Button>
              </>
            ) : (
              <Button variant="default" onClick={() => void reject()} loading={busy === 'reject'} disabled={busy === 'apply'}>
                {p.id === null ? t('common.close') : t('config.preview.discard')}
              </Button>
            )}
            {p.id !== null && (
              <Button onClick={() => void apply()} loading={busy === 'apply'} disabled={busy === 'reject'}>
                {t('config.preview.apply')}
              </Button>
            )}
          </Group>
        </Stack>
      )}
    </Modal>
  );
}
