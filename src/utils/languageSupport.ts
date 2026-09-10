import registry from "../config/languageRegistry.json";

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

const ORTHOGRAPHY_INSTRUCTIONS: Record<string, string> = Object.fromEntries(
  registry.languages
    .filter(
      (l): l is typeof l & { orthographyInstruction: string } =>
        "orthographyInstruction" in l && typeof l.orthographyInstruction === "string"
    )
    .map((l) => [l.code, l.orthographyInstruction])
);

export function getBaseLanguageCode(language: string | null | undefined): string | undefined {
  if (!language || language === "auto") return undefined;
  return language.split("-")[0];
}

export function getLanguageInstruction(language: string | undefined): string {
  if (!language) return "";
  const orthographyInstruction = ORTHOGRAPHY_INSTRUCTIONS[language];
  return [registry._genericTemplate, orthographyInstruction].filter(Boolean).join(" ");
}

export function getLanguageLabel(code: string | null | undefined): string {
  if (!code) return "";
  const entry = registry.languages.find((l) => l.code === code);
  return entry?.label ?? code;
}

export { WHISPER_LANGUAGES, ASSEMBLYAI_UNIVERSAL3_PRO_LANGUAGES };
