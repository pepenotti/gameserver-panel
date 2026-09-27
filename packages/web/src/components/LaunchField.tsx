import { Alert, Autocomplete, NumberInput, Select, Stack, Switch, TextInput } from '@mantine/core';
import { IconAlertTriangle } from '@tabler/icons-react';
import { useTranslation } from 'react-i18next';
import { localize, type I18n, type LaunchChoice, type LaunchOption } from '../api/meta';
import { humanize } from '../pages/config/options';

/** What a launch setting is called: the adapter's label (else a name from its key), with its unit. */
export function launchLabel(o: LaunchOption, lang: string): string {
  const name = localize(o.label, lang) || humanize(o.key);
  return o.unit ? `${name} (${o.unit})` : name;
}

/** The first launch setting with that role (`version`, `memory`), if the adapter has one. */
export function launchKey(schema: readonly LaunchOption[], role: 'version' | 'memory'): string | undefined {
  return schema.find((o) => o.role === role)?.key;
}

/** Choices that are words, not numbers: their values stay text. */
const wordChoices = (o: LaunchOption) => (o.options ?? []).some((x) => typeof x.value === 'string');

/** A launch setting's value as a form starts with it: its default from the schema, typed. */
export function launchDefault(o: LaunchOption): unknown {
  if (o.default === undefined) return o.type === 'boolean' ? false : null;
  if (o.type === 'boolean') return o.default === 'true';
  if (o.type === 'enum' && wordChoices(o)) return o.default;
  if (o.type === 'integer' || o.type === 'decimal' || o.type === 'enum') return Number(o.default);
  return o.default;
}

/** How a choice reads in a list: its label or value, then its facts. */
function choiceText(c: LaunchChoice, lang: string): string {
  const facts = [c.detail, c.channel].filter((x): x is string => !!x);
  const name = localize(c.label, lang) || c.value;
  return facts.length ? `${name} · ${facts.join(' · ')}` : name;
}

/**
 * One launch setting, as the adapter's schema types it (the server's page
 * and the create form). `choices` (from the game's download services) turn
 * it into a pick list whose entries may carry a warning, worded by
 * `warnings`, shown under it once picked; `onChoice` hears the pick, so a
 * form can bring along what it implies. `versions` turns a text field into
 * a picker of known versions that still takes free text.
 */
export function LaunchField({
  o,
  value,
  onChange,
  versions,
  choices,
  warnings,
  onChoice,
  error,
  min,
  max,
}: {
  o: LaunchOption;
  value: unknown;
  onChange: (v: unknown) => void;
  versions?: string[];
  choices?: LaunchChoice[];
  warnings?: Record<string, I18n>;
  onChoice?: (c: LaunchChoice) => void;
  error?: string;
  min?: number;
  max?: number;
}) {
  const { i18n } = useTranslation();
  const lang = i18n.language;
  const label = launchLabel(o, lang);
  const description = localize(o.description, lang) || undefined;
  // The field stays narrow; its description may use the card's width.
  const common = { label, description, error, maw: 560, styles: { wrapper: { maxWidth: 260 } } };

  if (choices && (o.type === 'string' || o.type === 'enum')) {
    const current = value === null || value === undefined ? '' : String(value);
    // What is set stays listed even when the services no longer offer it (a version pinned long ago).
    const list = choices.some((c) => c.value === current) || current === '' ? choices : [{ value: current }, ...choices];
    const picked = list.find((c) => c.value === current);
    const warning = picked?.warning ? (warnings?.[picked.warning] ?? { en: picked.warning, es: picked.warning }) : null;
    return (
      <Stack gap={6}>
        <Select
          {...common}
          styles={{ wrapper: { maxWidth: 360 } }}
          data={list.map((c) => ({ value: c.value, label: choiceText(c, lang) }))}
          value={list.some((c) => c.value === current) ? current : null}
          onChange={(v) => {
            if (v === null) return;
            onChange(v);
            const c = list.find((x) => x.value === v);
            if (c) onChoice?.(c);
          }}
          allowDeselect={false}
          searchable
          maxDropdownHeight={280}
        />
        {warning && (
          <Alert color="orange" variant="light" icon={<IconAlertTriangle />} maw={560} p="xs">
            {localize(warning, lang)}
          </Alert>
        )}
      </Stack>
    );
  }

  switch (o.type) {
    case 'boolean':
      return <Switch label={label} description={description} error={error} checked={value === true} onChange={(e) => onChange(e.currentTarget.checked)} />;
    case 'integer':
    case 'decimal':
      return (
        <NumberInput
          {...common}
          value={typeof value === 'number' ? value : ''}
          onChange={(v) => onChange(v === '' ? null : Number(v))}
          min={min ?? o.min}
          max={max ?? o.max}
          step={o.step ?? (o.type === 'integer' ? 1 : 0.1)}
          allowDecimal={o.type === 'decimal'}
          hideControls={o.step === undefined && o.min !== undefined && o.max !== undefined && o.max - o.min > 100}
        />
      );
    case 'enum': {
      const words = wordChoices(o);
      return (
        <Select
          {...common}
          data={(o.options ?? []).map((x) => ({ value: String(x.value), label: localize(x.label, lang) || String(x.value) }))}
          value={value === null || value === undefined ? null : String(value)}
          onChange={(v) => v !== null && onChange(words ? v : Number(v))}
          allowDeselect={false}
        />
      );
    }
    case 'string':
      return versions ? (
        // Free text (a pinned build), with every known version listed whatever is typed.
        <Autocomplete {...common} data={versions} filter={({ options }) => options} value={String(value ?? '')} onChange={(v) => onChange(v.replace(/[\r\n]/g, ''))} />
      ) : (
        <TextInput {...common} value={String(value ?? '')} onChange={(e) => onChange(e.currentTarget.value.replace(/[\r\n]/g, ''))} />
      );
  }
}
