import { Button, Center, Loader, Stack, Text, Title } from '@mantine/core';
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Navigate, Route, Routes } from 'react-router';
import type { Permission } from '@pz/shared';
import { LiveProvider } from './api/live';
import { useSession } from './api/session';
import { Layout } from './components/Layout';
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
          <Route path="/" element={<Dashboard />} />
          <Route path="/profile" element={<Profile />} />
          <Route path="/backups" element={<Backups />} />
          <Route path="/players" element={<Players />} />
          <Route path="/schedules" element={<Schedules />} />
          <Route
            path="/mods"
            element={
              <Guard permission="mods.manage">
                <Mods />
              </Guard>
            }
          />
          <Route
            path="/reset"
            element={
              <Guard permission="reset.world">
                <Reset />
              </Guard>
            }
          />
          <Route
            path="/console"
            element={
              <Guard permission="log.view">
                <Console />
              </Guard>
            }
          />
          <Route
            path="/config"
            element={
              <Guard permission="config.edit">
                <Config />
              </Guard>
            }
          />
          <Route
            path="/server"
            element={
              <Guard permission="server.update">
                <Server />
              </Guard>
            }
          />
          <Route
            path="/users"
            element={
              <Guard permission="users.manage">
                <Users />
              </Guard>
            }
          />
          <Route
            path="/audit"
            element={
              <Guard permission="audit.view">
                <Audit />
              </Guard>
            }
          />
          <Route path="*" element={<NotFound />} />
        </Routes>
      </Layout>
    </LiveProvider>
  );
}
