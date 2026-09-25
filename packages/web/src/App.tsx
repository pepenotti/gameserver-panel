import { Button, Center, Loader, Stack, Text, Title } from '@mantine/core';
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Navigate, Route, Routes } from 'react-router';
import type { Permission } from '@gsp/shared';
import { LiveProvider } from './api/live';
import { ServerScope, serverHref, useCanSomewhere, useServerScope } from './api/server';
import { useSession } from './api/session';
import { HOST_NAV, Layout, SERVER_NAV, type NavItem } from './components/Layout';
import { Supported } from './components/Supported';
import { AuthFrame } from './pages/auth/AuthFrame';
import { ChangePasswordForm } from './pages/auth/ChangePassword';
import { EnrolTotp } from './pages/auth/EnrolTotp';
import { Login } from './pages/auth/Login';
import { Audit } from './pages/Audit';
import { Backups } from './pages/Backups';
import { Mods } from './pages/Mods';
import { Players } from './pages/Players';
import { Reset } from './pages/Reset';
import { Schedules } from './pages/Schedules';
import { Config } from './pages/config/Config';
import { Console } from './pages/Console';
import { Server } from './pages/Server';
import { Servers } from './pages/Servers';
import { Dashboard } from './pages/Dashboard';
import { Profile } from './pages/Profile';
import { Users } from './pages/Users';

function Guard({ permission, children }: { permission: Permission; children: ReactNode }) {
  const { can } = useSession();
  const scope = useServerScope();
  const somewhere = useCanSomewhere();
  // A server's page: its server; a host page: anywhere (the audit log of some servers).
  if (scope ? can(permission) : somewhere(permission)) return children;
  // Back to the server's dashboard, or the home page.
  return <Navigate to={scope ? serverHref(scope.sid, '/') : '/'} replace />;
}

/** A NAV page: its permission, then what it needs from the game (a page reached anyway says why it's empty). */
function Page({ item, children }: { item: NavItem; children: ReactNode }) {
  const { t } = useTranslation();
  return (
    <Guard permission={item.permission}>
      <Supported need={item} title={t(item.label)}>
        {children}
      </Supported>
    </Guard>
  );
}

/** The pages of one server, under /s/<sid>/. */
const SERVER_PAGES: Record<string, ReactNode> = {
  '/': <Dashboard />,
  '/players': <Players />,
  '/console': <Console />,
  '/config': <Config />,
  '/mods': <Mods />,
  '/backups': <Backups />,
  '/schedules': <Schedules />,
  '/server': <Server />,
  '/reset': <Reset />,
};

/** The host's pages. */
const HOST_PAGES: Record<string, ReactNode> = {
  '/users': <Users />,
  '/audit': <Audit />,
};

function NotFound({ what = 'errors.not-found' }: { what?: string }) {
  const { t } = useTranslation();
  return (
    <Stack align="center" mt="xl">
      <Title order={3}>404</Title>
      <Text c="dimmed">{t(what)}</Text>
    </Stack>
  );
}

function ServerPages() {
  return (
    <Routes>
      {SERVER_NAV.map((item) =>
        item.to === '/' ? (
          <Route key={item.to} index element={<Page item={item}>{SERVER_PAGES[item.to]}</Page>} />
        ) : (
          <Route key={item.to} path={item.to.slice(1)} element={<Page item={item}>{SERVER_PAGES[item.to]}</Page>} />
        ),
      )}
      <Route path="*" element={<NotFound />} />
    </Routes>
  );
}

/**
 * The sign-in flow is a gate in front of the whole app: the server decides
 * what is still pending (2FA code, new password, 2FA enrolment) and the UI
 * simply shows that step. Past it: the server list at /, each server's
 * pages under /s/<sid>/, and the host's pages.
 */
export function App() {
  const { t } = useTranslation();
  const { session, loading, logout } = useSession();

  if (loading) {
    return (
      <Center mih="100dvh">
        <Loader />
      </Center>
    );
  }
  if (!session || session.pending === 'mfa') return <Login />;
  if (session.pending === 'password') {
    return (
      <AuthFrame title={t('auth.forcePasswordTitle')}>
        <Text size="sm" c="dimmed" mb="md">
          {t('auth.forcePasswordHelp')}
        </Text>
        <ChangePasswordForm />
        <Button variant="subtle" size="xs" mt="md" onClick={() => void logout()}>
          {t('nav.logout')}
        </Button>
      </AuthFrame>
    );
  }
  if (session.pending === 'enrol') {
    return (
      <AuthFrame title={t('auth.enrolTitle')} width={460}>
        <EnrolTotp />
      </AuthFrame>
    );
  }

  return (
    <LiveProvider enabled>
      <Routes>
        <Route
          path="/s/:sid/*"
          element={
            <ServerScope
              notFound={
                <Layout>
                  <NotFound what="errors.server-not-found" />
                </Layout>
              }
            >
              <Layout>
                <ServerPages />
              </Layout>
            </ServerScope>
          }
        />
        <Route
          path="*"
          element={
            <Layout>
              <Routes>
                <Route index element={<Servers />} />
                <Route path="/profile" element={<Profile />} />
                {HOST_NAV.map((item) => (
                  <Route key={item.to} path={item.to} element={<Page item={item}>{HOST_PAGES[item.to]}</Page>} />
                ))}
                <Route path="*" element={<NotFound />} />
              </Routes>
            </Layout>
          }
        />
      </Routes>
    </LiveProvider>
  );
}
