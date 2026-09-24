import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import { en } from './en';
import { es } from './es';

export type Lang = 'en' | 'es';

const STORAGE_KEY = 'gsp-lang';
/** Where earlier versions kept the choice; read once so it survives the rename. */
const OLD_STORAGE_KEY = 'pz-lang';

function initialLang(): Lang {
  try {
    const saved = localStorage.getItem(STORAGE_KEY) ?? localStorage.getItem(OLD_STORAGE_KEY);
    if (saved === 'en' || saved === 'es') return saved;
  } catch {
    // storage blocked: fall through
  }
  return navigator.language.toLowerCase().startsWith('en') ? 'en' : 'es';
}

void i18n.use(initReactI18next).init({
  resources: { en: { translation: en }, es: { translation: es } },
  lng: initialLang(),
  fallbackLng: 'en',
  interpolation: { escapeValue: false },
  returnNull: false,
});

export function setLang(lang: Lang): void {
  void i18n.changeLanguage(lang);
  document.documentElement.lang = lang;
  try {
    localStorage.setItem(STORAGE_KEY, lang);
  } catch {
    // ignore
  }
}

document.documentElement.lang = i18n.language;
export default i18n;
