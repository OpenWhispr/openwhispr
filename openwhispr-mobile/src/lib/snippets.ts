// Mirrors the desktop snippet expansion (../openwhispr/src/utils/snippets.ts):
// spoken triggers are replaced with their saved text in the final dictation
// transcript, and triggers double as dictionary hints so they survive STT/cleanup.

import { sharedWordKey } from './sharedDictionaryHints';

export interface Snippet {
  trigger: string;
  replacement: string;
}

interface SnippetMatcher {
  regex: RegExp;
  replacements: Map<string, string>;
}

let cachedSnippets: Snippet[] | null = null;
let cachedMatcher: SnippetMatcher | null = null;

// Whitespace, punctuation, or symbol — what counts as a word boundary.
const BOUNDARY = '[\\s\\p{P}\\p{S}]';

function buildMatcher(snippets: Snippet[]): SnippetMatcher | null {
  const replacements = new Map<string, string>();
  for (const { trigger, replacement } of snippets) {
    const key = trigger.trim().toLowerCase();
    if (key) replacements.set(key, replacement);
  }
  if (replacements.size === 0) return null;

  // Longest-first so "investor ask" wins over a shorter "ask" trigger.
  const escaped = [...replacements.keys()]
    .sort((a, b) => b.length - a.length)
    .map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));

  // Unicode-aware word boundaries — triggers never match inside a word. The
  // leading boundary is a CAPTURING group (re-emitted by the replacer) rather
  // than a lookbehind: React Native's Hermes engine does not reliably support
  // lookbehind. The trailing boundary stays a non-consuming lookahead, so the
  // consumed leading boundary is still available to an adjacent trigger and no
  // match is skipped. Unicode property escapes (\p{P}\p{S}) are supported on
  // Hermes (see src/lib/correctionLearner.ts).
  const regex = new RegExp(`(^|${BOUNDARY})(?:${escaped.join('|')})(?=$|${BOUNDARY})`, 'giu');
  return { regex, replacements };
}

/**
 * Replace every spoken trigger with its saved text in a single pass. The matcher
 * is memoized against the snippets array reference (stores replace the array on
 * every change), matching desktop's reference-equality memoization.
 */
export function expandSnippets(text: string, snippets: Snippet[]): string {
  if (!text || snippets.length === 0) return text;
  if (snippets !== cachedSnippets) {
    cachedSnippets = snippets;
    cachedMatcher = buildMatcher(snippets);
  }
  if (!cachedMatcher) return text;
  const { regex, replacements } = cachedMatcher;
  return text.replace(regex, (match, lead: string) => {
    const trigger = match.slice(lead.length).toLowerCase();
    const replacement = replacements.get(trigger);
    return replacement === undefined ? match : lead + replacement;
  });
}

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
