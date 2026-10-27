import modelRegistryData from "../models/modelRegistryData.json";
import { getLanguageLabel } from "./languageSupport";

// Whether a local sherpa model (Parakeet, Nemotron, Cohere, Orukeet) can
// transcribe the languages the user dictates in. Without this the app would
// run an English-only model on French speech and silently return English.
// Whisper has no per-model list (every model covers the same ~99 languages),
// so it never reports a gap.

interface SherpaModelEntry {
  name: string;
  supportedLanguages?: string[];
  modelType?: string;
}

const SHERPA_MODELS = modelRegistryData.parakeetModels as Record<string, SherpaModelEntry>;

export interface LocalModelLanguageFit {
  /** Base codes of dictation languages the model can't transcribe at all. */
  unsupported: string[];
  /**
   * Base codes the model supports but won't detect on its own: with the
   * dictation language on auto it transcribes English (see
   * resolveModelLanguage in src/helpers/parakeetModelInfo.js).
   */
  needsExplicitLanguage: string[];
}

interface LanguageFitInput {
  modelId: string | null | undefined;
  preferredLanguage: string | null | undefined;
  spokenLanguages?: readonly string[] | null;
}

function toBaseCode(code: string): string {
  return code.trim().replace(/_/g, "-").split("-")[0].toLowerCase();
}

// Cohere Transcribe is started for exactly one language and has no detection.
function detectsLanguage(model: SherpaModelEntry): boolean {
  return model.modelType !== "cohere-transcribe";
}

export function getModelSupportedLanguages(modelId: string | null | undefined): string[] | null {
  if (!modelId) return null;
  return SHERPA_MODELS[modelId]?.supportedLanguages ?? null;
}

/** The one language a single-language model transcribes, e.g. "en". */
export function getModelOnlyLanguage(modelId: string | null | undefined): string | null {
  const supported = getModelSupportedLanguages(modelId);
  return supported?.length === 1 ? supported[0] : null;
}

/**
 * An explicit dictation language is the one checked; on auto, the languages
 * the user said they speak during onboarding are. Null when the model handles
 * all of them, or when it isn't a sherpa model.
 */
export function getLocalModelLanguageFit({
  modelId,
  preferredLanguage,
  spokenLanguages,
}: LanguageFitInput): LocalModelLanguageFit | null {
  const model = modelId ? SHERPA_MODELS[modelId] : undefined;
  if (!model?.supportedLanguages?.length) return null;

  const isAuto = !preferredLanguage || preferredLanguage === "auto";
  const dictated = isAuto ? (spokenLanguages ?? []) : [preferredLanguage];
  const bases = [
    ...new Set(dictated.filter((code) => code && code !== "auto").map(toBaseCode)),
  ].filter(Boolean);

  const supported = new Set(model.supportedLanguages);
  const unsupported = bases.filter((base) => !supported.has(base));
  const needsExplicitLanguage =
    isAuto && !detectsLanguage(model)
      ? bases.filter((base) => supported.has(base) && base !== "en")
      : [];

  if (unsupported.length === 0 && needsExplicitLanguage.length === 0) return null;
  return { unsupported, needsExplicitLanguage };
}

function displayName(code: string, locale: string | undefined): string {
  try {
    const name = new Intl.DisplayNames(locale ? [locale] : undefined, { type: "language" }).of(
      code
    );
    if (name && name !== code) return name;
  } catch {
    // An unknown locale or code falls back to the registry's English label.
  }
  return getLanguageLabel(code);
}

export function formatLanguageNames(
  codes: readonly string[],
  locale: string | undefined,
  type: "conjunction" | "disjunction" = "disjunction"
): string {
  const names = codes.map((code) => displayName(code, locale));
  try {
    return new Intl.ListFormat(locale ? [locale] : undefined, { type }).format(names);
  } catch {
    return names.join(", ");
  }
}

type Translate = (key: string, params?: Record<string, string>) => string;

/** "English only" for a single-language model, else null. */
export function describeModelOnlyLanguage(
  modelId: string | null | undefined,
  { t, locale }: { t: Translate; locale?: string }
): string | null {
  const only = getModelOnlyLanguage(modelId);
  return only ? t("transcription.languageFit.only", { language: displayName(only, locale) }) : null;
}

/**
 * The note for a model card ("card") or for the transcription language row in
 * Settings ("settings", which names the model). Unsupported languages win: the
 * fix there is another model, not a language setting.
 */
export function describeLocalModelLanguageFit(
  fit: LocalModelLanguageFit | null,
  {
    surface,
    t,
    locale,
    modelName,
  }: { surface: "card" | "settings"; t: Translate; locale?: string; modelName?: string }
): string | null {
  if (!fit) return null;
  const model = modelName ?? "";
  if (fit.unsupported.length > 0) {
    return t(`transcription.languageFit.${surface}.unsupported`, {
      languages: formatLanguageNames(fit.unsupported, locale),
      model,
    });
  }
  return t(`transcription.languageFit.${surface}.needsLanguage`, {
    languages: formatLanguageNames(fit.needsExplicitLanguage, locale),
    model,
  });
}

/** Model name from the registry, for the Settings note. */
export function getLocalModelName(modelId: string | null | undefined): string | undefined {
  return modelId ? SHERPA_MODELS[modelId]?.name : undefined;
}
