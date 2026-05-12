import i18n, { normalizeUiLanguage } from "../../i18n";
import { useSettingsStore } from "../../stores/settingsStore";
import { en as enPrompts } from "../../locales/prompts";
import { getLanguageInstruction } from "../../utils/languageSupport";
import { PROMPT_KINDS, type PromptKind } from "./registry";

export { PROMPT_KINDS, PROMPT_KIND_LIST, type PromptKind } from "./registry";

export interface ResolvePromptOptions {
  agentName: string | null;
  uiLanguage?: string;
  language?: string;
  customDictionary?: string[];
}

export function resolvePrompt(kind: PromptKind, opts: ResolvePromptOptions): string {
  const custom = useSettingsStore.getState().customPrompts[kind];
  const template = custom || getDefaultPromptText(kind, opts.uiLanguage);
  return applySubstitutions(template, opts);
}

export function getDefaultPromptText(kind: PromptKind, uiLanguage?: string): string {
  const def = PROMPT_KINDS[kind];
  if (!def.i18nKey) return def.fallback;
  const locale = normalizeUiLanguage(uiLanguage || "en");
  const t = i18n.getFixedT(locale, "prompts");
  return t(def.i18nKey, { defaultValue: def.fallback });
}

export function appendDictionarySuffix(
  prompt: string,
  customDictionary?: string[],
  uiLanguage?: string
): string {
  if (!customDictionary?.length) return prompt;
  const locale = normalizeUiLanguage(uiLanguage || "en");
  const suffix = i18n.getFixedT(locale, "prompts")("dictionarySuffix", {
    defaultValue: enPrompts.dictionarySuffix,
  });
  return prompt + suffix + customDictionary.join(", ");
}

function applySubstitutions(template: string, opts: ResolvePromptOptions): string {
  const name = opts.agentName?.trim() || "Assistant";
  let prompt = template.replace(/\{\{agentName\}\}/g, name);

  const langInstruction = getLanguageInstruction(opts.language);
  if (langInstruction) prompt += "\n\n" + langInstruction;

  return appendDictionarySuffix(prompt, opts.customDictionary, opts.uiLanguage);
}
