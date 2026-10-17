import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import { AppState } from 'react-native';
import en from '../locales/en/translation.json';
import es from '../locales/es/translation.json';
import fr from '../locales/fr/translation.json';
import de from '../locales/de/translation.json';
import pt from '../locales/pt/translation.json';
import it from '../locales/it/translation.json';
import ru from '../locales/ru/translation.json';
import zhCN from '../locales/zh-CN/translation.json';
import zhTW from '../locales/zh-TW/translation.json';
import ja from '../locales/ja/translation.json';
import ar from '../locales/ar/translation.json';
import { AndroidDictation } from '../../modules/android-dictation/src';

export const androidEnglish = en.android;
const resources = { en, es, fr, de, pt, it, ru, 'zh-CN': zhCN, 'zh-TW': zhTW, ja, ar };
function deviceLanguage(): string {
  const locale = (AndroidDictation?.getLocale?.() ?? 'en').replaceAll('_', '-').toLowerCase();
  if (locale.startsWith('zh')) return /hant|tw|hk|mo/.test(locale) ? 'zh-TW' : 'zh-CN';
  const language = locale.split('-')[0];
  return language in resources ? language : 'en';
}
if (!i18n.isInitialized)
  i18n.use(initReactI18next).init({
    lng: deviceLanguage(),
    fallbackLng: 'en',
    interpolation: { escapeValue: false },
    resources,
    defaultNS: 'android',
  });

export function observeAndroidLanguage(): () => void {
  const refresh = () => {
    const language = deviceLanguage();
    if (i18n.language !== language) i18n.changeLanguage(language).catch(() => undefined);
  };
  refresh();
  const subscription = AppState.addEventListener('change', (state) => {
    if (state === 'active') refresh();
  });
  return () => subscription.remove();
}
export default i18n;
