import { Autocomplete, NumberInput, Select, Switch, TextInput } from '@mantine/core';
import { useTranslation } from 'react-i18next';
import { localize, type LaunchOption } from '../api/meta';
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

/** A launch setting's value as a form starts with it: its default from the schema, typed. */
export function launchDefault(o: LaunchOption): unknown {
  if (o.default === undefined) return o.type === 'boolean' ? false : null;
  if (o.type === 'boolean') return o.default === 'true';
  if (o.type === 'integer' || o.type === 'decimal' || o.type === 'enum') return Number(o.default);
  return o.default;
}

/**
 * One launch setting, as the adapter's schema types it (the server's page
 * and the create form). `versions` turns the text field into a picker of
 * known versions that still takes free text.
 */
export function LaunchField({ o, value, onChange, versions, error, min }: { o: LaunchOption; value: unknown; onChange: (v: unknown) => void; versions?: string[]; error?: string; min?: number }) {
  const { i18n } = useTranslation();
  const label = launchLabel(o, i18n.language);
  const description = localize(o.description, i18n.language) || undefined;
  // The field stays narrow; its description may use the card's width.
  const common = { label, description, error, maw: 560, styles: { wrapper: { maxWidth: 260 } } };
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
          max={o.max}
          step={o.step ?? (o.type === 'integer' ? 1 : 0.1)}
          allowDecimal={o.type === 'decimal'}
          hideControls={o.step === undefined && o.min !== undefined && o.max !== undefined && o.max - o.min > 100}
        />
      );
    case 'enum':
      return (
        <Select
          {...common}
          data={(o.options ?? []).map((x) => ({ value: String(x.value), label: localize(x.label, i18n.language) || String(x.value) }))}
          value={value === null || value === undefined ? null : String(value)}
          onChange={(v) => v !== null && onChange(Number(v))}
          allowDeselect={false}
        />
      );
    case 'string':
      return versions ? (
        // Free text (a pinned build), with every known version listed whatever is typed.
        <Autocomplete {...common} data={versions} filter={({ options }) => options} value={String(value ?? '')} onChange={(v) => onChange(v.replace(/[\r\n]/g, ''))} />
      ) : (
        <TextInput {...common} value={String(value ?? '')} onChange={(e) => onChange(e.currentTarget.value.replace(/[\r\n]/g, ''))} />
      );
  }
}
