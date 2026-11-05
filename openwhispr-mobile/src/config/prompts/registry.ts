import defaultPrompts from './defaultPrompts.json';

// Mirrors desktop src/config/prompts/registry.ts (PROMPT_KIND_LIST). Only
// `cleanup` has a shipped default and UI on mobile today; the type and the
// customPrompt.<kind> storage keys carry all four so a future sync can
// round-trip every kind without a migration.
export const PROMPT_KIND_LIST = ['cleanup', 'dictationAgent', 'translate', 'chatAgent'] as const;
export type PromptKind = (typeof PROMPT_KIND_LIST)[number];

export const AGENT_NAME_PLACEHOLDER = '{{agentName}}';

// Same localStorage key desktop's settingsStore uses, so a future sync can
// move values between the apps unchanged. "" means "use the shipped default".
export function customPromptStorageKey(kind: PromptKind): string {
  return `customPrompt.${kind}`;
}

// Byte-identical to the server default (openwhispr-api/lib/locales/en/prompts.json)
// and desktop's src/locales/en/prompts.json. When this text changes, move its
// old hash into RETIRED_DEFAULT_PROMPT_HASHES and update
// CURRENT_DEFAULT_PROMPT_HASHES in ./retiredPrompts.ts; the registry test
// fails until both are done.
export const DEFAULT_CLEANUP_PROMPT: string = defaultPrompts.cleanupPrompt;

export function hasAgentNamePlaceholder(text: string): boolean {
  return text.includes(AGENT_NAME_PLACEHOLDER);
}

// Desktop PromptStudio save rule: the unedited default is not a customization,
// and neither is whitespace. Both persist as "" so the shipped default keeps
// resolving and future default updates still reach this install. Anything
// else is stored verbatim — trimming would change its hash and break the
// retired-default sweep and future sync equality.
export function normalizeCustomPromptForSave(draft: string, defaultText: string): string {
  if (draft.trim() === '' || draft === defaultText) return '';
  return draft;
}

// "" and whitespace-only stored values (legacy or synced) mean "no override".
export function resolveCustomPrompt(value: string): string | undefined {
  return value.trim() ? value : undefined;
}
