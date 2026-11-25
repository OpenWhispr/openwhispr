import registry from "../config/languageRegistry.json" with { type: "json" };

export const DEFAULT_OPENAI_REALTIME_MODEL = "gpt-4o-mini-transcribe";

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
  if (!language || language === "auto") return undefined;
  return language.split("-")[0];
}

export function getWhisperLanguageHint(language: string | null | undefined): string | undefined {
  if (!language) return undefined;
  const base = language.split("-")[0];
  // The picker also lists cloud-only languages and omits some valid Whisper codes.
  const preference = registry.languages.find((entry) => entry.code === base);
  return preference?.whisper === false ? undefined : language;
}

// A registry entry with `sttProviders` names the only cloud providers that take its
// code (the Indian languages only Sarvam transcribes). Any other provider leaves
// the hint out and detects the language. Meeting providers carry a -realtime suffix.
export function getProviderLanguageHint(
  provider: string | null | undefined,
  language: string | undefined
): string | undefined {
  if (!language) return language;
  const base = language.split("-")[0];
  const entry = registry.languages.find((candidate) => candidate.code === base);
  if (!entry || !("sttProviders" in entry)) return language;
  const id = provider?.replace(/-realtime$/, "");
  return id && entry.sttProviders.includes(id) ? language : undefined;
}

export function getHostedTranscriptionLanguageHint(
  model: string | undefined,
  language: string | undefined
): string | undefined {
  if (model && /(?:^|\/)whisper-/.test(model)) return getWhisperLanguageHint(language);
  if (model && /(?:^|\/)gpt-4o-(?:mini-)?transcribe(?:-|$)/.test(model)) {
    // GPT-4o's singular language field expects ISO 639-1. Several languages
    // offered for Sarvam only have three-letter codes, so leave detection on.
    const base = getBaseLanguageCode(getWhisperLanguageHint(language));
    return base && /^[a-z]{2}$/i.test(base) ? base.toLowerCase() : undefined;
  }
  // gpt-transcribe refuses a code it doesn't know rather than detecting the language.
  if (model && /(?:^|\/)gpt-transcribe(?:-|$)/.test(model)) return getWhisperLanguageHint(language);
  return language;
}

// OpenWhispr Cloud's default chain is OpenAI's gpt-transcribe, so the languages
// only Sarvam transcribes are left out and the model detects the language itself.
export function getCloudTranscriptionLanguageHint(
  language: string | null | undefined
): string | undefined {
  return getBaseLanguageCode(getWhisperLanguageHint(language));
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
