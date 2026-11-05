import type { Snippet } from './snippets';

interface SnippetMatcher {
  regex: RegExp;
  replacements: Map<string, string>;
}

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

export function createSnippetExpander(
  adjustReplacement?: (replacement: string, followingCharacter: string | undefined) => string,
) {
  let cachedSnippets: Snippet[] | null = null;
  let cachedMatcher: SnippetMatcher | null = null;

  /**
   * Replace every spoken trigger with its saved text in a single pass. The matcher
   * is memoized against the snippets array reference (stores replace the array on
   * every change), matching desktop's reference-equality memoization.
   */
  return function expandSnippets(text: string, snippets: Snippet[]): string {
    if (!text || snippets.length === 0) return text;
    if (snippets !== cachedSnippets) {
      cachedSnippets = snippets;
      cachedMatcher = buildMatcher(snippets);
    }
    if (!cachedMatcher) return text;
    const { regex, replacements } = cachedMatcher;
    return text.replace(regex, (match, lead: string, offset: number, source: string) => {
      const trigger = match.slice(lead.length).toLowerCase();
      const replacement = replacements.get(trigger);
      if (replacement === undefined) return match;
      return (
        lead +
        (adjustReplacement
          ? adjustReplacement(replacement, source[offset + match.length])
          : replacement)
      );
    });
  };
}
