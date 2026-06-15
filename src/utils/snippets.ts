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
    .map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  // Unicode-aware word boundaries — triggers never match inside a word.
  const regex = new RegExp(
    `(?<=^|[\\s\\p{P}\\p{S}])(?:${escaped.join("|")})(?=$|[\\s\\p{P}\\p{S}])`,
    "giu"
  );
  return { regex, replacements };
}

/**
 * Replace every spoken trigger with its saved text in a single pass. The
 * matcher is memoized against the snippets array reference (the settings
 * store replaces the array on every change).
 */
export function expandSnippets(text: string, snippets: Snippet[]): string {
  if (!text || snippets.length === 0) return text;
  if (snippets !== cachedSnippets) {
    cachedSnippets = snippets;
    cachedMatcher = buildMatcher(snippets);
  }
  if (!cachedMatcher) return text;
  const { regex, replacements } = cachedMatcher;
  return text.replace(regex, (match) => replacements.get(match.toLowerCase()) ?? match);
}

/**
 * Dictionary words plus snippet triggers — the hint list fed to the STT
 * prompt and cleanup-model dictionary suffix so triggers survive both.
 */
export function getDictionaryHintWords(settings: {
  customDictionary: string[];
  snippets: Snippet[];
}): string[] {
  if (settings.snippets.length === 0) return settings.customDictionary;
  return [...settings.customDictionary, ...settings.snippets.map((s) => s.trigger)];
}
