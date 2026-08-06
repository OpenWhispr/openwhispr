// Pure invariants for the preferred-language settings, shared by the settings
// store, the Settings page, and onboarding. The dictation panel switcher
// depends on them: the active language must always be inside the multi-select
// set, and "auto" (a detection mode, not a preset) never belongs in that set.
// Tested in test/helpers/languagePreferences.test.js.

/**
 * @typedef {Object} LanguagePreferences
 * @property {string} preferredLanguage
 * @property {string[]} preferredLanguages
 */

export const MAX_PREFERRED_LANGUAGES = 5;

/**
 * Drops "auto", blank and non-string entries, dedupes, and caps the list.
 *
 * @param {unknown} languages
 * @param {number} [max]
 * @returns {string[]}
 */
export function normalizePreferredLanguages(languages, max = MAX_PREFERRED_LANGUAGES) {
  const list = Array.isArray(languages) ? languages : [];
  return Array.from(
    new Set(list.filter((v) => typeof v === "string" && v.trim() && v !== "auto"))
  ).slice(0, max);
}

/**
 * Transition for changing the active language. Choosing "auto" drops the
 * multi-language set (auto is exclusive). Choosing a language missing from a
 * non-empty set inserts it — evicting the last preset when the set is full —
 * so the switcher always offers the active language. Returns the same
 * preferredLanguages reference when the set is unchanged.
 *
 * @param {{ preferredLanguage?: string, preferredLanguages?: string[] }} state
 * @param {string} value
 * @param {number} [max]
 * @returns {LanguagePreferences}
 */
export function resolveActiveLanguageChange(state, value, max = MAX_PREFERRED_LANGUAGES) {
  const languages = state.preferredLanguages ?? [];
  if (value === "auto") {
    return {
      preferredLanguage: "auto",
      preferredLanguages: languages.length === 0 ? languages : [],
    };
  }
  if (languages.length > 0 && !languages.includes(value)) {
    return {
      preferredLanguage: value,
      preferredLanguages: [...languages.slice(0, max - 1), value],
    };
  }
  return { preferredLanguage: value, preferredLanguages: languages };
}

/**
 * Transition for replacing the multi-select set; also repairs values persisted
 * before these rules existed (load path). If the active language falls outside
 * a non-empty set, the first preset becomes active.
 *
 * @param {{ preferredLanguage: string }} state
 * @param {unknown} values
 * @param {number} [max]
 * @returns {LanguagePreferences}
 */
export function resolveLanguageSetChange(state, values, max = MAX_PREFERRED_LANGUAGES) {
  const preferredLanguages = normalizePreferredLanguages(values, max);
  const active = state.preferredLanguage;
  const preferredLanguage =
    preferredLanguages.length > 0 && !preferredLanguages.includes(active)
      ? preferredLanguages[0]
      : active;
  return { preferredLanguage, preferredLanguages };
}

/**
 * A change coming from the multi-select language list: engaging auto detect
 * replaces the whole selection (it is exclusive), any other change updates the
 * preset list with auto filtered out. Returns a partial settings update.
 *
 * @param {string[]} currentValues
 * @param {string[]} nextValues
 * @returns {{ preferredLanguage: string, preferredLanguages?: undefined }
 *   | { preferredLanguages: string[], preferredLanguage?: undefined }}
 */
export function resolveLanguageSelection(currentValues, nextValues) {
  if (nextValues.includes("auto") && !currentValues.includes("auto")) {
    return { preferredLanguage: "auto" };
  }
  return { preferredLanguages: nextValues.filter((v) => v !== "auto") };
}
