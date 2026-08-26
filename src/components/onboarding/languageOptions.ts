import registry from "../../config/languageRegistry.json";

const NATIVE_LABELS: Record<string, string> = {
  ar: "العربية",
  de: "Deutsch",
  "en-US": "English",
  "en-GB": "English (UK)",
  es: "Español",
  fr: "Français",
  hi: "हिन्दी",
  it: "Italiano",
  ja: "日本語",
  ko: "한국어",
  pt: "Português",
  ru: "Русский",
  "zh-CN": "简体中文",
  "zh-TW": "繁體中文",
};

const LANGUAGE_LABELS: Record<string, string> = {
  "en-US": "English",
  "zh-CN": "Chinese - Simplified",
  "zh-TW": "Chinese - Traditional",
};

const SEARCH_ALIASES: Record<string, string> = {
  hi: "hind hindustani",
};

const PRIMARY_LANGUAGE_CODES = ["en-US", "zh-CN", "es", "ar", "af"];

export type OnboardingLanguage = (typeof registry.languages)[number];

export const displayOnboardingLanguageLabel = (language: OnboardingLanguage) =>
  LANGUAGE_LABELS[language.code] ?? language.label;

export const getOnboardingLanguageNativeLabel = (language: OnboardingLanguage) =>
  NATIVE_LABELS[language.code] ?? displayOnboardingLanguageLabel(language);

export const getOnboardingLanguageByCode = (code: string) =>
  registry.languages.find((language) => language.code === code);

const orderedLanguages = registry.languages
  .filter(({ code }) => code !== "auto")
  .sort((left, right) => {
    const leftIndex = PRIMARY_LANGUAGE_CODES.indexOf(left.code);
    const rightIndex = PRIMARY_LANGUAGE_CODES.indexOf(right.code);
    if (leftIndex === -1 && rightIndex === -1) return left.label.localeCompare(right.label);
    if (leftIndex === -1) return 1;
    if (rightIndex === -1) return -1;
    return leftIndex - rightIndex;
  });

export function getOnboardingLanguageOptions(query: string, selected: string[]) {
  const normalized = query.trim().toLocaleLowerCase();
  if (!normalized) return orderedLanguages;

  const matching = orderedLanguages.filter((language) =>
    [
      language.code,
      language.label,
      displayOnboardingLanguageLabel(language),
      NATIVE_LABELS[language.code],
      SEARCH_ALIASES[language.code],
    ]
      .filter(Boolean)
      .some((value) => value?.toLocaleLowerCase().includes(normalized))
  );
  const pinned = orderedLanguages.filter(
    ({ code }) => selected.includes(code) && !matching.some((language) => language.code === code)
  );
  return [...pinned, ...matching];
}
