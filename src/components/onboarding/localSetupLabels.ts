// Names the "We recommend these settings" page and card share: the computer,
// the languages the pick was made for, and the seconds a row quotes.
import { displayOnboardingLanguageLabel, getOnboardingLanguageByCode } from "./languageOptions";
import languageRegistry from "../../config/languageRegistry.json";
import type { ComputerProfile } from "../../types/electron";

/** The computer's name for the card and the subtitle; a generic one when it wasn't read. */
export function localSetupComputerName(
  profile: ComputerProfile,
  t: (key: string) => string
): string {
  if (profile.name) return profile.name;
  if (profile.platform === "darwin") return t("onboarding.rehaul.localSetup.computer.mac");
  const laptop = profile.formFactor === "laptop";
  if (profile.platform === "win32") {
    return laptop
      ? t("onboarding.rehaul.localSetup.computer.windowsLaptop")
      : t("onboarding.rehaul.localSetup.computer.windowsDesktop");
  }
  return laptop
    ? t("onboarding.rehaul.localSetup.computer.linuxLaptop")
    : t("onboarding.rehaul.localSetup.computer.linuxDesktop");
}

/** The plan's languages as one list ("Englisch und Deutsch"), named in the UI language. */
export function localSetupLanguageLabel(languageTags: string[], i18nLanguage: string): string {
  let names: Intl.DisplayNames | null = null;
  try {
    names = new Intl.DisplayNames([i18nLanguage], { type: "language", fallback: "none" });
  } catch {
    names = null;
  }
  const labels = languageTags.map((tag) => {
    const named = names?.of(tag);
    if (named) return named;
    // A code the runtime can't name falls back to the language list's English name.
    const base = tag.split("-")[0];
    const entry =
      getOnboardingLanguageByCode(tag) ??
      languageRegistry.languages.find((language) => language.code.split("-")[0] === base);
    return entry ? displayOnboardingLanguageLabel(entry) : tag;
  });
  try {
    return new Intl.ListFormat(i18nLanguage, { type: "conjunction" }).format(labels);
  } catch {
    return labels.join(", ");
  }
}

/** "2–3" for a range, or one whole number when both ends round to it. */
export function formatLocalSetupSeconds([low, high]: [number, number]): string {
  const from = Math.max(1, Math.round(low));
  const to = Math.max(1, Math.round(high));
  return from === to ? String(from) : `${from}–${to}`;
}
