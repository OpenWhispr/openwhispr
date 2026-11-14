import { SUPPORTED_UI_LANGUAGES } from "../../i18n";
import { NOTE_SUMMARY_LANGUAGE_AUTO, noteLanguageName } from "../../helpers/noteOutputLanguage";

/**
 * The languages the template picker offers for one run: automatic, the UI
 * languages, and the setting's language when it is none of those.
 */
export function summaryLanguageChoices(settingChoice: string): string[] {
  const codes: string[] = [...SUPPORTED_UI_LANGUAGES];
  if (
    settingChoice !== NOTE_SUMMARY_LANGUAGE_AUTO &&
    noteLanguageName(settingChoice) &&
    !codes.includes(settingChoice)
  ) {
    codes.push(settingChoice);
  }
  return [NOTE_SUMMARY_LANGUAGE_AUTO, ...codes];
}

/** A language's name in the interface language, falling back to its English name. */
export function summaryLanguageLabel(code: string, locale: string, autoLabel: string): string {
  if (code === NOTE_SUMMARY_LANGUAGE_AUTO) return autoLabel;
  try {
    const name = new Intl.DisplayNames([locale], { type: "language" }).of(code);
    if (name && name !== code) return name.charAt(0).toLocaleUpperCase(locale) + name.slice(1);
  } catch {
    // An engine without the locale's data names it in English below.
  }
  return noteLanguageName(code) ?? code;
}
