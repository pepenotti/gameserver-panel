import { useTranslation } from 'react-i18next';
import { ApiError } from '../api/http';

/** Turn any thrown error into a translated, user-facing sentence. */
export function useErrorText(): (e: unknown) => string {
  const { t, i18n } = useTranslation();
  return (e: unknown) => {
    if (e instanceof ApiError) {
      const key = `errors.${e.code}`;
      if (i18n.exists(key)) {
        const ms = typeof e.extra.retryAfterMs === 'number' ? e.extra.retryAfterMs : 0;
        return t(key, { seconds: Math.ceil(ms / 1000) });
      }
      if (typeof e.extra.message === 'string') return e.extra.message;
    }
    return t('errors.generic');
  };
}

export function formatBytes(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return '—';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(v >= 100 || i === 0 ? 0 : 1)} ${units[i]}`;
}

/** "3 h 12 min"-style duration in the current language. */
export function useDuration(): (ms: number) => string {
  const { t } = useTranslation();
  return (ms: number) => {
    const s = Math.max(0, Math.floor(ms / 1000));
    if (s < 60) return t('time.seconds', { n: s });
    const m = Math.floor(s / 60);
    if (m < 60) return t('time.minutes', { n: m });
    const h = Math.floor(m / 60);
    if (h < 48) return `${t('time.hours', { n: h })} ${t('time.minutes', { n: m % 60 })}`;
    return `${t('time.days', { n: Math.floor(h / 24) })} ${t('time.hours', { n: h % 24 })}`;
  };
}

export function useRelative(): (iso: string | null | undefined) => string {
  const { t } = useTranslation();
  const dur = useDuration();
  return (iso) => (iso ? t('time.ago', { what: dur(Date.now() - new Date(iso).getTime()) }) : t('common.never'));
}

export function formatDateTime(iso: string, lang: string, seconds = true): string {
  return new Date(iso).toLocaleString(lang === 'es' ? 'es-AR' : 'en-GB', { dateStyle: 'short', timeStyle: seconds ? 'medium' : 'short' });
}
