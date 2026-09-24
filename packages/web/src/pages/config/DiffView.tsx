import { Box, ScrollArea, Text } from '@mantine/core';
import { useTranslation } from 'react-i18next';
import type { DiffLine } from '@gsp/shared';

/** Changed lines with their context (`null` marks skipped unchanged lines), as `withContext` from @gsp/shared returns them. */
export function DiffView({ lines, height = '50vh' }: { lines: (DiffLine | null)[]; height?: string }) {
  const { t } = useTranslation();
  if (!lines.some((l) => l && l.kind !== 'same')) return <Text c="dimmed">{t('config.history.noDiff')}</Text>;
  return (
    <ScrollArea.Autosize mah={height} type="auto">
      <Box ff="monospace" fz={12} style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
        {lines.map((l, i) =>
          l === null ? (
            <Text key={i} c="dimmed" ff="monospace" fz={12}>
              ⋯
            </Text>
          ) : (
            <div
              key={i}
              style={{
                background: l.kind === 'add' ? 'rgba(64, 192, 87, 0.15)' : l.kind === 'del' ? 'rgba(250, 82, 82, 0.15)' : undefined,
                color: l.kind === 'same' ? 'var(--mantine-color-dimmed)' : undefined,
              }}
            >
              {l.kind === 'add' ? '+ ' : l.kind === 'del' ? '- ' : '  '}
              {l.text}
            </div>
          ),
        )}
      </Box>
    </ScrollArea.Autosize>
  );
}
