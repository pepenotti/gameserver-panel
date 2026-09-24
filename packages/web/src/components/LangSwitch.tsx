import { SegmentedControl } from '@mantine/core';
import { useTranslation } from 'react-i18next';
import { put } from '../api/http';
import { useSession } from '../api/session';
import type { Lang } from '../api/types';
import { setLang } from '../i18n';

/** Switches the UI language instantly and remembers it on the account. */
export function LangSwitch({ size = 'xs' }: { size?: 'xs' | 'sm' }) {
  const { i18n } = useTranslation();
  const { session, refresh } = useSession();
  return (
    <SegmentedControl
      size={size}
      value={i18n.language.startsWith('en') ? 'en' : 'es'}
      data={[
        { value: 'es', label: 'ES' },
        { value: 'en', label: 'EN' },
      ]}
      onChange={(v) => {
        setLang(v as Lang);
        if (session) void put('/api/me', { lang: v }).then(refresh, () => undefined);
      }}
      aria-label="Language / Idioma"
    />
  );
}
