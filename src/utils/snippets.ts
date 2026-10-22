import type { SharedHintWords } from "./sharedDictionaryHints";

export interface Snippet {
  trigger: string;
  replacement: string;
}

// Mirrors the cap database.js enforces when it stores snippets.
export const MAX_SNIPPET_TRIGGER_LENGTH = 100;

interface SnippetMatcher {
  regex: RegExp;
  replacements: Map<string, string>;
}

export interface SnippetTriggerRange {
  /** Index of the trigger's first character. */
  start: number;
  /** Index one past the trigger's last character. */
  end: number;
}

let cachedSnippets: Snippet[] | null = null;
let cachedMatcher: SnippetMatcher | null = null;

// The regex /i flag can't case-fold Turkish İ (U+0130) or dotless ı
// (U+0131), and İ's toLowerCase() form is two code units ("i" + U+0307), so
// triggers like "İmza" never matched. Folding İ to a plain "i" gives Map
// keys a canonical form, and matching İ/ı explicitly in the pattern lets the
// regex find them in the transcript.
function foldCapitalIDot(value: string): string {
  return value.replace(/İ/g, "i");
}

function buildMatcher(snippets: Snippet[]): SnippetMatcher | null {
  const replacements = new Map<string, string>();
  for (const { trigger, replacement } of snippets) {
    const folded = foldCapitalIDot(trigger.trim().normalize("NFC"));
    const key = folded.toLowerCase();
    if (!key) continue;
    replacements.set(key, replacement);
    // An uppercase I in the trigger may mean Turkish ı as well as English i,
    // so register both readings; an explicit trigger wins over a variant.
    const dotlessKey = folded.replace(/I/g, "ı").toLowerCase();
    if (!replacements.has(dotlessKey)) replacements.set(dotlessKey, replacement);
  }
  if (replacements.size === 0) return null;

  // Longest-first so "investor ask" wins over a shorter "ask" trigger.
  const escaped = [...replacements.keys()]
    .sort((a, b) => b.length - a.length)
    .map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .map((t) => t.replace(/i/g, "[iİ]").replace(/ı/g, "[ıI]"));
  // Unicode-aware word boundaries — triggers never match inside a word.
  const regex = new RegExp(
    `(?<=^|[\\s\\p{P}\\p{S}])(?:${escaped.join("|")})(?=$|[\\s\\p{P}\\p{S}])`,
    "giu"
  );
  return { regex, replacements };
}

// Memoized against the snippets array reference (the settings store replaces
// the array on every change).
function getMatcher(snippets?: Snippet[] | null): SnippetMatcher | null {
  if (!Array.isArray(snippets) || snippets.length === 0) return null;
  if (snippets !== cachedSnippets) {
    cachedSnippets = snippets;
    cachedMatcher = buildMatcher(snippets);
  }
  return cachedMatcher;
}

// The pattern case-folds the Unicode way (/iu) while the keys are toLowerCase'd,
// so a match is not proof of a replacement: "[ıI]mza" matches a plain "imza",
// which is no key at all. Both callers resolve through here, so a reported range
// always means an expansion — wake-word suppression depends on it.
function resolveReplacement(match: string, replacements: Map<string, string>): string | undefined {
  const folded = foldCapitalIDot(match);
  return (
    replacements.get(folded.toLowerCase()) ??
    // An uppercase I can be capital dotless ı as well as English i.
    replacements.get(folded.replace(/I/g, "ı").toLowerCase())
  );
}

/**
 * Character ranges of every trigger occurrence, matched against `text` exactly
 * as given so the offsets index that same string. Wake-word detection uses
 * these to ignore an agent name that only appears because it opens a trigger
 * the user chose, such as "openwhispr review" (see `agentDetection`).
 */
export function findSnippetTriggerRanges(
  text: string,
  snippets?: Snippet[] | null
): SnippetTriggerRange[] {
  if (!text) return [];
  const matcher = getMatcher(snippets);
  if (!matcher) return [];
  return [...text.matchAll(matcher.regex)]
    .filter((match) => resolveReplacement(match[0], matcher.replacements) !== undefined)
    .map((match) => ({
      start: match.index,
      end: match.index + match[0].length,
    }));
}

/**
 * Replace every spoken trigger with its saved text in a single pass.
 */
export function expandSnippets(text: string, snippets?: Snippet[] | null): string {
  if (!text) return text;
  const matcher = getMatcher(snippets);
  if (!matcher) return text;
  const { regex, replacements } = matcher;
  // NFC so a decomposed "I" + U+0307 in the transcript recombines into İ.
  return text
    .normalize("NFC")
    .replace(regex, (match) => resolveReplacement(match, replacements) ?? match);
}

