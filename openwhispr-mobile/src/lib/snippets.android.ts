import { createSnippetExpander } from './snippetExpansion';

// Explicit extension reuses dictionary hints without resolving this Android entry again.
const base = require('./snippets.ts') as typeof import('./snippets');
export type { Snippet, LlmDictionary } from './snippets';
export const {
  getDictionaryHintTiers,
  MAX_SHARED_WORDS_IN_LLM_PROMPTS,
  MAX_SHARED_CHARS_IN_LLM_PROMPTS,
  splitLlmDictionary,
} = base;

export const expandSnippets = createSnippetExpander((replacement, followingCharacter) => {
  // Keep the source boundary unconsumed so adjacent triggers still match.
  const last = replacement.slice(-1);
  const duplicateMark = /[.!?。！？]/.test(last) && followingCharacter === last;
  return duplicateMark ? replacement.slice(0, -1) : replacement;
});
