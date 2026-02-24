import promptData from "./promptData.json";
import i18n, { normalizeUiLanguage } from "../i18n";
import { en as enPrompts, type PromptBundle } from "../locales/prompts";
import { getLanguageInstruction } from "../utils/languageSupport";

export const CLEANUP_PROMPT = promptData.CLEANUP_PROMPT;
export const FULL_PROMPT = promptData.FULL_PROMPT;
/** @deprecated Use FULL_PROMPT instead — kept for PromptStudio backwards compat */
export const UNIFIED_SYSTEM_PROMPT = promptData.FULL_PROMPT;
export const LEGACY_PROMPTS = promptData.LEGACY_PROMPTS;
export const PROMPT_MODES = {
  UNIFIED: "unified",
  AGENT_NORMAL: "agent_normal",
} as const;
export type PromptMode = (typeof PROMPT_MODES)[keyof typeof PROMPT_MODES];

const PROMPT_MODE_STORAGE_KEY = "promptMode";

type LegacyPromptConfig = {
  agent: string;
  regular: string;
};

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

function isPromptMode(value: unknown): value is PromptMode {
  return value === PROMPT_MODES.UNIFIED || value === PROMPT_MODES.AGENT_NORMAL;
}

function readJsonStorage<T>(key: string): T | null {
  if (typeof window === "undefined" || !window.localStorage) {
    return null;
  }

  const raw = window.localStorage.getItem(key);
  if (!raw) {
    return null;
  }

  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

function sanitizeLegacyPrompts(value: unknown): LegacyPromptConfig | null {
  if (!value || typeof value !== "object") {
    return null;
  }

  const parsed = value as { agent?: unknown; regular?: unknown };
  const hasAgent = typeof parsed.agent === "string";
  const hasRegular = typeof parsed.regular === "string";

  if (!hasAgent && !hasRegular) {
    return null;
  }

  return {
    agent: hasAgent ? (parsed.agent as string) : LEGACY_PROMPTS.agent,
    regular: hasRegular ? (parsed.regular as string) : LEGACY_PROMPTS.regular,
  };
}

function toLegacySystemPrompt(template: string, agentName: string): string {
  return template
    .replace(/\{\{agentName\}\}/g, agentName)
    .replace(/\n*\{\{text\}\}\s*$/i, "")
    .trim();
}

export function getPromptMode(): PromptMode {
  if (typeof window === "undefined" || !window.localStorage) {
    return PROMPT_MODES.UNIFIED;
  }

  const storedMode = window.localStorage.getItem(PROMPT_MODE_STORAGE_KEY);
  return isPromptMode(storedMode) ? storedMode : PROMPT_MODES.UNIFIED;
}

export function setPromptMode(mode: PromptMode): void {
  if (typeof window === "undefined" || !window.localStorage) {
    return;
  }
  window.localStorage.setItem(PROMPT_MODE_STORAGE_KEY, mode);
}

export function getCustomUnifiedPrompt(): string | null {
  const customPrompt = readJsonStorage<unknown>("customUnifiedPrompt");
  return typeof customPrompt === "string" ? customPrompt : null;
}

export function getCustomLegacyPrompts(): LegacyPromptConfig | null {
  return sanitizeLegacyPrompts(readJsonStorage<unknown>("customPrompts"));
}

export function getLegacyPrompts(): LegacyPromptConfig {
  const customPrompts = getCustomLegacyPrompts();
  if (!customPrompts) {
    return { ...LEGACY_PROMPTS };
  }

  return {
    agent: customPrompts.agent || LEGACY_PROMPTS.agent,
    regular: customPrompts.regular || LEGACY_PROMPTS.regular,
  };
}

export function hasCustomLegacyPrompts(): boolean {
  const customPrompts = getCustomLegacyPrompts();
  if (!customPrompts) {
    return false;
  }

  return (
    customPrompts.agent !== LEGACY_PROMPTS.agent || customPrompts.regular !== LEGACY_PROMPTS.regular
  );
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
  const promptMode = getPromptMode();

  let prompt: string;
  if (promptMode === PROMPT_MODES.AGENT_NORMAL) {
    const legacyPrompts = getLegacyPrompts();
    const useAgentPrompt = Boolean(transcript && detectAgentName(transcript, name));
    const legacyTemplate = useAgentPrompt ? legacyPrompts.agent : legacyPrompts.regular;
    prompt = toLegacySystemPrompt(legacyTemplate, name);
  } else {
    const promptTemplate = getCustomUnifiedPrompt();
    if (promptTemplate) {
      prompt = promptTemplate.replace(/\{\{agentName\}\}/g, name);
    } else {
      const useFullPrompt = !transcript || detectAgentName(transcript, name);
      prompt = (useFullPrompt ? prompts.fullPrompt : prompts.cleanupPrompt).replace(
        /\{\{agentName\}\}/g,
        name
      );
    }
  }

  const langInstruction = getLanguageInstruction(language);
  if (langInstruction) {
    prompt += "\n\n" + langInstruction;
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
  PROMPT_MODES,
  getPromptMode,
  setPromptMode,
  getCustomUnifiedPrompt,
  getCustomLegacyPrompts,
  getLegacyPrompts,
  hasCustomLegacyPrompts,
};
