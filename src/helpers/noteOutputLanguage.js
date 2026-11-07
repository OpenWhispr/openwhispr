// The language a note's AI summary is written in. "auto" lets the model take it
// from the material. The templates' section headings are English and pull the
// reply into English: with thinking off, as local models run, Gemma 4 E4B kept
// them English until the line called them placeholders to translate.

import registry from "../config/languageRegistry.json" with { type: "json" };
import { NOTHING_TO_SUMMARIZE } from "./builtinActions.js";

export const NOTE_SUMMARY_LANGUAGE_AUTO = "auto";

const LABEL_BY_CODE = new Map(registry.languages.map(({ code, label }) => [code, label]));

/** The registry's English name for a language code, or null when it has none. */
export function noteLanguageName(code) {
  const value = String(code ?? "").trim();
  if (!value || value === NOTE_SUMMARY_LANGUAGE_AUTO) return null;
  if (LABEL_BY_CODE.has(value)) return LABEL_BY_CODE.get(value);
  // UI languages are base codes ("en"), the registry lists regional English.
  const base = value.split("-")[0];
  if (LABEL_BY_CODE.has(base)) return LABEL_BY_CODE.get(base);
  if (base === "en") return "English";
  return null;
}

/** A run's own choice wins over the setting; an unknown code counts as automatic. */
export function resolveNoteSummaryLanguage(runChoice, settingChoice) {
  for (const choice of [runChoice, settingChoice]) {
    if (choice == null || choice === "") continue;
    return noteLanguageName(choice) ? choice : NOTE_SUMMARY_LANGUAGE_AUTO;
  }
  return NOTE_SUMMARY_LANGUAGE_AUTO;
}

/**
 * The OUTPUT LANGUAGE line appended to a note run's system prompt. The model
 * must return the no-content marker as is, or the runner would save a
 * translated marker as the summary.
 */
export function noteOutputLanguageInstruction(choice, uiLanguage) {
  const keepMarker = ` Reply ${NOTHING_TO_SUMMARIZE} exactly as written, never translated.`;
  const fixed = noteLanguageName(choice);
  if (fixed) {
    return `OUTPUT LANGUAGE: Write your entire output in ${fixed}, including the section headings, whatever language the material is in.${keepMarker}`;
  }
  const fallback = noteLanguageName(uiLanguage) ?? "English";
  return `OUTPUT LANGUAGE: Detect the language of the transcript, or of the notes when there is no transcript, and write your entire output in that language, including the section headings. The section headings above are English placeholders: translate every heading into that language. If the material has no clear language, write in ${fallback}.${keepMarker}`;
}
