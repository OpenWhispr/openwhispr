// gpt-transcribe takes the custom dictionary as one `keywords[]` multipart field
// per term instead of the Whisper-era free-text prompt. OpenAI rejects the whole
// request when a keyword carries `<`, `>` or a line break, or when the form has
// more than ~1,000 parts ("Could not parse multipart form", #2224). Same split
// and 900-term cap as the server-side adapter in openwhispr-api
// (lib/providers/openai.ts), which also sends the terms past the cap as `prompt`;
// this direct path drops them. The dictionary arrives oldest-first with snippet
// triggers last, so the dropped terms are the newest entries and the triggers.
const MAX_TRANSCRIPTION_KEYWORDS = 900;

export function usesTranscriptionKeywords(model) {
  return typeof model === "string" && model.trim() === "gpt-transcribe";
}

export function dictionaryKeywords(dictionaryPrompt) {
  return String(dictionaryPrompt ?? "")
    .split(/[,\r\n]+/)
    .map((term) => term.replace(/[<>]/g, "").trim())
    .filter(Boolean)
    .slice(0, MAX_TRANSCRIPTION_KEYWORDS);
}
