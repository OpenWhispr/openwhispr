// gpt-transcribe takes the custom dictionary as one `keywords[]` multipart field
// per term instead of the Whisper-era free-text prompt. OpenAI rejects the whole
// request when a keyword carries `<`, `>` or a line break. Same rules as the
// server-side adapter in openwhispr-api (lib/providers/openai.ts).

export function usesTranscriptionKeywords(model) {
  return typeof model === "string" && model.trim() === "gpt-transcribe";
}

export function dictionaryKeywords(dictionaryPrompt) {
  return String(dictionaryPrompt ?? "")
    .split(/[,\r\n]+/)
    .map((term) => term.replace(/[<>]/g, "").trim())
    .filter(Boolean);
}
