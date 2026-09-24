import { Badge, Group, NumberInput, PasswordInput, Select, Stack, Switch, Text, TextInput, Tooltip } from '@mantine/core';
import { memo } from 'react';
import { useTranslation } from 'react-i18next';
import type { OptionMeta } from '@pz/formats';

export type Value = string | number | boolean | null;

export interface ConfigMeta {
  ini: OptionMeta[];
  sandbox: OptionMeta[];
  managed: string[];
  secret: string[];
  restartOnly: string[];
  presets: string[];
}

export interface ApplyResult {
  applied: 'live' | 'next-start' | 'unchanged';
  warnings: string[];
  restartNeeded: boolean;
}

/** "SafetyToggleTimer" → "Safety toggle timer"; "ZombieLore.Speed" → "Speed". */
export function humanize(key: string): string {
  const last = key.split('.').at(-1) ?? key;
  const words = last
    .replace(/_/g, ' ')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .trim();
  return words.charAt(0).toUpperCase() + words.slice(1).toLowerCase().replace(/\bpvp\b/g, 'PvP').replace(/\bxp\b/g, 'XP').replace(/\bid\b/g, 'ID');
}

function localized(l: Partial<Record<'en' | 'es', string>> | undefined, lang: string): string | undefined {
  if (!l) return undefined;
  return (lang.startsWith('en') ? l.en : l.es) ?? l.en ?? l.es;
}

interface RowProps {
  meta: OptionMeta;
  value: Value;
  original: Value;
  onChange: (key: string, v: Value) => void;
  managed?: boolean;
  secret?: boolean;
  restartOnly?: boolean;
}

/** One option: label, badges, localized description and a control matching its type. */
export const OptionRow = memo(function OptionRow({ meta, value, original, onChange, managed, secret, restartOnly }: RowProps) {
  const { t, i18n } = useTranslation();
  const description = localized(meta.description, i18n.language);
  const changed = String(value) !== String(original);
  const set = (v: Value) => onChange(meta.key, v);
  const defaultLabel =
    meta.default === undefined
      ? null
      : meta.type === 'enum'
        ? localized(meta.options?.find((o) => String(o.value) === meta.default)?.label, i18n.language)
        : meta.default;

  let control;
  if (managed) {
    control = <Badge variant="outline" color="gray">{t('config.managed')}</Badge>;
  } else if (meta.type === 'boolean') {
    control = <Switch checked={value === true || value === 'true'} onChange={(e) => set(typeof original === 'string' ? String(e.currentTarget.checked) : e.currentTarget.checked)} aria-label={meta.key} />;
  } else if (meta.type === 'enum' && meta.options) {
    control = (
      <Select
        w={{ base: '100%', xs: 220 }}
        size="xs"
        data={meta.options.map((o) => ({ value: String(o.value), label: `${localized(o.label, i18n.language) ?? o.value}` }))}
        value={value === null ? null : String(value)}
        onChange={(v) => v !== null && set(typeof original === 'string' ? v : Number(v))}
        allowDeselect={false}
        aria-label={meta.key}
      />
    );
  } else if (meta.type === 'integer' || meta.type === 'decimal') {
    control = (
      <NumberInput
        w={160}
        size="xs"
        value={value === null || value === '' ? '' : Number(value)}
        min={meta.min}
        max={meta.max}
        step={meta.type === 'integer' ? 1 : 0.1}
        decimalScale={meta.type === 'integer' ? 0 : 4}
        allowDecimal={meta.type === 'decimal'}
        onChange={(v) => set(typeof original === 'string' ? String(v) : v === '' ? null : Number(v))}
        aria-label={meta.key}
      />
    );
  } else if (secret) {
    control = <PasswordInput w={{ base: '100%', xs: 260 }} size="xs" value={String(value ?? '')} onChange={(e) => set(e.currentTarget.value)} aria-label={meta.key} />;
  } else {
    control = <TextInput w={{ base: '100%', xs: 320 }} size="xs" value={String(value ?? '')} onChange={(e) => set(e.currentTarget.value.replace(/[\r\n]/g, ''))} aria-label={meta.key} />;
  }

  return (
    // On a phone the control drops below the text instead of squeezing it.
    <Group justify="space-between" align="flex-start" wrap="wrap" gap="xs" py={8} style={{ borderBottom: '1px solid var(--mantine-color-default-border)', background: changed ? 'var(--mantine-color-rust-light)' : undefined }} px={6}>
      <Stack gap={2} style={{ flex: '1 1 200px', minWidth: 0 }}>
        <Group gap={6}>
          <Tooltip label={meta.key} openDelay={400}>
            <Text size="sm" fw={500}>
              {humanize(meta.key)}
            </Text>
          </Tooltip>
          {restartOnly && (
            <Badge size="xs" variant="light" color="orange">
              {t('config.restartOnly')}
            </Badge>
          )}
        </Group>
        {description && (
          <Text size="xs" c="dimmed">
            {description}
          </Text>
        )}
        {defaultLabel !== null && defaultLabel !== undefined && !managed && (
          <Text size="xs" c="dimmed" fs="italic">
            {t('config.defaultValue', { value: defaultLabel })}
          </Text>
        )}
      </Stack>
      {control}
    </Group>
  );
});
