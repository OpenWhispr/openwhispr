import UI_LANGUAGE_CODES from "./uiLanguageCodes.json";

export type UiLanguage = keyof typeof UI_LANGUAGE_CODES;

export const SUPPORTED_UI_LANGUAGES: readonly UiLanguage[] = Object.keys(
  UI_LANGUAGE_CODES
) as UiLanguage[];

export interface UiLanguageOption {
  value: UiLanguage;
  label: string;
  flag: string;
}

type UiLanguageMetadata = Omit<UiLanguageOption, "value">;

const UI_LANGUAGE_METADATA = {
  en: { label: "English", flag: "🇺🇸" },
  ar: { label: "العربية", flag: "🇦🇪" },
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
