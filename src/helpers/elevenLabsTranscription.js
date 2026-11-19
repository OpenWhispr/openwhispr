const { net } = require("electron");
const { sanitizeKeyterms } = require("./elevenLabsKeyterms.js");
const debugLogger = require("./debugLogger");
const {
  PROVIDER_ERROR_CODES,
  providerHttpError,
  providerError,
  redactProviderBody,
} = require("./providerHttpErrors");

// Scribe's batch endpoint is not OpenAI-compatible: it authenticates with
// xi-api-key and takes model_id / language_code, so it is proxied through main.
const ELEVENLABS_STT_URL = "https://api.elevenlabs.io/v1/speech-to-text";
const DEFAULT_MODEL = "scribe_v3";

// Scribe can answer silence with this marker instead of an empty transcript.
const SILENCE_MARKER = "[pause]";

async function transcribeWithElevenLabs(
  { audioBuffer, model, fileName, contentType, language, keyterms, apiKey, signal },
  fetchImpl
) {
  if (!apiKey?.trim()) {
    throw providerError(PROVIDER_ERROR_CODES.KEY_MISSING, {
      provider: "ElevenLabs",
      surface: "transcription",
    });
  }

  const resolvedModel = model || DEFAULT_MODEL;
  const type = contentType || "audio/webm";
  const buffer = Buffer.isBuffer(audioBuffer) ? audioBuffer : Buffer.from(audioBuffer);
  const formData = new FormData();
  formData.append("file", new Blob([buffer], { type }), fileName || "audio.webm");
  formData.append("model_id", resolvedModel);
  // Scribe tags non-speech sounds ("(laughter)") unless told not to; those would be pasted.
  formData.append("tag_audio_events", "false");
  if (language && language !== "auto") {
    formData.append("language_code", language);
  }
  const terms = sanitizeKeyterms(keyterms);
  for (const term of terms) {
    formData.append("keyterms", term);
  }

  debugLogger.debug(
    "ElevenLabs batch transcription starting",
    { model: resolvedModel, language, audioBytes: buffer.byteLength, keyterms: terms.length },
    "transcription"
  );

  const doFetch = fetchImpl || ((url, init) => net.fetch(url, init));
  const response = await doFetch(ELEVENLABS_STT_URL, {
    method: "POST",
    headers: { "xi-api-key": apiKey },
    body: formData,
    ...(signal ? { signal } : {}),
  });

  if (!response.ok) {
    const errorText = await response.text().catch(() => "");
    debugLogger.warn("ElevenLabs transcription failed", {
      status: response.status,
      body: redactProviderBody(errorText),
    });
    throw providerHttpError({
      provider: "ElevenLabs",
      model: resolvedModel,
      status: response.status,
      body: errorText,
      headers: response.headers,
      surface: "transcription",
    });
  }

  const data = await response.json();
  const text = typeof data?.text === "string" ? data.text : "";
  return { text: text.trim() === SILENCE_MARKER ? "" : text, model: resolvedModel };
}

module.exports = {
  transcribeWithElevenLabs,
  sanitizeKeyterms,
  ELEVENLABS_STT_URL,
  SILENCE_MARKER,
};
