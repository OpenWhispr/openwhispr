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

export interface UiLanguageOption {
  value: UiLanguage;
  label: string;
  flag: string;
}

type UiLanguageMetadata = Omit<UiLanguageOption, "value">;

const UI_LANGUAGE_METADATA = {
  en: { label: "English", flag: "🇺🇸" },
  es: { label: "Español", flag: "🇪🇸" },
  fr: { label: "Français", flag: "🇫🇷" },
  de: { label: "Deutsch", flag: "🇩🇪" },
  pt: { label: "Português", flag: "🇵🇹" },
  it: { label: "Italiano", flag: "🇮🇹" },
  ru: { label: "Русский", flag: "🇷🇺" },
  ja: { label: "日本語", flag: "🇯🇵" },
  "zh-CN": { label: "简体中文", flag: "🇨🇳" },
  "zh-TW": { label: "繁體中文", flag: "🇹🇼" },
} satisfies Record<UiLanguage, UiLanguageMetadata>;

export const UI_LANGUAGE_OPTIONS: UiLanguageOption[] = SUPPORTED_UI_LANGUAGES.map((value) => ({
  value,
  ...UI_LANGUAGE_METADATA[value],
}));
