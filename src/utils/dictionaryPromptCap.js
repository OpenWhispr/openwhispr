import { usesTranscriptionKeywords } from "./dictionaryKeywords.js";

// Per-provider budgets for the custom-dictionary STT prompt on the direct-API
// path, plus the decoder window the dictionary UI warns against. One place, so
// the request bound and the warning cannot drift apart.

// Groq rejects prompts > 896 chars (incl. when reached via a custom endpoint);
// 890 leaves margin for UTF-16 vs codepoint counting drift.
export const GROQ_PROMPT_CHARS = 890;

// Whisper-family decoders (whisper-1, Groq's whisper-large-v3, whisper.cpp) read
// at most 223 prompt tokens and keep the TAIL of anything longer, silently. 900
// chars is the historical client-side cut for them: it is well above what the
// decoder reads, so it only bounds the request, never which words survive.
export const WHISPER_PROMPT_CHARS = 900;

// What the decoder's 223-token window is actually worth in characters. A
// comma-separated list of names and technical terms tokenizes at ~2.3-2.9
// chars/token (measured against Whisper's own BPE) — far denser than the ~4
// chars/token rule of thumb for prose, because every ", " costs a token and
// rare proper nouns fragment. Used to warn in the UI, not to trim: the true
// budget is tokens, and no character count is right for every language.
export const WHISPER_DECODER_PROMPT_CHARS = 550;

// gpt-transcribe's prompt carries only the dictionary terms past its keyword cap
// (see dictionaryKeywords). OpenAI accepts exactly 65,536 characters there
// (65,537 is a 400), and neither channel adds measurable latency.
export const TRANSCRIPTION_OVERFLOW_PROMPT_CHARS = 65536;

// gpt-4o-transcribe / gpt-4o-mini-transcribe are LLMs, not Whisper decoders: no
// 223-token prompt window, and verified live to 40k chars. The only hard limit
// is the 16k-token context shared with the audio, so this is a guard against an
// absurd list crowding out a long dictation, not a limit anyone should hit.
export const TRANSCRIBE_PROMPT_CHARS = 8000;

// Only the 4o transcribe family is known to read past a Whisper decoder's
// prompt window, so it earns the generous budget, as does gpt-transcribe's
// keyword overflow. Everything else falls back to the Whisper budget on
// purpose: custom and self-hosted endpoints take whatever model name the user
// typed, and most of those servers are Whisper-family under a name that never
// says "whisper".
export function dictionaryPromptLimit({ provider = "", endpoint = "", model = "" } = {}) {
  if (provider === "groq" || endpoint.includes("api.groq.com")) return GROQ_PROMPT_CHARS;
  if (model.toLowerCase().startsWith("gpt-4o")) return TRANSCRIBE_PROMPT_CHARS;
  if (usesTranscriptionKeywords(model)) return TRANSCRIPTION_OVERFLOW_PROMPT_CHARS;
  return WHISPER_PROMPT_CHARS;
}

// Shared words fill a Whisper-style prompt only up to what the decoder reads:
// past it they are never decoded, and they dilute the echo filter, which needs
// 70% of the prompt's words back to recognise a recital. Budgets past the
// Whisper ones (the 4o transcribe models, gpt-transcribe's overflow) are read
// whole, so they keep their own limit.
export function sharedDictionaryPromptChars(limit) {
  return limit <= WHISPER_PROMPT_CHARS ? Math.min(limit, WHISPER_DECODER_PROMPT_CHARS) : limit;
}

// OpenWhispr Cloud's Gemini route keeps the first 100 terms of the prompt
// (openwhispr-api lib/providers/gemini.ts), and the prompt opens with shared
// words, so shared words must stop before the total reaches it.
export const PROMPT_HEAD_TERMS = 100;

// The terms a provider splits a prompt entry into (dictionaryTerms in
// dictionaryKeywords and openwhispr-api): a personal entry may hold commas.
const termCount = (word) => word.split(/[,\r\n]+/).filter((term) => term.trim()).length || 1;

// Picks the dictionary words a prompt keeps from priority tiers (personal,
// space, workspace), highest priority first. Whole words are kept greedily,
// highest tier first, so a long shared list can only ever crowd out
// lower-priority words. `maxChars` bounds the whole prompt; the shared limits
// (`sharedChars` for the prompt's length once shared words join it,
// `sharedWords`, `totalTerms`) bound only the shared fill, so the personal tier
// is kept as it always was.
export function selectDictionaryPromptTiers(
  tiers,
  maxChars,
  { sharedChars = Infinity, sharedWords = Infinity, totalTerms = Infinity } = {}
) {
  const kept = tiers.map(() => []);
  let length = 0;
  let count = 0;
  let terms = 0;
  let shared = 0;
  outer: for (let tier = 0; tier < tiers.length; tier++) {
    for (const word of tiers[tier]) {
      const next = length + word.length + (count > 0 ? 2 : 0);
      const nextTerms = terms + termCount(word);
      // Strict priority: the first word that doesn't fit ends the fill.
      if (next > maxChars) break outer;
      if (tier > 0 && (next > sharedChars || shared >= sharedWords || nextTerms > totalTerms)) {
        break outer;
      }
      length = next;
      terms = nextTerms;
      count++;
      if (tier > 0) shared++;
      kept[tier].push(word);
    }
  }
  // A first personal entry longer than the whole budget would otherwise leave
  // no dictionary at all, so it is sent cut down instead, as trimDictionaryPrompt
  // did: to the budget, then back to its last comma when it holds one.
  const first = tiers[0]?.[0];
  if (count === 0 && first && first.length > maxChars) {
    const head = first.slice(0, Math.max(0, maxChars));
    const lastComma = head.lastIndexOf(",");
    const cut = lastComma > 0 ? head.slice(0, lastComma) : head;
    if (cut) kept[0].push(cut);
  }
  return kept;
}

// Emits kept tiers lowest tier first: Whisper-family decoders keep the TAIL of
// an over-long prompt, so the user's own words belong there. A personal-only
// list is the plain ", "-joined string it always was.
export function joinDictionaryPromptTiers(kept) {
  return [...kept].reverse().flat().join(", ");
}

// Callers must classify dictionary echoes against the returned prompt, not the
// full list: the echo filter needs 70% of the prompt's words back, which a full
// echo of a capped prompt only clears when measured against the same string.
export function formatDictionaryPrompt(tiers, maxChars, sharedLimits) {
  return joinDictionaryPromptTiers(selectDictionaryPromptTiers(tiers, maxChars, sharedLimits));
}
