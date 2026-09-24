import { Alert, Button, Center, Code, CopyButton, Group, List, Loader, PinInput, SimpleGrid, Stack, Text } from '@mantine/core';
import QRCode from 'qrcode';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { post } from '../../api/http';
import { useSession } from '../../api/session';
import type { SessionInfo } from '../../api/types';
import { useErrorText } from '../../lib/format';

/** Authenticator enrolment: QR + manual key, confirm with a code, then show recovery codes once. */
export function EnrolTotp({ onDone }: { onDone?: () => void }) {
  const { t } = useTranslation();
  const errorText = useErrorText();
  const { apply } = useSession();
  const [setup, setSetup] = useState<{ secret: string; uri: string; qr: string } | null>(null);
  const [codes, setCodes] = useState<string[] | null>(null);
  const [pendingSession, setPendingSession] = useState<SessionInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    post<{ secret: string; uri: string }>('/api/auth/totp/setup')
      .then(async (s) => {
        const qr = await QRCode.toDataURL(s.uri, { margin: 1, width: 220, errorCorrectionLevel: 'M' });
        if (!cancelled) setSetup({ ...s, qr });
      })
      .catch((e: unknown) => !cancelled && setError(errorText(e)));
    return () => {
      cancelled = true;
    };
  }, []);

  const confirm = async (code: string) => {
    setBusy(true);
    setError(null);
    try {
      const r = await post<SessionInfo & { recoveryCodes: string[] }>('/api/auth/totp/enable', { code });
      setCodes(r.recoveryCodes);
      setPendingSession(r);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  if (codes) {
    return (
      <Stack>
        <Text fw={600}>{t('auth.recoveryTitle')}</Text>
        <Text size="sm" c="dimmed">
          {t('auth.recoveryHelp')}
        </Text>
        <SimpleGrid cols={2} spacing="xs">
          {codes.map((c) => (
            <Code key={c} fz="md" ta="center">
              {c}
            </Code>
          ))}
        </SimpleGrid>
        <Group justify="space-between">
          <CopyButton value={codes.join('\n')}>
            {({ copied, copy }) => (
              <Button variant="default" onClick={copy}>
                {copied ? t('common.copied') : t('common.copy')}
              </Button>
            )}
          </CopyButton>
          <Button
            onClick={() => {
              if (pendingSession) apply(pendingSession);
              onDone?.();
            }}
          >
            {t('auth.recoverySaved')}
          </Button>
        </Group>
      </Stack>
    );
  }

  return (
    <Stack>
      <Text size="sm">{t('auth.enrolIntro')}</Text>
      {error && (
        <Alert color="red" variant="light">
          {error}
        </Alert>
      )}
      <List type="ordered" size="sm" spacing="xs">
        <List.Item>{t('auth.enrolStep1')}</List.Item>
        <List.Item>{t('auth.enrolStep2')}</List.Item>
      </List>
      {setup ? (
        <Stack align="center" gap="xs">
          <img src={setup.qr} alt="QR" width={220} height={220} style={{ borderRadius: 8, background: '#fff' }} />
          <Group gap="xs" wrap="nowrap">
            <Text size="xs" c="dimmed">
              {t('auth.manualKey')}:
            </Text>
            <CopyButton value={setup.secret}>
              {({ copied, copy }) => (
                <Code style={{ cursor: 'pointer', wordBreak: 'break-all' }} onClick={copy}>
                  {copied ? t('common.copied') : setup.secret.replace(/(.{4})/g, '$1 ').trim()}
                </Code>
              )}
            </CopyButton>
          </Group>
        </Stack>
      ) : (
        !error && (
          <Center>
            <Loader />
          </Center>
        )
      )}
      <Text size="sm">3. {t('auth.enrolStep3')}</Text>
      <Center>
        <PinInput length={6} type="number" oneTimeCode disabled={!setup || busy} onComplete={(v) => void confirm(v)} aria-label={t('auth.code')} />
      </Center>
    </Stack>
  );
}
