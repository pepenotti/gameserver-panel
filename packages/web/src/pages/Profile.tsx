import { Alert, Badge, Button, Card, Group, Modal, PasswordInput, Stack, Table, Text, Title } from '@mantine/core';
import { useDisclosure } from '@mantine/hooks';
import { notifications } from '@mantine/notifications';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { requiresTotp } from '@gsp/shared';
import { api } from '../api/http';
import { useServers } from '../api/server';
import { useSession } from '../api/session';
import type { DeviceSession } from '../api/types';
import { LangSwitch } from '../components/LangSwitch';
import { useErrorText, useRelative } from '../lib/format';
import { ChangePasswordForm } from './auth/ChangePassword';
import { EnrolTotp } from './auth/EnrolTotp';

export function Profile() {
  const { t } = useTranslation();
  const errorText = useErrorText();
  const rel = useRelative();
  const qc = useQueryClient();
  const { session, refresh } = useSession();
  const servers = useServers();
  const [enrolOpen, enrol] = useDisclosure();
  const [disableOpen, disable] = useDisclosure();
  const [pw, setPw] = useState('');
  const [disableError, setDisableError] = useState<string | null>(null);
  const devices = useQuery({ queryKey: ['me', 'sessions'], queryFn: () => api<DeviceSession[]>('GET', '/api/me/sessions') });
  const revoke = useMutation({
    mutationFn: (id: string) => api('DELETE', `/api/me/sessions/${id}`),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['me', 'sessions'] }),
  });
  if (!session) return null;
  const user = session.user;

  return (
    <Stack maw={720}>
      <Title order={2}>{t('profile.title')}</Title>

      <Card withBorder>
        <Group justify="space-between">
          <Stack gap={2}>
            <Text fw={600}>{user.username}</Text>
            <Text size="sm" c="dimmed">
              {user.scope === 'all' ? `${t(`roles.${user.role}`)} — ${t(`roles.${user.role}Help`)}` : t('profile.perServer')}
            </Text>
          </Stack>
        </Group>
        {(servers.data?.length ?? 0) > 0 && (
          <Stack gap={4} mt="sm">
            <Text size="xs" c="dimmed" tt="uppercase" fw={600}>
              {t('profile.myServers')}
            </Text>
            {servers.data!.map((s) => (
              <Group key={s.id} justify="space-between" wrap="nowrap">
                <Text size="sm" truncate>
                  {s.name}
                </Text>
                <Badge variant="light" tt="none">
                  {t(`roles.${s.role}`)}
                </Badge>
              </Group>
            ))}
          </Stack>
        )}
      </Card>

      <Card withBorder>
        <Text fw={600} mb={4}>
          {t('common.language')}
        </Text>
        <Text size="sm" c="dimmed" mb="sm">
          {t('profile.languageHelp')}
        </Text>
        <LangSwitch size="sm" />
      </Card>

      <Card withBorder>
        <Text fw={600} mb="sm">
          {t('auth.changePassword')}
        </Text>
        <ChangePasswordForm onDone={() => notifications.show({ color: 'green', message: t('auth.passwordChanged') })} />
      </Card>

      <Card withBorder>
        <Group justify="space-between">
          <Group gap="xs">
            <Text fw={600}>{t('profile.twoFactor')}</Text>
            <Badge color={user.totpEnabled ? 'green' : 'gray'}>{user.totpEnabled ? t('profile.twoFactorOn') : t('profile.twoFactorOff')}</Badge>
          </Group>
          {!user.totpEnabled && <Button onClick={enrol.open}>{t('profile.enable2fa')}</Button>}
          {user.totpEnabled && !requiresTotp(user.role) && (
            <Button variant="default" color="red" onClick={disable.open}>
              {t('profile.disable2fa')}
            </Button>
          )}
        </Group>
      </Card>

      <Card withBorder>
        <Text fw={600} mb="sm">
          {t('profile.sessions')}
        </Text>
        <Table.ScrollContainer minWidth={420}>
          <Table verticalSpacing="xs">
            <Table.Tbody>
              {devices.data?.map((d) => (
                <Table.Tr key={d.id}>
                  <Table.Td>
                    <Text size="sm" lineClamp={1} title={d.userAgent ?? ''}>
                      {d.userAgent ?? '—'}
                    </Text>
                    <Text size="xs" c="dimmed">
                      {d.ip ?? ''} · {t('profile.lastSeen', { when: rel(d.lastSeenAt) })}
                    </Text>
                  </Table.Td>
                  <Table.Td w={140} ta="right">
                    {d.current ? (
                      <Badge variant="light">{t('profile.thisDevice')}</Badge>
                    ) : (
                      <Button size="xs" variant="subtle" color="red" onClick={() => revoke.mutate(d.id)}>
                        {t('profile.signOutDevice')}
                      </Button>
                    )}
                  </Table.Td>
                </Table.Tr>
              ))}
            </Table.Tbody>
          </Table>
        </Table.ScrollContainer>
      </Card>

      <Modal opened={enrolOpen} onClose={enrol.close} title={t('auth.enrolTitle')} centered>
        {enrolOpen && (
          <EnrolTotp
            onDone={() => {
              enrol.close();
              void refresh();
            }}
          />
        )}
      </Modal>

      <Modal opened={disableOpen} onClose={disable.close} title={t('profile.disable2fa')} centered>
        <Stack>
          <Text size="sm">{t('profile.disable2faConfirm')}</Text>
          {disableError && <Alert color="red">{disableError}</Alert>}
          <PasswordInput value={pw} onChange={(e) => setPw(e.currentTarget.value)} label={t('auth.password')} autoComplete="current-password" />
          <Button
            color="red"
            onClick={() =>
              void api('POST', '/api/auth/totp/disable', { password: pw }).then(
                () => {
                  setPw('');
                  disable.close();
                  void refresh();
                },
                (e: unknown) => setDisableError(errorText(e)),
              )
            }
          >
            {t('profile.disable2fa')}
          </Button>
        </Stack>
      </Modal>
    </Stack>
  );
}
