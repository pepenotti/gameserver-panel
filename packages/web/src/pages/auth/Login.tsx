import { Alert, Anchor, Button, PasswordInput, Stack, Text, TextInput } from '@mantine/core';
import { useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { post } from '../../api/http';
import { useSession } from '../../api/session';
import type { SessionInfo } from '../../api/types';
import { useErrorText } from '../../lib/format';
import { AuthFrame } from './AuthFrame';

/** Password step, then (when the session says so) the 2FA step. */
export function Login() {
  const { t } = useTranslation();
  const errorText = useErrorText();
  const { session, apply, logout } = useSession();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const mfa = session?.pending === 'mfa';

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      apply(mfa ? await post<SessionInfo>('/api/auth/mfa', { code: code.trim() }) : await post<SessionInfo>('/api/auth/login', { username: username.trim(), password }));
      setPassword('');
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <AuthFrame title={mfa ? t('auth.mfaTitle') : t('auth.signInTitle')}>
      <form onSubmit={(e) => void submit(e)}>
        <Stack>
          {error && (
            <Alert color="red" variant="light">
              {error}
            </Alert>
          )}
          {mfa ? (
            <>
              <Text size="sm" c="dimmed">
                {t('auth.mfaHelp')}
              </Text>
              <TextInput
                label={t('auth.code')}
                value={code}
                onChange={(e) => setCode(e.currentTarget.value)}
                autoComplete="one-time-code"
                inputMode="text"
                autoFocus
                required
                maxLength={20}
              />
              <Button type="submit" loading={busy}>
                {t('auth.verify')}
              </Button>
              <Anchor size="sm" component="button" type="button" onClick={() => void logout()}>
                {t('auth.backToLogin')}
              </Anchor>
            </>
          ) : (
            <>
              <TextInput label={t('auth.username')} value={username} onChange={(e) => setUsername(e.currentTarget.value)} autoComplete="username" autoFocus required maxLength={64} />
              <PasswordInput label={t('auth.password')} value={password} onChange={(e) => setPassword(e.currentTarget.value)} autoComplete="current-password" required maxLength={200} />
              <Button type="submit" loading={busy}>
                {t('auth.signIn')}
              </Button>
            </>
          )}
        </Stack>
      </form>
    </AuthFrame>
  );
}
