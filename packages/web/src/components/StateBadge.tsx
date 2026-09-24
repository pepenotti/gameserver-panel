import { Badge, Loader } from '@mantine/core';
import { useTranslation } from 'react-i18next';
import type { ServerState } from '@pz/shared';

const COLOR: Record<ServerState, string> = {
  stopped: 'gray',
  installing: 'blue',
  starting: 'yellow',
  running: 'green',
  stopping: 'yellow',
  crashed: 'orange',
  failed: 'red',
};

export function StateBadge({ state, agentConnected, size = 'md' }: { state: ServerState | undefined; agentConnected: boolean; size?: 'sm' | 'md' | 'lg' }) {
  const { t } = useTranslation();
  if (!agentConnected || !state) {
    return (
      <Badge color="red" variant="outline" size={size}>
        {t('state.agentOffline')}
      </Badge>
    );
  }
  const busy = state === 'starting' || state === 'stopping' || state === 'installing';
  return (
    <Badge color={COLOR[state]} variant={state === 'running' ? 'filled' : 'light'} size={size} leftSection={busy ? <Loader size={10} color="currentColor" /> : undefined}>
      {t(`state.${state}`)}
    </Badge>
  );
}
