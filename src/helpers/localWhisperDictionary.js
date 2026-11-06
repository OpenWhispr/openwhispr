// Custom-dictionary bias for the local Whisper paths that run in the main
// process (file upload / CLI, history retranscribe, dictation live preview).
// Dictation itself builds its prompt in the renderer (audioManager); this
// mirrors it from the main-process dictionary so the other paths are not
// silently unbiased (#3117).

let capModule = null;
let echoModule = null;
const loadCap = async () => (capModule ??= await import("../utils/dictionaryPromptCap.js"));
const loadEcho = async () => (echoModule ??= await import("../utils/dictionaryEchoFilter.js"));

const toTerms = (dictionary) =>
  (Array.isArray(dictionary) ? dictionary : [])
    .filter((term) => typeof term === "string")
    .map((term) => term.trim())
    .filter(Boolean);

// The initialPrompt for a Whisper decode, or null for an empty dictionary.
async function buildLocalWhisperDictionaryPrompt(dictionary) {
  const terms = toTerms(dictionary);
  if (!terms.length) return null;
  const { formatDictionaryPrompt, WHISPER_PROMPT_CHARS, WHISPER_DECODER_PROMPT_CHARS } =
    await loadCap();
  return (
    formatDictionaryPrompt([terms], WHISPER_PROMPT_CHARS, {
      sharedChars: WHISPER_DECODER_PROMPT_CHARS,
    }) || null
  );
}

// Decodes with the dictionary as initialPrompt. If the result only recites the
// prompt (Whisper does this on short or quiet audio), `onEcho` decides:
//   "retry"   - decode again without the prompt (file / retranscribe)
//   "discard" - return an empty successful result (live preview)
async function transcribeWithDictionary(
  whisperManager,
  audio,
  options,
  dictionary,
  { onEcho = "retry" } = {}
) {
  // A caller that already chose a prompt keeps it.
  const prompt = options?.initialPrompt
    ? null
    : await buildLocalWhisperDictionaryPrompt(dictionary);
  if (!prompt) return whisperManager.transcribeLocalWhisper(audio, options);

  const result = await whisperManager.transcribeLocalWhisper(audio, {
    ...options,
    initialPrompt: prompt,
  });
  if (!result?.success || typeof result.text !== "string" || !result.text.trim()) return result;

  const { matchesDictionaryPrompt } = await loadEcho();
  if (!matchesDictionaryPrompt(result.text, prompt)) return result;

  if (onEcho === "discard") return { ...result, text: "" };
  return whisperManager.transcribeLocalWhisper(audio, options);
}

// ---- Meeting chunks -------------------------------------------------------
// A meeting decodes a continuous stream in pause-cut chunks. Each chunk's prompt
// is the dictionary plus the tail of the previous transcribed chunk of the same
// source, so a name or sentence split across a cut keeps its spelling and case.

// Characters of the previous chunk worth carrying. Whisper conditions on little
// more, and a longer tail mainly raises the odds of it being recited back.
const MEETING_CONTEXT_MAX_CHARS = 200;

const normalizeForCompare = (text) =>
  String(text ?? "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, "")
    .replace(/\s+/g, " ")
    .trim();

// The last `maxChars` of `text`, starting at a word boundary.
function tailAtWordBoundary(text, maxChars) {
  const clean = String(text ?? "")
    .replace(/\s+/g, " ")
    .trim();
  if (maxChars <= 0 || !clean) return "";
  if (clean.length <= maxChars) return clean;
  const tail = clean.slice(-maxChars);
  const firstSpace = tail.indexOf(" ");
  // A tail that starts mid-word and holds no boundary is not worth sending.
  return firstSpace === -1 ? "" : tail.slice(firstSpace + 1).trim();
}

// Per-source memory of the last transcribed text. Cleared on meeting start/reset.
function createMeetingPromptContext() {
  const tails = new Map();
  return {
    get: (source) => tails.get(source) || "",
    remember(source, text) {
      const tail = tailAtWordBoundary(text, MEETING_CONTEXT_MAX_CHARS);
      if (tail) tails.set(source, tail);
    },
    reset: () => tails.clear(),
  };
}

// Dictionary first (it has priority and is never shortened by the context), then
// the previous chunk's tail in whatever room is left of Whisper's decoder window.
async function buildMeetingChunkPrompt(dictionary, context) {
  const dictionaryPrompt = await buildLocalWhisperDictionaryPrompt(dictionary);
  const { WHISPER_PROMPT_CHARS, WHISPER_DECODER_PROMPT_CHARS } = await loadCap();
  const room =
    Math.min(WHISPER_PROMPT_CHARS, WHISPER_DECODER_PROMPT_CHARS) -
    (dictionaryPrompt ? dictionaryPrompt.length + 1 : 0);
  const contextTail = tailAtWordBoundary(context, Math.min(MEETING_CONTEXT_MAX_CHARS, room));
  const prompt = [dictionaryPrompt, contextTail].filter(Boolean).join(" ") || null;
  return { prompt, dictionaryPrompt, contextTail };
}

// True when the decoded text is the prompt (or part of it) coming back out.
async function isMeetingPromptEcho(text, { prompt, dictionaryPrompt, contextTail }, dictionary) {
  const { matchesDictionaryPrompt, isLikelyDictionaryPromptFragment, stripTrailingDictionaryEcho } =
    await loadEcho();
  if (dictionaryPrompt) {
    if (matchesDictionaryPrompt(text, dictionaryPrompt)) return true;
    if (isLikelyDictionaryPromptFragment(text, dictionaryPrompt)) return true;
    if (stripTrailingDictionaryEcho(text, prompt, toTerms(dictionary)) !== text) return true;
  }
  if (contextTail) {
    // Quiet audio makes Whisper repeat the text it was primed with.
    const normalizedText = normalizeForCompare(text);
    const normalizedContext = normalizeForCompare(contextTail);
    if (normalizedText && normalizedContext.includes(normalizedText)) {
      return normalizedText.split(" ").length >= 3 || normalizedText === normalizedContext;
    }
  }
  return false;
}

// Decodes a meeting chunk with dictionary + previous-chunk context. A result
// that only recites the prompt is decoded once more without it; the prompt is
// never returned as the transcript.
async function transcribeMeetingChunkWithPrompt(
  whisperManager,
  audio,
  options,
  dictionary,
  context = ""
) {
  const built = await buildMeetingChunkPrompt(dictionary, context);
  if (!built.prompt) return whisperManager.transcribeLocalWhisper(audio, options);

  const result = await whisperManager.transcribeLocalWhisper(audio, {
    ...options,
    initialPrompt: built.prompt,
  });
  if (!result?.success || typeof result.text !== "string" || !result.text.trim()) return result;
  if (!(await isMeetingPromptEcho(result.text, built, dictionary))) return result;
  return whisperManager.transcribeLocalWhisper(audio, options);
}

module.exports = {
  buildLocalWhisperDictionaryPrompt,
  transcribeWithDictionary,
  createMeetingPromptContext,
  buildMeetingChunkPrompt,
  transcribeMeetingChunkWithPrompt,
};
