import { Alert, List, Text } from '@mantine/core';
import { IconInfoCircle } from '@tabler/icons-react';
import { useTranslation } from 'react-i18next';
import { localize, type AdapterNote, type I18n } from '../api/meta';

/**
 * What people should know about a game before relying on a feature (UX-04):
 * its adapter's notes, each with the docs/limitations.md entry that says
 * more. Nothing when the game has none.
 */
export function GameNotes({ game, notes }: { game: I18n; notes: readonly AdapterNote[] | undefined }) {
  const { t, i18n } = useTranslation();
  if (!notes?.length) return null;
  const docs = [...new Set(notes.flatMap((n) => (n.doc ? [n.doc] : [])))];
  return (
    <Alert color="blue" variant="light" icon={<IconInfoCircle />} title={t('server.notesTitle', { game: localize(game, i18n.language) })}>
      <List size="sm" spacing={4}>
        {notes.map((n) => (
          <List.Item key={n.id}>{localize(n.text, i18n.language)}</List.Item>
        ))}
      </List>
      {docs.length > 0 && (
        <Text size="xs" c="dimmed" mt="xs">
          {t('server.notesDoc', { doc: docs.map((d) => `docs/${d}`).join(', ') })}
        </Text>
      )}
    </Alert>
  );
}