interface DictionaryHintSettings {
  customDictionary?: string[] | null;
  snippets?: Snippet[] | null;
  sharedDictionaryHints?: SharedHintWords | null;
}

function wordList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((w): w is string => typeof w === "string") : [];
}

/**
 * The key two dictionary spellings collide on: NFC (a decomposed "é" and a
 * precomposed one are the same word), trimmed and lowercased.
 */
export function dictionaryWordKey(word: string): string {
  return word.normalize("NFC").trim().toLowerCase();
}

// Shared words never repeat a word seen in a higher tier (or earlier in their
// own); case-insensitive so the user's own spelling wins over a teammate's.
function dedupeBelow(words: string[], seen: Set<string>): string[] {
  const kept: string[] = [];
  for (const word of words) {
    const key = dictionaryWordKey(word);
    if (seen.has(key)) continue;
    seen.add(key);
    kept.push(word);
  }
  return kept;
}

// The personal dictionary words that apply: all of them, except moved words
// whose shared copies the member hid (see SharedHintWords.suppressedPersonal).
// Without suppressed words this is the saved list itself.
function personalDictionary(settings: DictionaryHintSettings | null | undefined): string[] {
  const dictionary = Array.isArray(settings?.customDictionary) ? settings.customDictionary : [];
  const suppressed = wordList(settings?.sharedDictionaryHints?.suppressedPersonal);
  if (suppressed.length === 0) return dictionary;
  const suppressedKeys = new Set(suppressed.map(dictionaryWordKey));
  return dictionary.filter((word) => !suppressedKeys.has(dictionaryWordKey(word)));
}

function sharedTiers(
  settings: DictionaryHintSettings | null | undefined,
  personal: string[]
): [string[], string[]] {
  const seen = new Set(wordList(personal).map(dictionaryWordKey));
  const space = dedupeBelow(wordList(settings?.sharedDictionaryHints?.space), seen);
  const workspace = dedupeBelow(wordList(settings?.sharedDictionaryHints?.workspace), seen);
  return [space, workspace];
}

/**
 * Hint words in priority order: [personal + snippet triggers, space, workspace].
 * Snippet triggers rank with personal words so they survive both the STT prompt
 * and the cleanup-model suffix. The personal tier is returned as saved (no
 * dedupe) so a list without shared words is exactly what it always was.
 */
export function getDictionaryHintTiers(settings?: DictionaryHintSettings | null): string[][] {
  const dictionary = personalDictionary(settings);
  const snippets = Array.isArray(settings?.snippets) ? settings.snippets : [];
  const triggers = snippets
    .map((s) => s?.trigger)
    .filter((t): t is string => typeof t === "string" && t.length > 0);
  const personal = [...dictionary, ...triggers];
  return [personal, ...sharedTiers(settings, personal)];
}

/**
 * Dictionary words plus snippet triggers — the hint list fed to the STT
 * prompt and cleanup-model dictionary suffix so triggers survive both.
 */
export function getDictionaryHintWords(settings?: DictionaryHintSettings | null): string[] {
  return getDictionaryHintTiers(settings).flat();
}

function effectiveTiers(settings?: DictionaryHintSettings | null): string[][] {
  const personal = personalDictionary(settings);
  return [personal, ...sharedTiers(settings, personal)];
}

/**
 * The words the user's dictionary effectively contains, for counts and display:
 * personal, then space, then workspace, without snippet triggers.
 */
export function getEffectiveDictionaryWords(settings?: DictionaryHintSettings | null): string[] {
  return effectiveTiers(settings).flat();
}

// At most this many shared words ride in any STT request (keyterms, keywords,
// prompts), so a team list must not be able to break every member's stream.
export const MAX_SHARED_KEYTERMS = 100;
// Shared keyterms only fill what the providers' limits leave beside the personal
// list, which is sent as it always was: AssemblyAI takes at most 100 keyterms of
// at most 50 characters each, and Deepgram refuses keyterms past 500 tokens,
// which ~1,000 characters of rare names and jargon stays inside.
const MAX_TOTAL_KEYTERMS = 100;
const MAX_KEYTERM_LENGTH = 50;
const MAX_TOTAL_KEYTERM_CHARS = 1000;
// Teammates' words ride in LLM system prompts; a bounded list keeps a long one
// from crowding out the instructions or a local model's context.
export const MAX_SHARED_WORDS_IN_LLM_PROMPTS = 200;
export const MAX_SHARED_CHARS_IN_LLM_PROMPTS = 2000;

interface SharedFillLimits {
  words: number;
  chars?: number;
  totalWords?: number;
  totalChars?: number;
  maxWordLength?: number;
}

const charCount = (words: string[]) => words.reduce((total, word) => total + word.length, 0);

