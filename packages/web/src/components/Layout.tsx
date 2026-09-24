import { AppShell, Burger, Group, Menu, NavLink, ScrollArea, Text, UnstyledButton } from '@mantine/core';
import { useDisclosure } from '@mantine/hooks';
import { IconArchive, IconCalendarTime, IconChevronDown, IconGauge, IconPuzzle, IconRestore, IconUsersGroup, IconHistory, IconLogout, IconServer, IconSettings, IconTerminal2, IconUserCircle, IconUsers, type Icon } from '@tabler/icons-react';
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { NavLink as RouterLink, useLocation } from 'react-router';
import type { Permission } from '@pz/shared';
import { useLive } from '../api/live';
import { useSession } from '../api/session';
import { LangSwitch } from './LangSwitch';
import { LiveToasts } from './LiveToasts';
import { StateBadge } from './StateBadge';

interface NavItem {
  to: string;
  label: string;
  icon: Icon;
  permission: Permission;
}

/** Pages register here as milestones add them; each is hidden without its permission. */
export const NAV: NavItem[] = [
  { to: '/', label: 'nav.dashboard', icon: IconGauge, permission: 'dashboard.view' },
  { to: '/players', label: 'nav.players', icon: IconUsersGroup, permission: 'players.view' },
  { to: '/console', label: 'nav.console', icon: IconTerminal2, permission: 'log.view' },
  { to: '/config', label: 'nav.config', icon: IconSettings, permission: 'config.edit' },
  { to: '/mods', label: 'nav.mods', icon: IconPuzzle, permission: 'mods.manage' },
  { to: '/backups', label: 'nav.backups', icon: IconArchive, permission: 'dashboard.view' },
  { to: '/schedules', label: 'nav.schedules', icon: IconCalendarTime, permission: 'schedules.view' },
  { to: '/server', label: 'nav.server', icon: IconServer, permission: 'server.update' },
  { to: '/reset', label: 'nav.reset', icon: IconRestore, permission: 'reset.world' },
  { to: '/users', label: 'nav.users', icon: IconUsers, permission: 'users.manage' },
  { to: '/audit', label: 'nav.audit', icon: IconHistory, permission: 'audit.view' },
];

export function Layout({ children }: { children: ReactNode }) {
  const { t } = useTranslation();
  const [opened, { toggle, close }] = useDisclosure();
  const { session, can, logout } = useSession();
  const live = useLive();
  const location = useLocation();

  return (
    <AppShell header={{ height: 56 }} navbar={{ width: 230, breakpoint: 'sm', collapsed: { mobile: !opened } }} padding="md">
      <AppShell.Header>
        <Group h="100%" px="md" justify="space-between" wrap="nowrap">
          <Group gap="sm" wrap="nowrap">
            <Burger opened={opened} onClick={toggle} hiddenFrom="sm" size="sm" aria-label="Menu" />
            <img src="/favicon.svg" alt="" width={26} height={26} />
            <Text fw={700} visibleFrom="xs">
              {t('app.title')}
            </Text>
            <StateBadge state={live.status?.state} agentConnected={live.agentConnected} size="sm" />
          </Group>
          <Group gap="sm" wrap="nowrap">
            <LangSwitch />
            <Menu position="bottom-end" withinPortal>
              <Menu.Target>
                <UnstyledButton aria-label={t('nav.profile')}>
                  <Group gap={4} wrap="nowrap">
                    <IconUserCircle size={22} />
                    <Text size="sm" visibleFrom="sm">
                      {session?.user.username}
                    </Text>
                    <IconChevronDown size={14} />
                  </Group>
                </UnstyledButton>
              </Menu.Target>
              <Menu.Dropdown>
                <Menu.Label>{session ? t(`roles.${session.user.role}`) : ''}</Menu.Label>
                <Menu.Item component={RouterLink} to="/profile" leftSection={<IconUserCircle size={16} />} onClick={close}>
                  {t('nav.profile')}
                </Menu.Item>
                <Menu.Item color="red" leftSection={<IconLogout size={16} />} onClick={() => void logout()}>
                  {t('nav.logout')}
                </Menu.Item>
              </Menu.Dropdown>
            </Menu>
          </Group>
        </Group>
      </AppShell.Header>

      <AppShell.Navbar p="xs">
        <ScrollArea>
          {NAV.filter((n) => can(n.permission)).map((n) => (
            <NavLink
              key={n.to}
              component={RouterLink}
              to={n.to}
              label={t(n.label)}
              leftSection={<n.icon size={18} stroke={1.6} />}
              active={n.to === '/' ? location.pathname === '/' : location.pathname.startsWith(n.to)}
              onClick={close}
            />
          ))}
        </ScrollArea>
      </AppShell.Navbar>

      <AppShell.Main>
        <LiveToasts />
        {children}
      </AppShell.Main>
    </AppShell>
  );
}
