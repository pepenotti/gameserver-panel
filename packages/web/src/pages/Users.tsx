import { ActionIcon, Alert, Badge, Button, Code, CopyButton, Group, Menu, Modal, Radio, Select, Stack, Table, Text, TextInput, Title } from '@mantine/core';
import { useDisclosure } from '@mantine/hooks';
import { modals } from '@mantine/modals';
import { IconDots, IconServer2, IconUserPlus } from '@tabler/icons-react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { GRANT_ROLES, requiresTotp, roleRank, type GrantRole, type Role, type Scope } from '@gsp/shared';
import { api } from '../api/http';
import { localize } from '../api/meta';
import { useServers } from '../api/server';
import { useSession } from '../api/session';
import type { GrantsView, UserWithGrants } from '../api/types';
import { useErrorText, useRelative } from '../lib/format';

const ASSIGNABLE: Role[] = ['viewer', 'operator', 'admin'];
const USERS = ['users'];

/** A readable temporary password, e.g. "maple-ridge-4821-tundra". */
function tempPassword(): string {
  const words = ['maple', 'ridge', 'tundra', 'ember', 'harbor', 'canyon', 'cedar', 'falcon', 'meadow', 'quartz', 'river', 'summit', 'willow', 'copper', 'frost', 'lantern'];
  const r = crypto.getRandomValues(new Uint32Array(4));
  return `${words[r[0]! % words.length]}-${words[r[1]! % words.length]}-${1000 + (r[2]! % 9000)}-${words[r[3]! % words.length]}`;
}

/** The role an account acts with on a server: the higher of its account role (scope `all`) and its grant there. */
function roleOnServer(u: UserWithGrants, sid: string): Role | null {
  const grant = u.grants.find((g) => g.serverId === sid)?.role ?? null;
  const fromScope = u.scope === 'all' ? u.role : null;
  if (grant === null) return fromScope;
  if (fromScope === null) return grant;
  return roleRank(grant) > roleRank(fromScope) ? grant : fromScope;
}

/**
 * Per-server roles (ACC-02): one select per server. With scope `all` the
 * account role already applies everywhere, so a grant only counts where it
 * is higher; with scope `granted` the grants are all the account has.
 */
function GrantsModal({ user, opened, onClose }: { user: UserWithGrants | null; opened: boolean; onClose: () => void }) {
  const { t, i18n } = useTranslation();
  const errorText = useErrorText();
  const qc = useQueryClient();
  const servers = useServers();
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState<string | null>(null);
  if (!user) return null;
  const set = async (sid: string, role: GrantRole | null) => {
    setSaving(sid);
    setError(null);
    try {
      const view = role ? await api<GrantsView>('PUT', `/api/users/${user.id}/grants/${encodeURIComponent(sid)}`, { role }) : await api<GrantsView>('DELETE', `/api/users/${user.id}/grants/${encodeURIComponent(sid)}`);
      qc.setQueryData<UserWithGrants[]>(USERS, (list) => list?.map((u) => (u.id === user.id ? { ...u, role: view.role, scope: view.scope, grants: view.grants } : u)));
    } catch (e) {
      setError(errorText(e));
    } finally {
      setSaving(null);
    }
  };
  const none = user.scope === 'all' ? t('users.grantNoneAll') : t('users.grantNone');
  const needs2fa = !user.totpEnabled && user.grants.some((g) => requiresTotp(g.role));
  return (
    <Modal opened={opened} onClose={onClose} title={t('users.grantsTitle', { name: user.username })} size="lg" centered>
      <Stack>
        <Text size="sm">{user.scope === 'all' ? t('users.grantsAllHelp', { name: user.username, role: t(`roles.${user.role}`) }) : t('users.grantsGrantedHelp', { name: user.username })}</Text>
        {needs2fa && (
          <Alert variant="light" color="blue">
            {t('users.grants2fa')}
          </Alert>
        )}
        {error && <Alert color="red">{error}</Alert>}
        {servers.data?.length === 0 && (
          <Text size="sm" c="dimmed">
            {t('users.noServers')}
          </Text>
        )}
        <Stack gap={0}>
          {servers.data?.map((s) => {
            const grant = user.grants.find((g) => g.serverId === s.id)?.role ?? null;
            const effective = roleOnServer(user, s.id);
            return (
              // On a phone the select drops below the server's name.
              <Group key={s.id} justify="space-between" wrap="wrap" gap="xs" py="xs" style={{ borderBottom: '1px solid var(--mantine-color-default-border)' }}>
                <Stack gap={0} style={{ flex: '1 1 180px', minWidth: 0 }}>
                  <Text size="sm" fw={500} truncate>
                    {s.name}
                  </Text>
                  <Text size="xs" c="dimmed">
                    {localize(s.adapterName, i18n.language)} · {effective ? t('users.actsAs', { role: t(`roles.${effective}`) }) : t('users.noAccess')}
                  </Text>
                </Stack>
                <Select
                  size="xs"
                  w={{ base: '100%', xs: 200 }}
                  aria-label={t('users.roleOn', { server: s.name })}
                  data={[{ value: '', label: none }, ...GRANT_ROLES.map((r) => ({ value: r, label: t(`roles.${r}`) }))]}
                  value={grant ?? ''}
                  allowDeselect={false}
                  disabled={saving !== null}
                  onChange={(v) => v !== null && v !== (grant ?? '') && void set(s.id, v === '' ? null : (v as GrantRole))}
                />
              </Group>
            );
          })}
        </Stack>
        <Group justify="flex-end">
          <Button onClick={onClose}>{t('common.close')}</Button>
        </Group>
      </Stack>
    </Modal>
  );
}

