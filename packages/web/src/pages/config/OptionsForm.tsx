import { Affix, Alert, Button, Card, Group, Paper, ScrollArea, SegmentedControl, Stack, Text, TextInput, Transition } from '@mantine/core';
import { useDebouncedValue } from '@mantine/hooks';
import { notifications } from '@mantine/notifications';
import { IconSearch } from '@tabler/icons-react';
import { useCallback, useMemo, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import type { OptionMeta } from '@pz/formats';
import { useErrorText } from '../../lib/format';
import { ApiError } from '../../api/http';
import { OptionRow, humanize, type ApplyResult, type Value } from './options';

interface Props {
  metas: OptionMeta[];
  values: Record<string, Value>;
  groupOf: (key: string) => string;
  groupOrder: string[];
  groupLabel: (g: string) => string;
  managed?: Set<string>;
  secret?: Set<string>;
  restartOnly?: Set<string>;
  onSave: (changes: Record<string, Value>) => Promise<ApplyResult>;
  toolbar?: ReactNode;
}

/** Grouped, searchable option list with a sticky "save N changes" bar. */
export function OptionsForm({ metas, values, groupOf, groupOrder, groupLabel, managed, secret, restartOnly, onSave, toolbar }: Props) {
  const { t, i18n } = useTranslation();
  const errorText = useErrorText();
  const [group, setGroup] = useState(groupOrder[0]!);
  const [query, setQuery] = useState('');
  const [debounced] = useDebouncedValue(query.trim().toLowerCase(), 200);
  const [draft, setDraft] = useState<Record<string, Value>>({});
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);

  // Options present in the file but unknown to the bundled metadata still get a text box.
  const all = useMemo(() => {
    const known = new Set(metas.map((m) => m.key));
    const extra: OptionMeta[] = Object.keys(values)
      .filter((k) => !known.has(k))
      .map((k) => ({ key: k, type: typeof values[k] === 'boolean' ? 'boolean' : typeof values[k] === 'number' ? 'decimal' : 'string', description: {} }));
    return [...metas.filter((m) => m.key in values), ...extra];
  }, [metas, values]);

  const visible = useMemo(() => {
    if (debounced) {
      return all.filter((m) => {
        const d = (i18n.language.startsWith('en') ? m.description.en : m.description.es) ?? '';
        return m.key.toLowerCase().includes(debounced) || humanize(m.key).toLowerCase().includes(debounced) || d.toLowerCase().includes(debounced);
      });
    }
    return all.filter((m) => groupOf(m.key) === group);
  }, [all, debounced, group, groupOf, i18n.language]);

  const onChange = useCallback((key: string, v: Value) => {
    setDraft((d) => {
      const next = { ...d };
      if (String(v) === String(values[key])) delete next[key];
      else next[key] = v;
      return next;
    });
  }, [values]);

  const count = Object.keys(draft).length;
  const save = async () => {
    setSaving(true);
    setFieldErrors({});
    try {
      const r = await onSave(draft);
      setDraft({});
      notifications.show({
        color: r.warnings.length ? 'orange' : 'green',
        message: [
          r.applied === 'live' ? t('config.appliedLive') : r.applied === 'next-start' ? t('config.appliedNext') : t('config.unchanged'),
          r.restartNeeded ? t('config.restartNeeded') : '',
          r.warnings.length ? t('config.rejected', { list: r.warnings.join('; ') }) : '',
        ]
          .filter(Boolean)
          .join(' '),
        autoClose: r.warnings.length ? false : 6000,
      });
    } catch (e) {
      if (e instanceof ApiError && e.extra.fields) setFieldErrors(e.extra.fields as Record<string, string>);
      notifications.show({ color: 'red', message: errorText(e) });
    } finally {
      setSaving(false);
    }
  };

  return (
    <Stack>
      <Group justify="space-between" align="flex-end">
        {!debounced ? (
          <ScrollArea type="auto" offsetScrollbars style={{ maxWidth: '100%' }}>
            <SegmentedControl size="xs" value={group} onChange={setGroup} data={groupOrder.filter((g) => all.some((m) => groupOf(m.key) === g)).map((g) => ({ value: g, label: groupLabel(g) }))} />
          </ScrollArea>
        ) : (
          <span />
        )}
        <Group gap="xs">
          {toolbar}
          <TextInput size="xs" leftSection={<IconSearch size={14} />} placeholder={t('config.search')} value={query} onChange={(e) => setQuery(e.currentTarget.value)} w={220} />
        </Group>
      </Group>

      {Object.keys(fieldErrors).length > 0 && (
        <Alert color="red" variant="light">
          {Object.entries(fieldErrors).map(([k, v]) => (
            <Text key={k} size="sm">
              <b>{humanize(k)}</b> ({k}): {v}
            </Text>
          ))}
        </Alert>
      )}

      <Card withBorder p={0}>
        {visible.length === 0 ? (
          <Text c="dimmed" p="md" size="sm">
            {t('config.noResults')}
          </Text>
        ) : (
          visible.map((m) => (
            <OptionRow
              key={m.key}
              meta={m}
              value={m.key in draft ? draft[m.key]! : (values[m.key] ?? null)}
              original={values[m.key] ?? null}
              onChange={onChange}
              managed={managed?.has(m.key)}
              secret={secret?.has(m.key)}
              restartOnly={restartOnly?.has(m.key)}
            />
          ))
        )}
      </Card>

      <Affix position={{ bottom: 20, right: 20 }}>
        <Transition transition="slide-up" mounted={count > 0}>
          {(styles) => (
            <Paper shadow="lg" p="sm" withBorder style={styles}>
              <Group gap="xs">
                <Button variant="default" onClick={() => setDraft({})} disabled={saving}>
                  {t('config.discard')}
                </Button>
                <Button onClick={() => void save()} loading={saving}>
                  {t('config.saveN', { count })}
                </Button>
              </Group>
            </Paper>
          )}
        </Transition>
      </Affix>
    </Stack>
  );
}
