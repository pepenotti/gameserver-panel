import { Stack, Text, Title } from '@mantine/core';
import { useTranslation } from 'react-i18next';
import { HostDiscord } from '../components/Discord';

/** The panel's own settings, for every server: today the Discord webhook their messages go to (SCH-03). */
export function HostSettings() {
  const { t } = useTranslation();
  return (
    <Stack maw={820}>
      <Title order={2}>{t('hostSettings.title')}</Title>
      <Text size="sm" c="dimmed">
        {t('hostSettings.intro')}
      </Text>
      <HostDiscord />
    </Stack>
  );
}
