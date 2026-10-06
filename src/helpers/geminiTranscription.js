const { net } = require("electron");
const debugLogger = require("./debugLogger");
const {
  PROVIDER_ERROR_CODES,
  providerHttpError,
  providerError,
  redactProviderBody,
} = require("./providerHttpErrors");

// gemini-3.5-transcribe is only served by the Interactions API; there is no
// generateContent or OpenAI-compatible endpoint for it.
const GEMINI_INTERACTIONS_URL = "https://generativelanguage.googleapis.com/v1beta/interactions";

// Gemini documents audio/mp3 and audio/aac instead of the audio/mpeg and
// audio/mp4 types the rest of the pipeline uses.
const GEMINI_MIME_TYPES = {
  "audio/mpeg": "audio/mp3",
  "audio/mp4": "audio/aac",
};

// The full transcript lives in output_text, but the documented sample response
// omits it — joining the steps' text content is the safe fallback.
function extractText(data) {
  const outputText = data?.output_text;
  if (typeof outputText === "string" && outputText.trim()) {
    return outputText;
  }
  return (data?.steps || [])
    .flatMap((step) => step?.content || [])
    .filter((part) => part?.type === "text" && typeof part.text === "string")
    .map((part) => part.text)
    .join(" ");
}

async function transcribeWithGemini(
  { audioBuffer, model, contentType, language, keyterms, apiKey },
  fetchImpl
) {
  if (!apiKey?.trim()) {
    throw providerError(PROVIDER_ERROR_CODES.KEY_MISSING, {
      provider: "Gemini",
      surface: "transcription",
    });
  }

  const resolvedModel = model || "gemini-3.5-transcribe";
  const transcriptionConfig = {};
  if (language && language !== "auto") {
    transcriptionConfig.language_codes = [language];
  }
  if (keyterms && keyterms.length > 0) {
    transcriptionConfig.custom_vocabulary = keyterms;
  }
  const requestBody = {
    model: resolvedModel,
    input: [
      {
        type: "audio",
        data: (Buffer.isBuffer(audioBuffer) ? audioBuffer : Buffer.from(audioBuffer)).toString(
          "base64"
        ),
        mime_type: GEMINI_MIME_TYPES[contentType] || contentType,
      },
    ],
  };
  if (Object.keys(transcriptionConfig).length > 0) {
    requestBody.generation_config = { transcription_config: transcriptionConfig };
  }

  debugLogger.debug(
    "Gemini batch transcription starting",
    { model: resolvedModel, language, audioBytes: audioBuffer.byteLength },
    "transcription"
  );

  const doFetch = fetchImpl || ((url, init) => net.fetch(url, init));
  const response = await doFetch(GEMINI_INTERACTIONS_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
    body: JSON.stringify(requestBody),
  });

  if (!response.ok) {
    const errorText = await response.text().catch(() => "");
    debugLogger.warn("Gemini transcription failed", {
      status: response.status,
      body: redactProviderBody(errorText),
    });
    // Google rejects a bad key with 400 + API_KEY_INVALID; the classifier reads that signal.
    throw providerHttpError({
      provider: "Gemini",
      model: resolvedModel,
      status: response.status,
      body: errorText,
      headers: response.headers,
      surface: "transcription",
    });
  }

  const data = await response.json();
  // Anything short of "completed" (failed, cancelled, budget_exceeded, ...) must
  // not fall through to extractText, which would return empty or truncated text
  // as a successful transcription.
  if (data?.status && data.status !== "completed") {
    const detail = data?.error?.message;
    throw new Error(
      detail
        ? `Gemini transcription failed: ${detail}`
        : `Gemini transcription did not complete (status: ${data.status})`
    );
  }
  return { text: extractText(data), model: resolvedModel };
}

module.exports = { transcribeWithGemini };
