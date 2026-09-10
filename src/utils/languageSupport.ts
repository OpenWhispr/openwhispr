import registry from "../config/languageRegistry.json" with { type: "json" };

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
  if (typeof language !== "string") return undefined;
  const trimmed = language.trim().replace(/_/g, "-");
  if (!trimmed || trimmed.toLowerCase() === "auto") return undefined;
  const base = trimmed.split("-")[0].toLowerCase();
  return base || undefined;
}

export function getLanguageInstruction(language: string | undefined): string {
  if (!language) return "";
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

export { WHISPER_LANGUAGES, ASSEMBLYAI_UNIVERSAL3_PRO_LANGUAGES };