// Every personal word, then shared words (space words first) while they fit the
// limits. The first shared word that doesn't fit ends the fill, so priority
// holds; one too long for any provider is dropped instead.
function withSharedCapped(
  [personal, space, workspace]: string[][],
  {
    words,
    chars = Infinity,
    totalWords = Infinity,
    totalChars = Infinity,
    maxWordLength = Infinity,
  }: SharedFillLimits
): string[] {
  const kept = [...personal];
  let sharedWords = 0;
  let sharedChars = 0;
  let keptChars = charCount(personal);
  for (const word of [...space, ...workspace]) {
    if (word.length > maxWordLength) continue;
    if (
      sharedWords >= words ||
      kept.length >= totalWords ||
      sharedChars + word.length > chars ||
      keptChars + word.length > totalChars
    ) {
      break;
    }
    kept.push(word);
    sharedWords++;
    sharedChars += word.length;
    keptChars += word.length;
  }
  return kept;
}

/**
 * Keyterms for STT providers: every personal word, then shared words while the
 * list stays inside the keyterm providers' limits.
 */
export function getKeytermDictionaryWords(settings?: DictionaryHintSettings | null): string[] {
  return withSharedCapped(effectiveTiers(settings), {
    words: MAX_SHARED_KEYTERMS,
    totalWords: MAX_TOTAL_KEYTERMS,
    totalChars: MAX_TOTAL_KEYTERM_CHARS,
    maxWordLength: MAX_KEYTERM_LENGTH,
  });
}

/**
 * gpt-transcribe's keywords[]: every personal word and snippet trigger, at most
 * MAX_SHARED_KEYTERMS shared ones.
 */
export function getKeywordDictionaryWords(settings?: DictionaryHintSettings | null): string[] {
  return withSharedCapped(getDictionaryHintTiers(settings), { words: MAX_SHARED_KEYTERMS });
}

/**
 * Dictionary words for LLM prompts (cleanup, agent, translation, chat, notes):
 * every personal word (and snippet trigger when asked for), at most
 * MAX_SHARED_WORDS_IN_LLM_PROMPTS shared ones in MAX_SHARED_CHARS_IN_LLM_PROMPTS.
 */
export function getLlmDictionaryWords(
  settings: DictionaryHintSettings | null | undefined,
  { includeTriggers }: { includeTriggers: boolean }
): string[] {
  const tiers = includeTriggers ? getDictionaryHintTiers(settings) : effectiveTiers(settings);
  return withSharedCapped(tiers, {
    words: MAX_SHARED_WORDS_IN_LLM_PROMPTS,
    chars: MAX_SHARED_CHARS_IN_LLM_PROMPTS,
  });
}

/**
 * Splits a dictionary word list into the user's own words (personal words and
 * snippet triggers) and the teammates' words it carries, so a prompt can quote
 * the shared ones as data. A word in both counts as personal, as dedupe does.
 */
export function splitSharedDictionaryWords(
  words: readonly string[],
  settings?: DictionaryHintSettings | null
): { personal: string[]; shared: string[] } {
  const [personalTier, space, workspace] = getDictionaryHintTiers(settings);
  const personalKeys = new Set(personalTier.map(dictionaryWordKey));
  const sharedKeys = new Set([...space, ...workspace].map(dictionaryWordKey));
  const personal: string[] = [];
  const shared: string[] = [];
  for (const word of words) {
    const key = dictionaryWordKey(word);
    if (sharedKeys.has(key) && !personalKeys.has(key)) shared.push(word);
    else personal.push(word);
  }
  return { personal, shared };
}

export interface CloudDictionaryFields {
  customDictionary: string[];
  sharedDictionary?: string[];
}

/**
 * The dictionary fields of an OpenWhispr Cloud LLM request: the user's own
 * words (and snippet triggers) in `customDictionary`, as always, and teammates'
 * words in `sharedDictionary`, which the API quotes as data. The field is left
 * out when there are none, so a personal-only body is what it always was.
 */
export function toCloudDictionaryFields(
  words: readonly string[],
  settings?: DictionaryHintSettings | null
): CloudDictionaryFields {
  const { personal, shared } = splitSharedDictionaryWords(words, settings);
  return shared.length > 0
    ? { customDictionary: personal, sharedDictionary: shared }
    : { customDictionary: personal };
}

/** toCloudDictionaryFields for the LLM dictionary words, snippet triggers included. */
export function getCloudLlmDictionaryFields(
  settings: DictionaryHintSettings | null | undefined
): CloudDictionaryFields {
  return toCloudDictionaryFields(
    getLlmDictionaryWords(settings, { includeTriggers: true }),
    settings
  );
}
