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

/** The plan's languages as one list ("English and German"), in the UI language. */
export function localSetupLanguageLabel(languages: string[], i18nLanguage: string): string {
  const labels = languages.map((code) => {
    // The plan holds base codes; the list keys some languages by region ("en-US").
    const entry =
      getOnboardingLanguageByCode(code) ??
      languageRegistry.languages.find((language) => language.code.split("-")[0] === code);
    return entry ? displayOnboardingLanguageLabel(entry) : code;
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
