import { ActionIcon, Alert, Badge, Button, Code, CopyButton, Group, Menu, Modal, Select, Stack, Table, Text, TextInput, Title } from '@mantine/core';
import { useDisclosure } from '@mantine/hooks';
import { modals } from '@mantine/modals';
import { IconDots, IconUserPlus } from '@tabler/icons-react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { Role } from '@pz/shared';
import { del, get, patch, post } from '../api/http';
import { useSession } from '../api/session';
import type { PublicUser } from '../api/types';
import { useErrorText, useRelative } from '../lib/format';

const ASSIGNABLE: Role[] = ['viewer', 'operator', 'admin'];

/** A readable temporary password, e.g. "maple-ridge-4821-tundra". */
function tempPassword(): string {
  const words = ['maple', 'ridge', 'tundra', 'ember', 'harbor', 'canyon', 'cedar', 'falcon', 'meadow', 'quartz', 'river', 'summit', 'willow', 'copper', 'frost', 'lantern'];
  const r = crypto.getRandomValues(new Uint32Array(4));
  return `${words[r[0]! % words.length]}-${words[r[1]! % words.length]}-${1000 + (r[2]! % 9000)}-${words[r[3]! % words.length]}`;
}

export function Users() {
  const { t } = useTranslation();
  const errorText = useErrorText();
  const rel = useRelative();
  const qc = useQueryClient();
  const { session } = useSession();
  const users = useQuery({ queryKey: ['users'], queryFn: () => get<PublicUser[]>('/api/users') });
  const [addOpen, add] = useDisclosure();
  const [form, setForm] = useState({ username: '', role: 'operator' as Role, password: tempPassword() });
  const [shown, setShown] = useState<{ username: string; password: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const invalidate = () => void qc.invalidateQueries({ queryKey: ['users'] });
  const act = useMutation({
    mutationFn: (fn: () => Promise<unknown>) => fn(),
    onSuccess: invalidate,
    onError: (e) => setError(errorText(e)),
  });

  const create = async () => {
    setError(null);
    try {
      await post('/api/users', { username: form.username.trim(), password: form.password, role: form.role });
      setShown({ username: form.username.trim(), password: form.password });
      setForm({ username: '', role: 'operator', password: tempPassword() });
      invalidate();
    } catch (e) {
      setError(errorText(e));
    }
  };

  return (
    <Stack>
      <Group justify="space-between">
        <Title order={2}>{t('users.title')}</Title>
        <Button
          leftSection={<IconUserPlus size={16} />}
          onClick={() => {
            setShown(null);
            setError(null);
            add.open();
          }}
        >
          {t('users.add')}
        </Button>
      </Group>
      {error && !addOpen && (
        <Alert color="red" withCloseButton onClose={() => setError(null)}>
          {error}
        </Alert>
      )}

      <Table.ScrollContainer minWidth={560}>
        <Table striped highlightOnHover>
          <Table.Thead>
            <Table.Tr>
              <Table.Th>{t('auth.username')}</Table.Th>
              <Table.Th>{t('users.role')}</Table.Th>
              <Table.Th>{t('users.twoFactor')}</Table.Th>
              <Table.Th>{t('users.lastLogin')}</Table.Th>
              <Table.Th w={50} />
            </Table.Tr>
          </Table.Thead>
          <Table.Tbody>
            {users.data?.map((u) => {
              const self = u.id === session?.user.id;
              return (
                <Table.Tr key={u.id} opacity={u.disabled ? 0.5 : 1}>
                  <Table.Td>
                    <Group gap={6}>
                      <Text size="sm" fw={500}>
                        {u.username}
                      </Text>
                      {self && <Badge size="xs" variant="outline">{t('users.you')}</Badge>}
                      {u.disabled && <Badge size="xs" color="gray">{t('users.disabled')}</Badge>}
                    </Group>
                  </Table.Td>
                  <Table.Td>
                    {u.role === 'owner' ? (
                      <Badge>{t('roles.owner')}</Badge>
                    ) : (
                      <Select
                        size="xs"
                        w={150}
                        data={ASSIGNABLE.map((r) => ({ value: r, label: t(`roles.${r}`) }))}
                        value={u.role}
                        allowDeselect={false}
                        onChange={(v) => v && act.mutate(() => patch(`/api/users/${u.id}`, { role: v }))}
                        aria-label={t('users.role')}
                      />
                    )}
                  </Table.Td>
                  <Table.Td>
                    <Badge color={u.totpEnabled ? 'green' : 'gray'} variant="light">
                      {u.totpEnabled ? t('profile.twoFactorOn') : t('profile.twoFactorOff')}
                    </Badge>
                  </Table.Td>
                  <Table.Td>
                    <Text size="sm">{rel(u.lastLoginAt)}</Text>
                  </Table.Td>
                  <Table.Td>
                    {!self && u.role !== 'owner' && (
                      <Menu position="bottom-end" withinPortal>
                        <Menu.Target>
                          <ActionIcon variant="subtle" aria-label={t('common.edit')}>
                            <IconDots size={16} />
                          </ActionIcon>
                        </Menu.Target>
                        <Menu.Dropdown>
                          <Menu.Item onClick={() => act.mutate(() => patch(`/api/users/${u.id}`, { disabled: !u.disabled }))}>{u.disabled ? t('users.enable') : t('users.disable')}</Menu.Item>
                          <Menu.Item
                            onClick={() => {
                              const password = tempPassword();
                              act.mutate(async () => {
                                await post(`/api/users/${u.id}/reset-password`, { password });
                                setShown({ username: u.username, password });
                                add.open();
                              });
                            }}
                          >
                            {t('users.resetPassword')}
                          </Menu.Item>
                          {u.totpEnabled && (
                            <Menu.Item
                              onClick={() =>
                                modals.openConfirmModal({
                                  title: t('users.reset2fa'),
                                  children: <Text size="sm">{t('users.reset2faConfirm', { name: u.username })}</Text>,
                                  labels: { confirm: t('common.confirm'), cancel: t('common.cancel') },
                                  onConfirm: () => act.mutate(() => post(`/api/users/${u.id}/reset-2fa`)),
                                })
                              }
                            >
                              {t('users.reset2fa')}
                            </Menu.Item>
                          )}
                          <Menu.Divider />
                          <Menu.Item
                            color="red"
                            onClick={() =>
                              modals.openConfirmModal({
                                title: t('common.delete'),
                                children: <Text size="sm">{t('users.deleteConfirm', { name: u.username })}</Text>,
                                labels: { confirm: t('common.delete'), cancel: t('common.cancel') },
                                confirmProps: { color: 'red' },
                                onConfirm: () => act.mutate(() => del(`/api/users/${u.id}`)),
                              })
                            }
                          >
                            {t('common.delete')}
                          </Menu.Item>
                        </Menu.Dropdown>
                      </Menu>
                    )}
                  </Table.Td>
                </Table.Tr>
              );
            })}
          </Table.Tbody>
        </Table>
      </Table.ScrollContainer>

      <Modal opened={addOpen} onClose={add.close} title={t('users.add')} centered>
        {shown ? (
          <Stack>
            <Alert color="green">{t('users.created')}</Alert>
            <Text size="sm">
              {t('auth.username')}: <Code>{shown.username}</Code>
            </Text>
            <Group gap="xs">
              <Text size="sm">{t('users.tempPassword')}:</Text>
              <Code>{shown.password}</Code>
              <CopyButton value={shown.password}>
                {({ copied, copy }) => (
                  <Button size="compact-xs" variant="default" onClick={copy}>
                    {copied ? t('common.copied') : t('common.copy')}
                  </Button>
                )}
              </CopyButton>
            </Group>
            <Button onClick={add.close}>{t('common.close')}</Button>
          </Stack>
        ) : (
          <Stack>
            {error && <Alert color="red">{error}</Alert>}
            <TextInput label={t('auth.username')} value={form.username} onChange={(e) => setForm({ ...form, username: e.currentTarget.value })} maxLength={32} data-autofocus />
            <Select
              label={t('users.role')}
              data={ASSIGNABLE.map((r) => ({ value: r, label: t(`roles.${r}`) }))}
              value={form.role}
              allowDeselect={false}
              onChange={(v) => v && setForm({ ...form, role: v as Role })}
              description={t(`roles.${form.role}Help`)}
            />
            <TextInput
              label={t('users.tempPassword')}
              description={t('users.tempPasswordHelp')}
              value={form.password}
              onChange={(e) => setForm({ ...form, password: e.currentTarget.value })}
              rightSectionWidth={90}
              rightSection={
                <Button size="compact-xs" variant="subtle" onClick={() => setForm({ ...form, password: tempPassword() })}>
                  {t('users.generate')}
                </Button>
              }
            />
            <Button onClick={() => void create()} disabled={!form.username.trim()}>
              {t('common.create')}
            </Button>
          </Stack>
        )}
      </Modal>
    </Stack>
  );
}
