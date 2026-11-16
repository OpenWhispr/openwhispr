// Per-provider budgets for the custom-dictionary transcription prompt.
// Groq rejects prompts > 896 chars (also via a custom endpoint); 890 leaves margin.
export const GROQ_PROMPT_CHARS = 890;
// Whisper-family decoders read at most 223 prompt tokens and keep the tail of
// anything longer; 900 chars bounds the request without deciding which words survive.
export const WHISPER_PROMPT_CHARS = 900;
// What that 223-token window is worth in characters for a comma-separated list
// of names and terms (~2.3-2.9 chars/token). Same value as desktop's
// WHISPER_DECODER_PROMPT_CHARS.
export const WHISPER_DECODER_PROMPT_CHARS = 550;
// gpt-4o-transcribe models are LLMs with a 16k context; this guards against an
// absurd list crowding out a long dictation, not a limit anyone should hit.
export const TRANSCRIBE_PROMPT_CHARS = 8000;

export function dictionaryPromptLimit(input: {
  providerId: string;
  endpoint: string;
  modelId: string;
}): number {
  if (input.providerId === 'groq' || new URL(input.endpoint).hostname === 'api.groq.com') {
    return GROQ_PROMPT_CHARS;
  }
  if (input.modelId.toLowerCase().startsWith('gpt-4o')) return TRANSCRIBE_PROMPT_CHARS;
  return WHISPER_PROMPT_CHARS;
}

// Shared words fill a Whisper-style prompt only up to what the decoder reads:
// past it they are never decoded, so a near-silent dictation could echo them
// back. Budgets past the Whisper ones (the 4o transcribe models) are read
// whole, so they keep their own limit. Mirrors desktop's sharedDictionaryPromptChars.
export function sharedDictionaryPromptChars(limit: number): number {
  return limit <= WHISPER_PROMPT_CHARS ? Math.min(limit, WHISPER_DECODER_PROMPT_CHARS) : limit;
}

// At most this many shared words ride in a transcription prompt, as in
// desktop's keyterms, keywords and prompts (MAX_SHARED_KEYTERMS).
export const MAX_SHARED_KEYTERMS = 100;
// OpenWhispr Cloud's Gemini route keeps the first 100 terms of the prompt
// (openwhispr-api lib/providers/gemini.ts), and the prompt opens with shared
// words, so shared words must stop before the total reaches it. Same as
// desktop's PROMPT_HEAD_TERMS.
export const PROMPT_HEAD_TERMS = 100;

// The terms a provider splits a prompt entry into: a personal entry may hold commas.
const termCount = (word: string): number =>
  word.split(/[,\r\n]+/).filter((term) => term.trim()).length || 1;

export interface SharedPromptLimits {
  sharedChars?: number;
  sharedWords?: number;
  totalTerms?: number;
}

// Builds the dictionary prompt from priority tiers (personal, space, workspace).
// Whole words are kept greedily, highest tier first, so a long shared list can
// only ever crowd out lower-priority words. They are emitted lowest tier first:
// Whisper-family decoders keep the TAIL of an over-long prompt, so the user's
// own words belong there. `maxChars` bounds the whole prompt; the shared limits
// (`sharedChars` for the prompt's length once shared words join it,
// `sharedWords`, `totalTerms`) bound only the shared fill, so personal words
// keep the full limit. A personal-only list that fits is the plain ", "-joined
// string it always was. Ported from desktop dictionaryPromptCap.js.
export function formatDictionaryPrompt(
  tiers: string[][],
  maxChars: number,
  {
    sharedChars = Infinity,
    sharedWords = Infinity,
    totalTerms = Infinity,
  }: SharedPromptLimits = {},
): string {
  const kept: string[][] = tiers.map(() => []);
  let length = 0;
  let count = 0;
  let terms = 0;
  let shared = 0;
  let full = false;
  for (let tier = 0; tier < tiers.length && !full; tier++) {
    for (const word of tiers[tier]) {
      const next = length + word.length + (count > 0 ? 2 : 0);
      const nextTerms = terms + termCount(word);
      // Strict priority: the first word that doesn't fit ends the fill.
      full =
        next > maxChars ||
        (tier > 0 && (next > sharedChars || shared >= sharedWords || nextTerms > totalTerms));
      if (full) break;
      length = next;
      terms = nextTerms;
      count++;
      if (tier > 0) shared++;
      kept[tier].push(word);
    }
  }
  const first = tiers[0]?.[0];
  if (count === 0 && first !== undefined && first.length > maxChars) {
    // A first personal entry longer than the whole budget is sent cut off (at
    // its last comma, in UTF-16 units), as the trim this replaced did, rather
    // than dropping the prompt; nothing joins it. Shared words are never cut.
    // Same rule as desktop's selectDictionaryPromptTiers.
    const head = first.slice(0, Math.max(0, maxChars));
    const lastComma = head.lastIndexOf(',');
    const cut = lastComma > 0 ? head.slice(0, lastComma) : head;
    if (cut) kept[0].push(cut);
  }
  return kept.reverse().flat().join(', ');
}

// For prompts the app never trimmed before shared words existed: shared words
// fill up to `maxChars`, but the personal tier (tiers[0]) is always sent whole.
export function promptLimitKeepingPersonal(tiers: string[][], maxChars: number): number {
  return Math.max(maxChars, (tiers[0] ?? []).join(', ').length);
}
