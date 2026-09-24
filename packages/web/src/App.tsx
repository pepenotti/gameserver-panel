import { Button, Center, Loader, Stack, Text, Title } from '@mantine/core';
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Navigate, Route, Routes } from 'react-router';
import type { Permission } from '@gsp/shared';
import { LiveProvider } from './api/live';
import { useSession } from './api/session';
import { Layout, NAV } from './components/Layout';
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
import { Dashboard } from './pages/Dashboard';
import { Profile } from './pages/Profile';
import { Users } from './pages/Users';

function Guard({ permission, children }: { permission: Permission; children: ReactNode }) {
  const { can } = useSession();
  return can(permission) ? children : <Navigate to="/" replace />;
}

/** A NAV page: its permission, then what it needs from the game (a page reached anyway says why it's empty). */
function Page({ to, children }: { to: string; children: ReactNode }) {
  const { t } = useTranslation();
  const item = NAV.find((n) => n.to === to);
  if (!item) throw new Error(`No NAV item for ${to}`);
  return (
    <Guard permission={item.permission}>
      <Supported need={item} title={t(item.label)}>
        {children}
      </Supported>
    </Guard>
  );
}

const PAGES: [string, ReactNode][] = [
  ['/', <Dashboard />],
  ['/players', <Players />],
  ['/console', <Console />],
  ['/config', <Config />],
  ['/mods', <Mods />],
  ['/backups', <Backups />],
  ['/schedules', <Schedules />],
  ['/server', <Server />],
  ['/reset', <Reset />],
  ['/users', <Users />],
  ['/audit', <Audit />],
];

function NotFound() {
  const { t } = useTranslation();
  return (
    <Stack align="center" mt="xl">
      <Title order={3}>404</Title>
      <Text c="dimmed">{t('errors.not-found')}</Text>
    </Stack>
  );
}

/**
 * The sign-in flow is a gate in front of the whole app: the server decides
 * what is still pending (2FA code, new password, 2FA enrolment) and the UI
 * simply shows that step.
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
      <Layout>
        <Routes>
          <Route path="/profile" element={<Profile />} />
          {PAGES.map(([to, page]) => (
            <Route key={to} path={to} element={<Page to={to}>{page}</Page>} />
          ))}
          <Route path="*" element={<NotFound />} />
        </Routes>
      </Layout>
    </LiveProvider>
  );
}
