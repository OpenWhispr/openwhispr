const debugLogger = require("./debugLogger");
const {
  PROVIDER_ERROR_CODES,
  providerHttpError,
  providerError,
  redactProviderBody,
} = require("./providerHttpErrors");

const ASSEMBLYAI_DICTATION_URL = "https://dictation.assemblyai.com/v1/transcribe";

// AssemblyAI asks clients to wait 90 s; the request has no deadline of its own.
const REQUEST_TIMEOUT_MS = 90_000;

// AssemblyAI's Dictation API transcribes a finished recording and rewrites it in
// the same request. `text` is the verbatim transcript and `llm_response` the
// rewrite, which is null (with `llm_error`) when only the rewrite failed.
async function transcribeWithAssemblyAiDictation(
  { audioBuffer, contentType, language, keyterms, apiKey, signal },
  fetchImpl
) {
  if (!apiKey?.trim()) {
    throw providerError(PROVIDER_ERROR_CODES.KEY_MISSING, {
      provider: "AssemblyAI",
      surface: "transcription",
    });
  }

  const config = {};
  // The API answers 400 to a language code outside its list.
  const { ASSEMBLYAI_DICTATION_LANGUAGES } = await import("./transcriptionRoute.ts");
  if (language && ASSEMBLYAI_DICTATION_LANGUAGES.has(language)) {
    config.language_codes = [language];
  }
  if (keyterms && keyterms.length > 0) {
    config.keyterms_prompt = keyterms;
  }

  const audioType = (contentType || "audio/webm").split(";")[0].trim();
  const formData = new FormData();
  formData.append("config", new Blob([JSON.stringify(config)], { type: "application/json" }));
  formData.append(
    "audio",
    new Blob([Buffer.from(audioBuffer)], { type: audioType }),
    `audio.${audioType.split("/")[1] || "webm"}`
  );

  const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
  let response;
  try {
    response = await fetchImpl(ASSEMBLYAI_DICTATION_URL, {
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      method: "POST",
      // The API key goes in raw, with no Bearer prefix.
      headers: { Authorization: apiKey },
      body: formData,
    });
  } catch (error) {
    if (timeout.aborted && !signal?.aborted) {
      throw providerError(PROVIDER_ERROR_CODES.TIMEOUT, {
        provider: "AssemblyAI",
        surface: "transcription",
      });
    }
    throw error;
  }

  if (!response.ok) {
    const errorText = await response.text().catch(() => "");
    debugLogger.warn("AssemblyAI dictation failed", {
      status: response.status,
      body: redactProviderBody(errorText),
    });
    throw providerHttpError({
      provider: "AssemblyAI",
      status: response.status,
      body: errorText,
      headers: response.headers,
      surface: "transcription",
    });
  }

  const result = await response.json();
  if (result?.llm_error) {
    // Still a 200: the caller falls back to the app's own cleanup of `text`.
    debugLogger.warn("AssemblyAI dictation returned no rewrite", {
      error: redactProviderBody(result.llm_error),
    });
  }
  return {
    text: result?.text,
    cleanedText: typeof result?.llm_response === "string" ? result.llm_response : undefined,
  };
}

module.exports = { transcribeWithAssemblyAiDictation };
