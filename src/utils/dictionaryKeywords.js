// gpt-transcribe takes the custom dictionary as one `keywords[]` multipart field
// per term instead of the Whisper-era free-text prompt. OpenAI rejects the whole
// request when a keyword carries `<`, `>` or a line break, or when the form has
// more than ~1,000 parts ("Could not parse multipart form", #2224). So the first
// 900 terms go out as keywords and the rest ride in `prompt` as context. Same
// rules as the server-side adapter in openwhispr-api (lib/providers/openai.ts).
const MAX_TRANSCRIPTION_KEYWORDS = 900;

export function usesTranscriptionKeywords(model) {
  return typeof model === "string" && model.trim() === "gpt-transcribe";
}

function dictionaryTerms(dictionaryPrompt) {
  return String(dictionaryPrompt ?? "")
    .split(/[,\r\n]+/)
    .map((term) => term.replace(/[<>]/g, "").trim())
    .filter(Boolean);
}

export function dictionaryKeywords(dictionaryPrompt) {
  return dictionaryTerms(dictionaryPrompt).slice(0, MAX_TRANSCRIPTION_KEYWORDS);
}

export function dictionaryKeywordOverflow(dictionaryPrompt) {
  return dictionaryTerms(dictionaryPrompt).slice(MAX_TRANSCRIPTION_KEYWORDS).join(", ") || null;
}
