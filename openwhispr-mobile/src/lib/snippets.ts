// Mirrors the desktop snippet expansion (../openwhispr/src/utils/snippets.ts):
// spoken triggers are replaced with their saved text in the final dictation
// transcript, and triggers double as dictionary hints so they survive STT/cleanup.

import { sharedWordKey } from './sharedDictionaryHints';
import { createSnippetExpander } from './snippetExpansion';

export interface Snippet {
  trigger: string;
  replacement: string;
}

export const expandSnippets = createSnippetExpander();

// Shared words never repeat a word seen in a higher tier (or earlier in their
// own); keyed like desktop's dictionaryWordKey (NFC, trimmed, lowercase) so the
// user's own spelling wins over a teammate's.
function dedupeBelow(words: string[], seen: Set<string>): string[] {
  const kept: string[] = [];
  for (const word of words) {
    const key = sharedWordKey(word);
    if (seen.has(key)) continue;
    seen.add(key);
    kept.push(word);
  }
  return kept;
}

/**
 * Hint words in priority order: [personal + snippet triggers, space, workspace],
 * fed to the STT prompt and cleanup-model dictionary so triggers survive both.
 * Snippet triggers rank with personal words. The personal tier is returned as
 * saved (no dedupe), so a list without shared words is exactly what it always
 * was. Mirrors desktop's getDictionaryHintTiers.
 */
export function getDictionaryHintTiers(
  customDictionary: string[],
  snippets: Snippet[],
  shared: { space: string[]; workspace: string[] },
  includeSnippetTriggers: boolean,
): string[][] {
  const personal = includeSnippetTriggers
    ? [...customDictionary, ...snippets.map((s) => s.trigger)]
    : customDictionary;
  const seen = new Set(personal.map(sharedWordKey));
  const space = dedupeBelow(shared.space, seen);
  const workspace = dedupeBelow(shared.workspace, seen);
  return [personal, space, workspace];
}

// Teammates' words ride in LLM system prompts; a bounded list keeps a long one
// from crowding out the instructions. Same cap as desktop.
export const MAX_SHARED_WORDS_IN_LLM_PROMPTS = 200;

export const MAX_SHARED_CHARS_IN_LLM_PROMPTS = 2000;

/** LLM dictionary hints with teammates' words kept apart from the user's own. */
export interface LlmDictionary {
  personal: string[];
  shared: string[];
}

/**
 * Every personal word (tier 0), then shared ones, space first, while they stay
 * within `maxShared` words and MAX_SHARED_CHARS_IN_LLM_PROMPTS characters (the
 * API's limits). The first shared word that doesn't fit ends the fill.
 */
export function splitLlmDictionary(
  tiers: string[][],
  maxShared: number = MAX_SHARED_WORDS_IN_LLM_PROMPTS,
): LlmDictionary {
  const [personal = [], space = [], workspace = []] = tiers;
  const shared: string[] = [];
  let chars = 0;
  for (const word of [...space, ...workspace]) {
    if (shared.length >= maxShared || chars + word.length > MAX_SHARED_CHARS_IN_LLM_PROMPTS) break;
    shared.push(word);
    chars += word.length;
  }
  return { personal: [...personal], shared };
}
