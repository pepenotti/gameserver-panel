import { AppShell, Burger, Divider, Group, Menu, NavLink, ScrollArea, Select, Text, UnstyledButton } from '@mantine/core';
import { useDisclosure } from '@mantine/hooks';
import {
  IconAdjustments,
  IconArchive,
  IconCalendarTime,
  IconChevronDown,
  IconGauge,
  IconHistory,
  IconLogout,
  IconPuzzle,
  IconRestore,
  IconServer,
  IconServer2,
  IconSettings,
  IconTerminal2,
  IconUserCircle,
  IconUsers,
  IconUsersGroup,
  type Icon,
} from '@tabler/icons-react';
import { useEffect, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { NavLink as RouterLink, useLocation, useNavigate } from 'react-router';
import type { Permission } from '@gsp/shared';
import { useLive, useLiveServers } from '../api/live';
import { localize, NEED_MODS, NEED_RESETS, type Need } from '../api/meta';
import { lastServer, serverHref, useCanSomewhere, useServers, useServerScope, type ServerSummary } from '../api/server';
import { useMeta } from '../api/useMeta';
import { useSession } from '../api/session';
import { LangSwitch } from './LangSwitch';
import { LiveToasts } from './LiveToasts';
import { StateBadge } from './StateBadge';

/** A page: hidden without its permission, and without what it needs from the game (`capability`, `when`). */
export interface NavItem extends Need {
  /** A server's page: its path under /s/<sid>; a host page: its path. */
  to: string;
  label: string;
  icon: Icon;
  /** None: any signed-in user (the server list). */
  permission?: Permission;
  /** A host page whose permission must hold on the host itself (every server), not just on some server. */
  hostOnly?: boolean;
}

/** The pages of one server (under /s/<sid>); App routes them with the same permission and needs. */
export const SERVER_NAV: NavItem[] = [
  { to: '/', label: 'nav.dashboard', icon: IconGauge, permission: 'server.view' },
  { to: '/players', label: 'nav.players', icon: IconUsersGroup, permission: 'players.view', capability: 'players' },
  { to: '/console', label: 'nav.console', icon: IconTerminal2, permission: 'log.view' },
  { to: '/config', label: 'nav.config', icon: IconSettings, permission: 'config.edit' },
  { to: '/mods', label: 'nav.mods', icon: IconPuzzle, permission: 'mods.manage', ...NEED_MODS },
  { to: '/backups', label: 'nav.backups', icon: IconArchive, permission: 'server.view' },
  { to: '/schedules', label: 'nav.schedules', icon: IconCalendarTime, permission: 'schedules.view' },
  { to: '/server', label: 'nav.server', icon: IconServer, permission: 'server.update' },
  { to: '/reset', label: 'nav.reset', icon: IconRestore, permission: 'reset.world', ...NEED_RESETS },
];

/** The host's pages: every server, accounts, the activity log and the host's own settings. */
export const HOST_NAV: NavItem[] = [
  { to: '/servers', label: 'nav.servers', icon: IconServer2 },
  { to: '/users', label: 'nav.users', icon: IconUsers, permission: 'users.manage', hostOnly: true },
  { to: '/audit', label: 'nav.audit', icon: IconHistory, permission: 'audit.view' },
  { to: '/settings', label: 'nav.hostSettings', icon: IconAdjustments, permission: 'notifications.manage', hostOnly: true },
];

/** A section title in the menu. */
function Heading({ children }: { children: ReactNode }) {
  return (
    <Text size="xs" c="dimmed" tt="uppercase" fw={600} px="sm" pt="sm" pb={4}>
      {children}
    </Text>
  );
}

/**
 * Picks the server the menu's pages are about. Switching keeps the page
 * (players, console…) when there is one; from a host page it opens the
 * server's dashboard.
 */
function ServerSwitcher({ list, sid, onPicked }: { list: ServerSummary[]; sid: string; onPicked: () => void }) {
  const { t, i18n } = useTranslation();
  const navigate = useNavigate();
  const location = useLocation();
  const scope = useServerScope();
  const live = useLiveServers();
  const pick = (next: string | null) => {
    if (!next || next === scope?.sid) return;
    // The same page on the other server; its guard sends people without the permission to its dashboard.
    const rest = scope ? location.pathname.slice(serverHref(scope.sid, '').length) || '/' : '/';
    navigate(serverHref(next, SERVER_NAV.some((n) => n.to !== '/' && rest.startsWith(n.to)) ? rest : '/'));
    onPicked();
  };
  const stateOf = (s: ServerSummary) => (live.open && live.servers[s.id]?.status ? live.servers[s.id]!.status!.state : s.state);
  return (
    <Select
      aria-label={t('nav.switchServer')}
      data={list.map((s) => ({ value: s.id, label: s.name }))}
      value={sid}
      onChange={pick}
      allowDeselect={false}
      searchable={list.length > 6}
      mx={4}
      mb={4}
      comboboxProps={{ withinPortal: true }}
      renderOption={({ option }) => {
        const s = list.find((x) => x.id === option.value)!;
        return (
          <Group gap={6} wrap="nowrap" justify="space-between" w="100%">
            <div style={{ minWidth: 0 }}>
              <Text size="sm" truncate>
                {s.name}
              </Text>
              <Text size="xs" c="dimmed" truncate>
                {localize(s.adapterName, i18n.language)} · {t(`roles.${s.role}`)}
              </Text>
            </div>
            <Text size="xs" c="dimmed">
              {t(`state.${stateOf(s) ?? 'unknown'}`)}
            </Text>
          </Group>
        );
      }}
    />
  );
}

export function Layout({ children }: { children: ReactNode }) {
  const { t, i18n } = useTranslation();
  const [opened, { toggle, close }] = useDisclosure();
  const { session, can, canHost, logout } = useSession();
  const scope = useServerScope();
  const servers = useServers();
  // On a host page, the server menu is about the last server opened here, or the first one.
  const list = servers.data ?? [];
  const sid = scope?.sid ?? list.find((s) => s.id === lastServer())?.id ?? list[0]?.id ?? null;
  const server = scope?.server ?? list.find((s) => s.id === sid) ?? null;
  const meta = useMeta(sid);
  const live = useLive();
  const location = useLocation();
  // A server's permissions: inside its pages `can` already answers for it.
  const canOnServer = (p: Permission) => can(p) || !!server?.permissions.includes(p);

  useEffect(() => {
    document.title = scope?.server ? `${scope.server.name} · ${t('app.title')}` : t('app.title');
  }, [t, i18n.language, scope?.server]);

  const serverNav = sid && server ? SERVER_NAV.filter((n) => (n.permission === undefined || canOnServer(n.permission)) && meta.supports(n)) : [];
  const somewhere = useCanSomewhere();
  const hostNav = HOST_NAV.filter((n) => n.permission === undefined || (n.hostOnly ? canHost(n.permission) : somewhere(n.permission)));
  const onHostPage = !scope;

  return (
    <AppShell header={{ height: 56 }} navbar={{ width: 240, breakpoint: 'sm', collapsed: { mobile: !opened } }} padding="md">
      <AppShell.Header>
        <Group h="100%" px="md" justify="space-between" wrap="nowrap">
          <Group gap="sm" wrap="nowrap" style={{ minWidth: 0 }}>
            <Burger opened={opened} onClick={toggle} hiddenFrom="sm" size="sm" aria-label="Menu" />
            <img src="/favicon.svg" alt="" width={26} height={26} />
            <Text fw={700} visibleFrom="md">
              {t('app.title')}
            </Text>
            {scope?.server && (
              <Text fw={600} size="sm" truncate visibleFrom="xs" maw={220}>
                {scope.server.name}
              </Text>
            )}
            {scope && <StateBadge state={live.status?.state} agentConnected={live.agentConnected} size="sm" />}
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
                <Menu.Label>{session ? (session.user.scope === 'granted' ? t('users.scopeGrantedShort') : t(`roles.${session.user.role}`)) : ''}</Menu.Label>
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
        <AppShell.Section grow component={ScrollArea}>
          {sid && server && (
            <>
              <Heading>{t('nav.serverSection')}</Heading>
              {list.length > 1 ? (
                <ServerSwitcher list={list} sid={sid} onPicked={close} />
              ) : (
                <Text size="sm" fw={600} px="sm" pb={4} truncate>
                  {server.name}
                </Text>
              )}
              {serverNav.map((n) => {
                const href = serverHref(sid, n.to);
                return (
                  <NavLink
                    key={n.to}
                    component={RouterLink}
                    to={href}
                    label={t(n.label)}
                    leftSection={<n.icon size={18} stroke={1.6} />}
                    active={!onHostPage && (n.to === '/' ? location.pathname === href || location.pathname === href.slice(0, -1) : location.pathname.startsWith(href))}
                    onClick={close}
                  />
                );
              })}
              <Divider my="xs" />
            </>
          )}
          <Heading>{t('nav.panelSection')}</Heading>
          {hostNav.map((n) => (
            <NavLink key={n.to} component={RouterLink} to={n.to} label={t(n.label)} leftSection={<n.icon size={18} stroke={1.6} />} active={location.pathname.startsWith(n.to)} onClick={close} />
          ))}
        </AppShell.Section>
      </AppShell.Navbar>

      <AppShell.Main>
        <LiveToasts />
        {children}
      </AppShell.Main>
    </AppShell>
  );
}
