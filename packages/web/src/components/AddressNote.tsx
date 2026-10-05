import { Alert, Code, List, Text } from '@mantine/core';
import { IconAlertTriangle, IconInfoCircle } from '@tabler/icons-react';
import { useTranslation } from 'react-i18next';
import { useHostAddresses } from '../api/host';
import { useMeta } from '../api/useMeta';
import { addressNote, perAddressIn } from '../lib/host';

/**
 * Next to the addresses people see (the activity log, the signed-in
 * devices): on a host where every visitor arrives from one address (Docker
 * Desktop), they don't tell people apart (HST-07). Nothing where they do.
 */
export function AddressNote() {
  const { t } = useTranslation();
  const traits = useHostAddresses();
  const which = addressNote(traits?.addresses);
  if (!traits || !which) return null;
  return (
    <Alert color={which === 'hidden' ? 'orange' : 'blue'} variant="light" icon={which === 'hidden' ? <IconAlertTriangle /> : <IconInfoCircle />}>
      <Text size="sm">{t(`host.addresses.${which}`)}</Text>
      <Text size="xs" c="dimmed" mt={4}>
        {t('host.addresses.doc', { doc: traits.doc })}
      </Text>
    </Alert>
  );
}

/**
 * On a config file holding settings of the game that act on the address a
 * player joins from (`AdapterMeta.perAddress`, HST-07): where every player
 * arrives from one address, what each does then. Nothing for a file without
 * any, or where addresses arrive.
 */
export function PerAddressNote({ fileId }: { fileId: string }) {
  const { t } = useTranslation();
  const { meta, l } = useMeta();
  const traits = useHostAddresses();
  const settings = perAddressIn(meta, fileId);
  const which = addressNote(traits?.addresses);
  if (!settings.length || !which) return null;
  const docs = [...new Set(settings.flatMap((s) => (s.doc ? [s.doc] : [])))];
  return (
    <Alert color={which === 'hidden' ? 'orange' : 'blue'} variant="light" icon={which === 'hidden' ? <IconAlertTriangle /> : <IconInfoCircle />}>
      <Text size="sm">{t(which === 'hidden' ? 'host.addresses.settingsHidden' : 'host.addresses.settingsUnknown')}</Text>
      <List size="sm" spacing={4} mt={4}>
        {settings.map((s) => (
          <List.Item key={s.id} style={{ overflowWrap: 'anywhere' }}>
            <Code>{s.key}</Code> {l(s.text)}
          </List.Item>
        ))}
      </List>
      {docs.length > 0 && (
        <Text size="xs" c="dimmed" mt={4}>
          {t('host.addresses.doc', { doc: docs.join(', ') })}
        </Text>
      )}
    </Alert>
  );
}
