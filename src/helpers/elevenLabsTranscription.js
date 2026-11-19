const { net } = require("electron");
const debugLogger = require("./debugLogger");
const { sanitizeElevenLabsKeyterms: sanitizeKeyterms } = require("../utils/elevenLabsKeyterms.js");
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

// ElevenLabs lists Filipino rather than Tagalog, so the app's "tl" goes out as "fil".
const LANGUAGE_CODES = { tl: "fil" };

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
  const audio = new Blob([buffer], { type });
  const languageCode =
    language && language !== "auto" ? (LANGUAGE_CODES[language] ?? language) : null;
  let terms = sanitizeKeyterms(keyterms);

  debugLogger.debug(
    "ElevenLabs batch transcription starting",
    { model: resolvedModel, language, audioBytes: buffer.byteLength, keyterms: terms.length },
    "transcription"
  );

  const doFetch = fetchImpl || ((url, init) => net.fetch(url, init));
  const send = async (sentTerms) => {
    signal?.throwIfAborted();
    const formData = new FormData();
    formData.append("file", audio, fileName || "audio.webm");
    formData.append("model_id", resolvedModel);
    // Scribe tags non-speech sounds ("(laughter)") unless told not to; those would be pasted.
    formData.append("tag_audio_events", "false");
    // Only the text is read, and word timings are most of a long file's response.
    formData.append("timestamps_granularity", "none");
    if (languageCode) formData.append("language_code", languageCode);
    for (const term of sentTerms) {
      formData.append("keyterms", term);
    }
    const response = await doFetch(ELEVENLABS_STT_URL, {
      method: "POST",
      headers: { "xi-api-key": apiKey },
      body: formData,
      ...(signal ? { signal } : {}),
    });
    if (response.ok) return { response, errorText: "" };
    // The status and headers still identify the failure if the body stream breaks.
    const errorText = await response.text().catch((error) => {
      if (error.name === "AbortError") throw error;
      return "";
    });
    signal?.throwIfAborted();
    return { response, errorText };
  };

  let { response, errorText } = await send(terms);
  // ElevenLabs counts a keyterm's words after its own normalisation, which the filter
  // above can't reproduce. The dictation matters more than the hint, so a request
  // refused over its keyterms goes again without them.
  if (terms.length > 0 && [400, 422].includes(response.status) && /keyterm/i.test(errorText)) {
    debugLogger.warn("ElevenLabs refused the keyterms; retrying without them", {
      status: response.status,
      body: redactProviderBody(errorText),
    });
    terms = [];
    ({ response, errorText } = await send(terms));
  }

  if (!response.ok) {
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

  const data = await response.json().catch((error) => {
    if (error instanceof SyntaxError) return null;
    throw error;
  });
  if (typeof data?.text !== "string") {
    throw providerError(PROVIDER_ERROR_CODES.ERROR, {
      provider: "ElevenLabs",
      surface: "transcription",
      technicalDetails: { underlyingError: "Expected a JSON transcript with a text field." },
    });
  }
  // Scribe can answer silence with "[pause]" instead of an empty string.
  const trimmed = data.text.trim();
  return {
    text: !trimmed || trimmed === "[pause]" ? "" : data.text,
    model: resolvedModel,
    acceptedKeyterms: terms,
  };
}

module.exports = { transcribeWithElevenLabs, sanitizeKeyterms, ELEVENLABS_STT_URL };
