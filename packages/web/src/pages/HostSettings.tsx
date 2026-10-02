import { Stack, Text, Title } from '@mantine/core';
import { useTranslation } from 'react-i18next';
import { useSession } from '../api/session';
import { HostDiscord } from '../components/Discord';
import { HostAddressSettings } from '../components/HostAddress';

/**
 * The panel's own settings, for every server: the addresses friends reach
 * this host by (HST-08, the owner's), and the Discord webhook their messages
 * go to (SCH-03).
 */
export function HostSettings() {
  const { t } = useTranslation();
  const { canHost } = useSession();
  return (
    <Stack maw={820}>
      <Title order={2}>{t('hostSettings.title')}</Title>
      <Text size="sm" c="dimmed">
        {t('hostSettings.intro')}
      </Text>
      {canHost('host.settings') && <HostAddressSettings />}
      <HostDiscord />
    </Stack>
  );
}
