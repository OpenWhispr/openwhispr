import { useTranslation } from "react-i18next";

// The active UI locale for Intl formatting, e.g. toLocaleDateString.
export function useUiLocale(): string {
  const { i18n } = useTranslation();
  return i18n.resolvedLanguage ?? i18n.language;
}
