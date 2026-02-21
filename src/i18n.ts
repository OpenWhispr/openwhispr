import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import { PROMPTS_BY_LOCALE } from "./locales/prompts";
import { TRANSLATIONS_BY_LOCALE } from "./locales/translations";

export const SUPPORTED_UI_LANGUAGES = [
  "en",
  "es",
  "fr",
  "de",
  "pt",
  "it",
  "ru",
  "ja",
  "zh-CN",
  "zh-TW",
] as const;
export type UiLanguage = (typeof SUPPORTED_UI_LANGUAGES)[number];

export function normalizeUiLanguage(language: string | null | undefined): UiLanguage {
  const candidate = (language || "").trim();

  // Check full language-region code first (e.g. "zh-CN", "zh-TW")
  const normalized = candidate.replace("_", "-");
  const fullMatch = SUPPORTED_UI_LANGUAGES.find(
    (lang) => lang.toLowerCase() === normalized.toLowerCase()
  );
  if (fullMatch) return fullMatch;

  // Fall back to base language code (e.g. "en" from "en-US")
  const base = candidate.split("-")[0].split("_")[0].toLowerCase() as UiLanguage;
  if (SUPPORTED_UI_LANGUAGES.includes(base)) {
    return base;
  }

  return "en";
}

const resources = {
  en: {
    translation: TRANSLATIONS_BY_LOCALE.en,
    prompts: PROMPTS_BY_LOCALE.en,
  },
  es: {
    translation: TRANSLATIONS_BY_LOCALE.es,
    prompts: PROMPTS_BY_LOCALE.es,
  },
  fr: {
    translation: TRANSLATIONS_BY_LOCALE.fr,
    prompts: PROMPTS_BY_LOCALE.fr,
  },
  de: {
    translation: TRANSLATIONS_BY_LOCALE.de,
    prompts: PROMPTS_BY_LOCALE.de,
  },
  pt: {
    translation: TRANSLATIONS_BY_LOCALE.pt,
    prompts: PROMPTS_BY_LOCALE.pt,
  },
  it: {
    translation: TRANSLATIONS_BY_LOCALE.it,
    prompts: PROMPTS_BY_LOCALE.it,
  },
  ru: {
    translation: TRANSLATIONS_BY_LOCALE.ru,
    prompts: PROMPTS_BY_LOCALE.ru,
  },
  ja: {
    translation: TRANSLATIONS_BY_LOCALE.ja,
    prompts: PROMPTS_BY_LOCALE.ja,
  },
  "zh-CN": {
    translation: TRANSLATIONS_BY_LOCALE["zh-CN"],
    prompts: PROMPTS_BY_LOCALE["zh-CN"],
  },
  "zh-TW": {
    translation: TRANSLATIONS_BY_LOCALE["zh-TW"],
    prompts: PROMPTS_BY_LOCALE["zh-TW"],
  },
} as const;

const browserLanguage =
  typeof navigator !== "undefined" ? navigator.language || navigator.languages?.[0] : undefined;

const storageLanguage =
  typeof window !== "undefined" ? window.localStorage.getItem("uiLanguage") : undefined;

const initialLanguage = normalizeUiLanguage(storageLanguage || browserLanguage || "en");

void i18n.use(initReactI18next).init({
  resources,
  lng: initialLanguage,
  fallbackLng: "en",
  ns: ["translation", "prompts"],
  defaultNS: "translation",
  interpolation: {
    escapeValue: false,
  },
  returnEmptyString: true,
  returnNull: false,
});

export default i18n;
