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

module.exports = { buildLocalWhisperDictionaryPrompt, transcribeWithDictionary };
