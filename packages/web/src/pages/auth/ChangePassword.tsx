import { Alert, Button, PasswordInput, Stack, Text } from '@mantine/core';
import { useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { post } from '../../api/http';
import { useSession } from '../../api/session';
import type { SessionInfo } from '../../api/types';
import { useErrorText } from '../../lib/format';

/** Password change form, used both for the forced first-login step and in My account. */
export function ChangePasswordForm({ onDone }: { onDone?: () => void }) {
  const { t } = useTranslation();
  const errorText = useErrorText();
  const { apply } = useSession();
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [repeat, setRepeat] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (next !== repeat) {
      setError(t('auth.mismatch'));
      return;
    }
    setBusy(true);
    setError(null);
    try {
      apply(await post<SessionInfo>('/api/auth/password', { current, next }));
      setCurrent('');
      setNext('');
      setRepeat('');
      onDone?.();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={(e) => void submit(e)}>
      <Stack>
        {error && (
          <Alert color="red" variant="light">
            {error}
          </Alert>
        )}
        <PasswordInput label={t('auth.currentPassword')} value={current} onChange={(e) => setCurrent(e.currentTarget.value)} autoComplete="current-password" required />
        <PasswordInput label={t('auth.newPassword')} value={next} onChange={(e) => setNext(e.currentTarget.value)} autoComplete="new-password" required minLength={10} maxLength={200} />
        <PasswordInput
          label={t('auth.repeatPassword')}
          value={repeat}
          onChange={(e) => setRepeat(e.currentTarget.value)}
          autoComplete="new-password"
          required
          error={repeat && next !== repeat ? t('auth.mismatch') : undefined}
        />
        <Text size="xs" c="dimmed">
          {t('auth.passwordRules')}
        </Text>
        <Button type="submit" loading={busy}>
          {t('auth.changePassword')}
        </Button>
      </Stack>
    </form>
  );
}
