import { Affix, Alert, Button, Card, Group, Paper, ScrollArea, SegmentedControl, Stack, Text, TextInput, Transition } from '@mantine/core';
import { useDebouncedValue } from '@mantine/hooks';
import { notifications } from '@mantine/notifications';
import { IconSearch } from '@tabler/icons-react';
import { useCallback, useMemo, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import type { OptionMeta } from '@gsp/formats';
import { ApiError } from '../../api/http';
import { localize, type OptionGroup } from '../../api/meta';
import { useErrorText } from '../../lib/format';
import type { ApplyOutcome, ProposalPreview, Value } from './api';
import { placement, sections, withUnknown } from './layout';
import { OptionRow, optionLabel } from './options';
import { ProposalModal } from './ProposalModal';

const ADVANCED = '__advanced';

interface Props {
  metas: OptionMeta[];
  values: Record<string, Value>;
  /** The adapter's groups for this schema, in order (CFG-10); rare ones (and rare options) sit under "Advanced". */
  groups: OptionGroup[];
  managed?: Set<string>;
  secret?: Set<string>;
  restartOnly?: Set<string>;
  /** Submits the changes as a proposal; the form shows its preview before anything is applied. */
  onPropose: (changes: Record<string, Value>) => Promise<ProposalPreview>;
  onApplied?: (r: ApplyOutcome) => void;
  toolbar?: ReactNode;
}

/** Grouped, searchable option list with an "Advanced" section and a sticky "save N changes" bar that opens the preview. */
export function OptionsForm({ metas, values, groups, managed, secret, restartOnly, onPropose, onApplied, toolbar }: Props) {
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

  // Options present in the file but unknown to the adapter's schema still get a text box.
  const all = useMemo(() => withUnknown(metas, values), [metas, values]);
  const where = useMemo(() => new Map(all.map((m) => [m.key, placement(m, groups)])), [all, groups]);
  const { common, advanced } = useMemo(() => sections(all, groups), [all, groups]);
  const groupLabel = (g: string) => {
    const known = groups.find((x) => x.id === g);
    if (known) return localize(known.label, i18n.language);
    return groups.length ? t('config.otherSettings') : t('config.allSettings');
  };
  const current = group && (group === ADVANCED ? advanced.length > 0 : common.includes(group)) ? group : (common[0] ?? (advanced.length ? ADVANCED : null));
  const currentAdvanced = advancedGroup !== null && advanced.includes(advancedGroup) ? advancedGroup : (advanced[0] ?? null);

  const visible = useMemo(() => {
    if (debounced) {
      return all.filter((m) => {
        const d = localize(m.description, i18n.language);
        return m.key.toLowerCase().includes(debounced) || optionLabel(m, i18n.language).toLowerCase().includes(debounced) || d.toLowerCase().includes(debounced);
      });
    }
    const inAdvanced = current === ADVANCED;
    const g = inAdvanced ? currentAdvanced : current;
    return all.filter((m) => {
      const p = where.get(m.key);
      return p !== undefined && p.advanced === inAdvanced && p.group === g;
    });
  }, [all, debounced, current, currentAdvanced, where, i18n.language]);

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
  /** Where a search hit lives. */
  const searchBadge = (key: string) => {
    const p = where.get(key);
    if (!p) return undefined;
    return p.advanced ? `${t('config.advanced')} · ${groupLabel(p.group)}` : groupLabel(p.group);
  };

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
              <b>{optionLabel(all.find((m) => m.key === k) ?? { key: k }, i18n.language)}</b> ({k}): {v === 'managed' ? t('config.managed') : v === 'unknown-option' ? t('config.unknownOption') : v}
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
              group={debounced ? searchBadge(m.key) : undefined}
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
