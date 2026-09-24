import { Affix, Alert, Button, Card, Group, Paper, ScrollArea, SegmentedControl, Stack, Text, TextInput, Transition } from '@mantine/core';
import { useDebouncedValue } from '@mantine/hooks';
import { notifications } from '@mantine/notifications';
import { IconSearch } from '@tabler/icons-react';
import { useCallback, useMemo, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import type { OptionMeta } from '@gsp/formats';
import { ApiError } from '../../api/http';
import { useErrorText } from '../../lib/format';
import type { ApplyOutcome, ProposalPreview, Value } from './api';
import { OptionRow, humanize } from './options';
import { ProposalModal } from './ProposalModal';

const ADVANCED = '__advanced';

interface Props {
  metas: OptionMeta[];
  values: Record<string, Value>;
  groupOf: (key: string) => string;
  groupOrder: string[];
  /** Groups of rare settings: kept under "Advanced" (CFG-10), still reachable and searchable. */
  advancedGroups?: string[];
  groupLabel: (g: string) => string;
  managed?: Set<string>;
  secret?: Set<string>;
  restartOnly?: Set<string>;
  /** Submits the changes as a proposal; the form shows its preview before anything is applied. */
  onPropose: (changes: Record<string, Value>) => Promise<ProposalPreview>;
  onApplied?: (r: ApplyOutcome) => void;
  toolbar?: ReactNode;
}

/** Grouped, searchable option list with an "Advanced" section and a sticky "save N changes" bar that opens the preview. */
export function OptionsForm({ metas, values, groupOf, groupOrder, advancedGroups = [], groupLabel, managed, secret, restartOnly, onPropose, onApplied, toolbar }: Props) {
  const { t, i18n } = useTranslation();
  const errorText = useErrorText();
  const [group, setGroup] = useState<string | null>(null);
  const [advancedGroup, setAdvancedGroup] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [debounced] = useDebouncedValue(query.trim().toLowerCase(), 200);
  const [draft, setDraft] = useState<Record<string, Value>>({});
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [preview, setPreview] = useState<ProposalPreview | null>(null);

  // Options present in the file but unknown to the bundled metadata still get a text box.
  const all = useMemo(() => {
    const known = new Set(metas.map((m) => m.key));
    const extra: OptionMeta[] = Object.keys(values)
      .filter((k) => !known.has(k))
      .map((k) => ({ key: k, type: typeof values[k] === 'boolean' ? 'boolean' : typeof values[k] === 'number' ? 'decimal' : 'string', description: {} }));
    return [...metas.filter((m) => m.key in values), ...extra];
  }, [metas, values]);

  const present = (g: string) => all.some((m) => groupOf(m.key) === g);
  // Groups the layout doesn't know are listed after its own, so nothing is unreachable.
  const groups = useMemo(() => [...new Set([...groupOrder, ...all.map((m) => groupOf(m.key))])].filter((g) => all.some((m) => groupOf(m.key) === g)), [all, groupOf, groupOrder]);
  const common = groups.filter((g) => !advancedGroups.includes(g));
  const advanced = groups.filter((g) => advancedGroups.includes(g));
  const current = group && (group === ADVANCED ? advanced.length > 0 : present(group)) ? group : (common[0] ?? (advanced.length ? ADVANCED : null));
  const currentAdvanced = advancedGroup && advanced.includes(advancedGroup) ? advancedGroup : (advanced[0] ?? null);

  const visible = useMemo(() => {
    if (debounced) {
      return all.filter((m) => {
        const d = (i18n.language.startsWith('en') ? m.description.en : m.description.es) ?? '';
        return m.key.toLowerCase().includes(debounced) || humanize(m.key).toLowerCase().includes(debounced) || d.toLowerCase().includes(debounced);
      });
    }
    const g = current === ADVANCED ? currentAdvanced : current;
    return all.filter((m) => groupOf(m.key) === g);
  }, [all, debounced, current, currentAdvanced, groupOf, i18n.language]);

  const onChange = useCallback(
    (key: string, v: Value) => {
      setDraft((d) => {
        const next = { ...d };
        if (String(v) === String(values[key])) delete next[key];
        else next[key] = v;
        return next;
      });
    },
    [values],
  );

  const count = Object.keys(draft).length;
  const save = async () => {
    setSaving(true);
    setFieldErrors({});
    try {
      // An emptied number box is an empty value (the check says what's wrong), never "remove this setting".
      setPreview(await onPropose(Object.fromEntries(Object.entries(draft).map(([k, v]) => [k, v ?? '']))));
    } catch (e) {
      if (e instanceof ApiError && e.extra.fields) setFieldErrors(e.extra.fields as Record<string, string>);
      notifications.show({ color: 'red', message: errorText(e) });
    } finally {
      setSaving(false);
    }
  };

  const groupData = (list: string[]) => list.map((g) => ({ value: g, label: groupLabel(g) }));

  return (
    <Stack>
      <Group justify="space-between" align="flex-end">
        {!debounced ? (
          <Stack gap={6} style={{ maxWidth: '100%' }}>
            <ScrollArea type="auto" offsetScrollbars>
              <SegmentedControl
                size="xs"
                value={current ?? ''}
                onChange={setGroup}
                data={[...groupData(common), ...(advanced.length ? [{ value: ADVANCED, label: t('config.advanced') }] : [])]}
              />
            </ScrollArea>
            {current === ADVANCED && (
              <ScrollArea type="auto" offsetScrollbars>
                <SegmentedControl size="xs" color="gray" value={currentAdvanced ?? ''} onChange={setAdvancedGroup} data={groupData(advanced)} />
              </ScrollArea>
            )}
          </Stack>
        ) : (
          <Text size="sm" c="dimmed">
            {t('config.searchResults', { count: visible.length })}
          </Text>
        )}
        <Group gap="xs">
          {toolbar}
          <TextInput size="xs" leftSection={<IconSearch size={14} />} placeholder={t('config.search')} value={query} onChange={(e) => setQuery(e.currentTarget.value)} w={220} aria-label={t('config.search')} />
        </Group>
      </Group>

      {current === ADVANCED && !debounced && (
        <Text size="xs" c="dimmed">
          {t('config.advancedHelp')}
        </Text>
      )}

      {Object.keys(fieldErrors).length > 0 && (
        <Alert color="red" variant="light">
          {Object.entries(fieldErrors).map(([k, v]) => (
            <Text key={k} size="sm">
              <b>{humanize(k)}</b> ({k}): {v === 'managed' ? t('config.managed') : v === 'unknown-option' ? t('config.unknownOption') : v}
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
              group={debounced ? (advancedGroups.includes(groupOf(m.key)) ? `${t('config.advanced')} · ${groupLabel(groupOf(m.key))}` : groupLabel(groupOf(m.key))) : undefined}
            />
          ))
        )}
      </Card>

      <Affix position={{ bottom: 20, right: 20 }}>
        <Transition transition="slide-up" mounted={count > 0 && preview === null}>
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

      <ProposalModal
        preview={preview}
        onClose={() => setPreview(null)}
        onApplied={(r) => {
          setPreview(null);
          setDraft({});
          onApplied?.(r);
        }}
      />
    </Stack>
  );
}
