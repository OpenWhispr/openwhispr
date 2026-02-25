import dePrompts from "./de/prompts.json";
import enPrompts from "./en/prompts.json";
import esPrompts from "./es/prompts.json";
import frPrompts from "./fr/prompts.json";
import itPrompts from "./it/prompts.json";
import jaPrompts from "./ja/prompts.json";
import ptPrompts from "./pt/prompts.json";
import ruPrompts from "./ru/prompts.json";
import zhCNPrompts from "./zh-CN/prompts.json";
import zhTWPrompts from "./zh-TW/prompts.json";

export interface PromptBundle {
  cleanupPrompt: string;
  fullPrompt: string;
  dictionarySuffix: string;
}

export const en: PromptBundle = enPrompts;
export const es: PromptBundle = esPrompts;
export const fr: PromptBundle = frPrompts;
export const de: PromptBundle = dePrompts;
export const pt: PromptBundle = ptPrompts;
export const it: PromptBundle = itPrompts;
export const ru: PromptBundle = ruPrompts;
export const ja: PromptBundle = jaPrompts;
export const zhCN: PromptBundle = zhCNPrompts;
export const zhTW: PromptBundle = zhTWPrompts;

export const PROMPTS_BY_LOCALE = {
  en,
  es,
  fr,
  de,
  pt,
  it,
  ru,
  ja,
  "zh-CN": zhCN,
  "zh-TW": zhTW,
} as const;
