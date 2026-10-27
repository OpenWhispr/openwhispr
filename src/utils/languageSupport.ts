import registry from "../config/languageRegistry.json";
import type { LayoutProbeResult } from "../types/electron";
import { isKeyboardLayoutLanguage } from "./keyboardLayoutLanguage.ts";

function buildLanguageSet(key: "whisper" | "assemblyai"): Set<string> {
  const set = new Set<string>();
  for (const lang of registry.languages) {
    if (lang[key]) {
      set.add(lang.code);
      const base = lang.code.split("-")[0];
      if (base !== lang.code) set.add(base);
    }
  }
  return set;
}

const WHISPER_LANGUAGES = buildLanguageSet("whisper");
const ASSEMBLYAI_UNIVERSAL3_PRO_LANGUAGES = buildLanguageSet("assemblyai");

const LANGUAGE_INSTRUCTIONS: Record<string, string> = Object.fromEntries(
  registry.languages
    .filter(
      (l): l is typeof l & { instruction: string } =>
        "instruction" in l && typeof l.instruction === "string"
    )
    .map((l) => [l.code, l.instruction])
);

export function getBaseLanguageCode(language: string | null | undefined): string | undefined {
  if (!language || language === "auto" || isKeyboardLayoutLanguage(language)) return undefined;
  return language.split("-")[0];
}

export function getLanguageInstruction(language: string | undefined): string {
  if (!language) return "";
  if (isKeyboardLayoutLanguage(language)) language = "auto";
  return LANGUAGE_INSTRUCTIONS[language] || buildGenericInstruction(language);
}

function buildGenericInstruction(langCode: string): string {
  const template = registry._genericTemplate || "";
  return template.replace("{{code}}", langCode);
}

export function getLanguageLabel(code: string | null | undefined): string {
  if (!code) return "";
  const entry = registry.languages.find((l) => l.code === code);
  return entry?.label ?? code;
}

export type LayoutLanguageNotice =
  { kind: "undetected" } | { kind: "unsupported"; layoutName: string };

// Language of one dictation in "By keyboard layout" mode. A failed or unsupported
// layout still transcribes, with "auto" — never with the language picked earlier
// in the list — and says why through `notice`.
export function resolveLayoutLanguage(probe: LayoutProbeResult): {
  language: string;
  notice: LayoutLanguageNotice | null;
} {
  if (!probe.ok) return { language: "auto", notice: { kind: "undetected" } };

  const language = probe.iso.toLowerCase();
  if (!WHISPER_LANGUAGES.has(language)) {
    return { language: "auto", notice: { kind: "unsupported", layoutName: probe.layoutName } };
  }
  return { language, notice: null };
}

export { WHISPER_LANGUAGES, ASSEMBLYAI_UNIVERSAL3_PRO_LANGUAGES };
