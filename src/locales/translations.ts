import deTranslation from "./de/translation.json" with { type: "json" };
import enTranslation from "./en/translation.json" with { type: "json" };
import esTranslation from "./es/translation.json" with { type: "json" };
import frTranslation from "./fr/translation.json" with { type: "json" };
import itTranslation from "./it/translation.json" with { type: "json" };
import jaTranslation from "./ja/translation.json" with { type: "json" };
import ptTranslation from "./pt/translation.json" with { type: "json" };
import ruTranslation from "./ru/translation.json" with { type: "json" };
import zhCNTranslation from "./zh-CN/translation.json" with { type: "json" };
import zhTWTranslation from "./zh-TW/translation.json" with { type: "json" };

export const TRANSLATIONS_BY_LOCALE = {
  en: enTranslation,
  es: esTranslation,
  fr: frTranslation,
  de: deTranslation,
  pt: ptTranslation,
  it: itTranslation,
  ru: ruTranslation,
  ja: jaTranslation,
  "zh-CN": zhCNTranslation,
  "zh-TW": zhTWTranslation,
} as const;
