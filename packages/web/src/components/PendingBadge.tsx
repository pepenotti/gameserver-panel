import { Badge, Tooltip } from '@mantine/core';
import { useTranslation } from 'react-i18next';
import type { ContainerPendingReason } from '../api/server';
import { pendingHelpKeys } from '../lib/servers';

/**
 * "Applies at next start" (SRV-05): a server's container waits for its
 * game's next start to be recreated, with new limits, on a newer runtime
 * image, or both. The tooltip says which.
 */
export function PendingBadge({ reasons, size = 'md' }: { reasons: readonly ContainerPendingReason[]; size?: 'sm' | 'md' }) {
  const { t } = useTranslation();
  return (
    <Tooltip label={pendingHelpKeys(reasons).map((k) => t(k)).join(' ')} multiline w={260}>
      <Badge size={size} variant="light" color="orange" tt="none">
        {t('servers.pendingStart')}
      </Badge>
    </Tooltip>
  );
}