/** Where an account's role applies: every server, or the chosen ones (ACC-02). */
function ScopeRadio({ value, onChange }: { value: Scope; onChange: (s: Scope) => void }) {
  const { t } = useTranslation();
  return (
    <Radio.Group label={t('users.scope')} value={value} onChange={(v) => onChange(v as Scope)}>
      <Stack gap="xs" mt={6}>
        <Radio value="all" label={t('users.scopeAll')} description={t('users.scopeAllHelp')} />
        <Radio value="granted" label={t('users.scopeGranted')} description={t('users.scopeGrantedHelp')} />
      </Stack>
    </Radio.Group>
  );
}

export function Users() {
  const { t } = useTranslation();
  const errorText = useErrorText();
  const rel = useRelative();
  const qc = useQueryClient();
  const { session } = useSession();
  const servers = useServers();
  const users = useQuery({ queryKey: USERS, queryFn: () => api<UserWithGrants[]>('GET', '/api/users') });
  const [addOpen, add] = useDisclosure();
  const [grantsFor, setGrantsFor] = useState<number | null>(null);
  const [form, setForm] = useState({ username: '', role: 'operator' as Role, scope: 'all' as Scope, password: tempPassword() });
  const [shown, setShown] = useState<{ id: number | null; username: string; password: string; scope: Scope } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const invalidate = () => void qc.invalidateQueries({ queryKey: USERS });
  const act = useMutation({
    mutationFn: (fn: () => Promise<unknown>) => fn(),
    onSuccess: invalidate,
    onError: (e) => setError(errorText(e)),
  });
  const nameOf = (sid: string) => servers.data?.find((s) => s.id === sid)?.name ?? sid;

  const create = async () => {
    setError(null);
    try {
      // With chosen servers the role follows the grants (viewer until the first one).
      const u = await api<UserWithGrants>('POST', '/api/users', { username: form.username.trim(), password: form.password, role: form.scope === 'granted' ? 'viewer' : form.role, scope: form.scope });
      setShown({ id: u.id, username: u.username, password: form.password, scope: form.scope });
      setForm({ username: '', role: 'operator', scope: 'all', password: tempPassword() });
      invalidate();
    } catch (e) {
      setError(errorText(e));
    }
  };

  const serversCell = (u: UserWithGrants) => {
    if (u.role === 'owner') return <Text size="sm">{t('users.everywhere')}</Text>;
    const higher = u.grants.filter((g) => u.scope === 'granted' || roleRank(g.role) > roleRank(u.role));
    return (
      <Group gap={4}>
        {u.scope === 'all' && (
          <Badge size="sm" variant="light" tt="none">
            {t('users.allServers')}
          </Badge>
        )}
        {higher.slice(0, 3).map((g) => (
          <Badge key={g.serverId} size="sm" variant="outline" color="gray" tt="none">
            {nameOf(g.serverId)}: {t(`roles.${g.role}`)}
          </Badge>
        ))}
        {higher.length > 3 && (
          <Badge size="sm" variant="outline" color="gray">
            +{higher.length - 3}
          </Badge>
        )}
        {u.scope === 'granted' && u.grants.length === 0 && (
          <Text size="xs" c="dimmed">
            {t('users.noServersYet')}
          </Text>
        )}
        <ActionIcon size="sm" variant="subtle" aria-label={t('users.editGrants', { name: u.username })} onClick={() => setGrantsFor(u.id)}>
          <IconServer2 size={14} />
        </ActionIcon>
      </Group>
    );
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
      <Text size="sm" c="dimmed">
        {t('users.intro')}
      </Text>
      {error && !addOpen && (
        <Alert color="red" withCloseButton onClose={() => setError(null)}>
          {error}
        </Alert>
      )}

      <Table.ScrollContainer minWidth={760}>
        <Table striped highlightOnHover>
          <Table.Thead>
            <Table.Tr>
              <Table.Th>{t('auth.username')}</Table.Th>
              <Table.Th>{t('users.scope')}</Table.Th>
              <Table.Th>{t('users.role')}</Table.Th>
              <Table.Th>{t('users.servers')}</Table.Th>
              <Table.Th>{t('users.twoFactor')}</Table.Th>
              <Table.Th>{t('users.lastLogin')}</Table.Th>
              <Table.Th w={50} />
            </Table.Tr>
          </Table.Thead>
          <Table.Tbody>
            {users.data?.map((u) => {
              const self = u.id === session?.user.id;
              const owner = u.role === 'owner';
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
                    {owner ? (
                      <Text size="sm">{t('users.scopeAll')}</Text>
                    ) : (
                      <Select
                        size="xs"
                        w={170}
                        data={[
                          { value: 'all', label: t('users.scopeAll') },
                          { value: 'granted', label: t('users.scopeGranted') },
                        ]}
                        value={u.scope}
                        allowDeselect={false}
                        onChange={(v) => v && v !== u.scope && act.mutate(() => api('PATCH', `/api/users/${u.id}`, { scope: v }))}
                        aria-label={t('users.scope')}
                      />
                    )}
                  </Table.Td>
                  <Table.Td>
                    {owner ? (
                      <Badge>{t('roles.owner')}</Badge>
                    ) : u.scope === 'granted' ? (
                      <Text size="sm" c="dimmed">
                        {t('users.perServer')}
                      </Text>
                    ) : (
                      <Select
                        size="xs"
                        w={150}
                        data={ASSIGNABLE.map((r) => ({ value: r, label: t(`roles.${r}`) }))}
                        value={u.role}
                        allowDeselect={false}
                        onChange={(v) => v && v !== u.role && act.mutate(() => api('PATCH', `/api/users/${u.id}`, { role: v }))}
                        aria-label={t('users.role')}
                      />
                    )}
                  </Table.Td>
                  <Table.Td>{serversCell(u)}</Table.Td>
                  <Table.Td>
                    <Badge color={u.totpEnabled ? 'green' : 'gray'} variant="light" style={{ overflow: 'visible' }} miw="max-content">
                      {u.totpEnabled ? t('profile.twoFactorOn') : t('profile.twoFactorOff')}
                    </Badge>
                  </Table.Td>
                  <Table.Td>
                    <Text size="sm">{rel(u.lastLoginAt)}</Text>
                  </Table.Td>
                  <Table.Td>
                    {!self && !owner && (
                      <Menu position="bottom-end" withinPortal>
                        <Menu.Target>
                          <ActionIcon variant="subtle" aria-label={t('common.edit')}>
                            <IconDots size={16} />
                          </ActionIcon>
                        </Menu.Target>
                        <Menu.Dropdown>
                          <Menu.Item onClick={() => setGrantsFor(u.id)}>{t('users.grants')}</Menu.Item>
                          <Menu.Item onClick={() => act.mutate(() => api('PATCH', `/api/users/${u.id}`, { disabled: !u.disabled }))}>{u.disabled ? t('users.enable') : t('users.disable')}</Menu.Item>
                          <Menu.Item
                            onClick={() => {
                              const password = tempPassword();
                              act.mutate(async () => {
                                await api('POST', `/api/users/${u.id}/reset-password`, { password });
                                setShown({ id: null, username: u.username, password, scope: u.scope });
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
                                  onConfirm: () => act.mutate(() => api('POST', `/api/users/${u.id}/reset-2fa`, {})),
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
                                onConfirm: () => act.mutate(() => api('DELETE', `/api/users/${u.id}`)),
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
      <Text size="xs" c="dimmed">
        {t('users.signOutNote')}
      </Text>

      <GrantsModal user={users.data?.find((u) => u.id === grantsFor) ?? null} opened={grantsFor !== null} onClose={() => setGrantsFor(null)} />

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
            {shown.id !== null && shown.scope === 'granted' && (
              <Button
                variant="light"
                leftSection={<IconServer2 size={16} />}
                onClick={() => {
                  add.close();
                  setGrantsFor(shown.id);
                }}
              >
                {t('users.chooseServers')}
              </Button>
            )}
            <Button onClick={add.close}>{t('common.close')}</Button>
          </Stack>
        ) : (
          <Stack>
            {error && <Alert color="red">{error}</Alert>}
            <TextInput label={t('auth.username')} value={form.username} onChange={(e) => setForm({ ...form, username: e.currentTarget.value })} maxLength={32} data-autofocus />
            <ScopeRadio value={form.scope} onChange={(scope) => setForm({ ...form, scope })} />
            {form.scope === 'all' ? (
              <Select
                label={t('users.role')}
                data={ASSIGNABLE.map((r) => ({ value: r, label: t(`roles.${r}`) }))}
                value={form.role}
                allowDeselect={false}
                onChange={(v) => v && setForm({ ...form, role: v as Role })}
                description={t(`roles.${form.role}Help`)}
              />
            ) : (
              <Text size="xs" c="dimmed">
                {t('users.grantedAfter')}
              </Text>
            )}
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
