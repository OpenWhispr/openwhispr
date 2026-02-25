import promptData from "./promptData.json";
import i18n, { normalizeUiLanguage } from "../i18n";
import { en as enPrompts, type PromptBundle } from "../locales/prompts";
import { getLanguageInstruction } from "../utils/languageSupport";
import type { AppContext } from "../types/electron";

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

export function getSystemPrompt(
  agentName: string | null,
  customDictionary?: string[],
  language?: string,
  transcript?: string,
  uiLanguage?: string,
  appContext?: AppContext | null
): string {
  const name = agentName?.trim() || "Assistant";
  const prompts = getPromptBundle(uiLanguage);

  let promptTemplate: string | null = null;
  if (typeof window !== "undefined" && window.localStorage) {
    const customPrompt = window.localStorage.getItem("customUnifiedPrompt");
    if (customPrompt) {
      try {
        promptTemplate = JSON.parse(customPrompt);
      } catch {
        // Use default if parsing fails
      }
    }
  }

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

  const langInstruction = getLanguageInstruction(language);
  if (langInstruction) {
    prompt += "\n\n" + langInstruction;
  }

  if (appContext?.appName) {
    let contextSection = `\nContext (the user is currently working in):\nApp: ${appContext.appName}`;
    if (appContext.fileName) {
      contextSection += `\nFile: ${appContext.fileName}`;
    }
    prompt += "\n" + contextSection;
  }

  if (customDictionary && customDictionary.length > 0) {
    prompt += prompts.dictionarySuffix + customDictionary.join(", ");
  }

  return prompt;
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
  getWordBoost,
  LEGACY_PROMPTS,
};
