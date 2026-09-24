import { Alert, Center, Loader, Stack, Text, Title } from '@mantine/core';
import { IconInfoCircle } from '@tabler/icons-react';
import type { ReactNode } from 'react';
import type { TFunction } from 'i18next';
import { useTranslation } from 'react-i18next';
import { capabilityKey, type Need } from '../api/meta';
import { useMeta } from '../api/useMeta';

function featureName(t: TFunction, need: Need, fallback = ''): string {
  const caps = need.capability === undefined ? [] : typeof need.capability === 'string' ? [need.capability] : need.capability;
  if (need.feature) return t(need.feature);
  return caps.length ? caps.map((c) => t(capabilityKey(c))).join(t('support.or')) : fallback;
}

/** Why a page or feature is missing: the game doesn't support it (PRD §3.1 principle 5, explain rather than hide). */
export function Unsupported({ need, title }: { need: Need; title?: string }) {
  const { t } = useTranslation();
  const { gameName } = useMeta();
  const feature = featureName(t, need, title);
  return (
    <Stack maw={640}>
      {title && <Title order={2}>{title}</Title>}
      <Alert variant="light" color="blue" icon={<IconInfoCircle />} title={t('support.title')}>
        {t('support.body', { game: gameName || t('support.thisGame'), feature })}
      </Alert>
    </Stack>
  );
}

/** One line naming the features of a page the server's game lacks (their controls are left out); nothing when it has them all. */
export function UnsupportedNote({ needs }: { needs: Need[] }) {
  const { t } = useTranslation();
  const m = useMeta();
  if (!m.meta) return null;
  const missing = needs.filter((n) => !m.supports(n)).map((n) => featureName(t, n));
  if (missing.length === 0) return null;
  return (
    <Text size="xs" c="dimmed">
      {t('support.note', { game: m.gameName, features: missing.join(', ') })}
    </Text>
  );
}

/** Renders `children` when the server's game has what they need; otherwise says why not. */
export function Supported({ need, title, children }: { need: Need; title?: string; children: ReactNode }) {
  const m = useMeta();
  if (need.capability === undefined && !need.when) return children;
  if (m.loading) {
    return (
      <Center mt="xl">
        <Loader />
      </Center>
    );
  }
  return m.supports(need) ? children : <Unsupported need={need} title={title} />;
}
