import { Center, Group, Paper, Stack, Text, Title } from '@mantine/core';
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { LangSwitch } from '../../components/LangSwitch';

/** Centered card used by every sign-in step. */
export function AuthFrame({ title, children, width = 400 }: { title: string; children: ReactNode; width?: number }) {
  const { t } = useTranslation();
  return (
    <Center mih="100dvh" p="md">
      <Stack w="100%" maw={width} gap="md">
        <Group justify="space-between">
          <Group gap="xs">
            <img src="/favicon.svg" alt="" width={28} height={28} />
            <Text fw={700}>{t('app.title')}</Text>
          </Group>
          <LangSwitch />
        </Group>
        <Paper withBorder p="lg" shadow="sm">
          <Title order={3} mb="md">
            {title}
          </Title>
          {children}
        </Paper>
      </Stack>
    </Center>
  );
}
