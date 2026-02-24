import promptData from "./promptData.json";
import i18n, { normalizeUiLanguage } from "../i18n";
import { en as enPrompts, type PromptBundle } from "../locales/prompts";
import { getLanguageInstruction } from "../utils/languageSupport";
import type { DictationMode } from "../types/hotkeyBindings";

export const CLEANUP_PROMPT = promptData.CLEANUP_PROMPT;
export const FULL_PROMPT = promptData.FULL_PROMPT;
/** @deprecated Use FULL_PROMPT instead — kept for PromptStudio backwards compat */
export const UNIFIED_SYSTEM_PROMPT = promptData.FULL_PROMPT;
export const LEGACY_PROMPTS = promptData.LEGACY_PROMPTS;

function getPromptBundle(uiLanguage?: string): PromptBundle {
  const locale = normalizeUiLanguage(uiLanguage || "en");
  const t = i18n.getFixedT(locale, "prompts");

  return {
    cleanupPrompt: t("cleanupPrompt", { defaultValue: enPrompts.cleanupPrompt }),
    fullPrompt: t("fullPrompt", { defaultValue: enPrompts.fullPrompt }),
    dictionarySuffix: t("dictionarySuffix", { defaultValue: enPrompts.dictionarySuffix }),
  };
}

function detectAgentName(transcript: string, agentName: string): boolean {
  const lower = transcript.toLowerCase();
  const name = agentName.toLowerCase();

  if (lower.includes(name)) return true;

  const variants: string[] = [];

  return variants.some((v) => lower.includes(v));
}

function getCustomPromptTemplate(): string | null {
  if (typeof window !== "undefined" && window.localStorage) {
    const customPrompt = window.localStorage.getItem("customUnifiedPrompt");
    if (customPrompt) {
      try {
        return JSON.parse(customPrompt) as string;
      } catch {
        // Use default if parsing fails
      }
    }
  }
  return null;
}

function applyPromptSuffix(
  prompt: string,
  prompts: PromptBundle,
  language?: string,
  customDictionary?: string[]
): string {
  let result = prompt;

  const langInstruction = getLanguageInstruction(language);
  if (langInstruction) {
    result += "\n\n" + langInstruction;
  }

  if (customDictionary && customDictionary.length > 0) {
    result += prompts.dictionarySuffix + customDictionary.join(", ");
  }

  return result;
}

export function getSystemPrompt(
  agentName: string | null,
  customDictionary?: string[],
  language?: string,
  transcript?: string,
  uiLanguage?: string
): string {
  const name = agentName?.trim() || "Assistant";
  const prompts = getPromptBundle(uiLanguage);

  const promptTemplate = getCustomPromptTemplate();

  let prompt: string;
  if (promptTemplate) {
    prompt = promptTemplate.replace(/\{\{agentName\}\}/g, name);
  } else {
    const useFullPrompt = !transcript || detectAgentName(transcript, name);
    prompt = (useFullPrompt ? prompts.fullPrompt : prompts.cleanupPrompt).replace(
      /\{\{agentName\}\}/g,
      name
    );
  }

  return applyPromptSuffix(prompt, prompts, language, customDictionary);
}

/**
 * Returns the cleanup-only prompt (no agent detection / MODE 2).
 * Used when the hotkey binding is explicitly set to "transcription" mode.
 */
export function getTranscriptionPrompt(
  customDictionary?: string[],
  language?: string,
  uiLanguage?: string
): string {
  const prompts = getPromptBundle(uiLanguage);
  const promptTemplate = getCustomPromptTemplate();

  const prompt = promptTemplate
    ? promptTemplate.replace(/\{\{agentName\}\}/g, "Assistant")
    : prompts.cleanupPrompt;

  return applyPromptSuffix(prompt, prompts, language, customDictionary);
}

/**
 * Returns the full agent prompt (cleanup + agent MODE 2).
 * Used when the hotkey binding is explicitly set to "agent" mode.
 */
export function getAgentPrompt(
  agentName: string,
  customDictionary?: string[],
  language?: string,
  uiLanguage?: string
): string {
  const name = agentName?.trim() || "Assistant";
  const prompts = getPromptBundle(uiLanguage);
  const promptTemplate = getCustomPromptTemplate();

  const prompt = (promptTemplate || prompts.fullPrompt).replace(/\{\{agentName\}\}/g, name);

  return applyPromptSuffix(prompt, prompts, language, customDictionary);
}

export function getSystemPromptForMode(
  agentName: string | null,
  dictationMode: DictationMode | undefined,
  customDictionary?: string[],
  language?: string,
  transcript?: string,
  uiLanguage?: string
): string {
  if (dictationMode === "transcription") {
    return getTranscriptionPrompt(customDictionary, language, uiLanguage);
  }
  if (dictationMode === "agent") {
    return getAgentPrompt(agentName || "Assistant", customDictionary, language, uiLanguage);
  }
  // Fallback: legacy auto-detect behavior
  return getSystemPrompt(agentName, customDictionary, language, transcript, uiLanguage);
}

export function getWordBoost(customDictionary?: string[]): string[] {
  if (!customDictionary || customDictionary.length === 0) return [];
  return customDictionary.filter((w) => w.trim());
}

export default {
  CLEANUP_PROMPT,
  FULL_PROMPT,
  UNIFIED_SYSTEM_PROMPT,
  getSystemPrompt,
  getTranscriptionPrompt,
  getAgentPrompt,
  getSystemPromptForMode,
  getWordBoost,
  LEGACY_PROMPTS,
};
