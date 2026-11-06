const { net } = require("electron");
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
const DEFAULT_MODEL = "scribe_v2";

// ElevenLabs rejects the whole request (422) for a single keyterm outside its
// documented limits, so terms that break them are dropped rather than sent.
const MAX_KEYTERMS = 1000;
const MAX_KEYTERM_CHARS = 50;
const MAX_KEYTERM_WORDS = 5;
const FORBIDDEN_KEYTERM_CHARS = /[<>{}[\]\\]/;

function sanitizeKeyterms(keyterms) {
  if (!Array.isArray(keyterms)) return [];
  const seen = new Set();
  const terms = [];
  for (const raw of keyterms) {
    if (typeof raw !== "string") continue;
    const term = raw.trim().replace(/\s+/g, " ");
    if (!term || term.length >= MAX_KEYTERM_CHARS) continue;
    if (term.split(" ").length > MAX_KEYTERM_WORDS) continue;
    if (FORBIDDEN_KEYTERM_CHARS.test(term)) continue;
    const key = term.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    terms.push(term);
    if (terms.length === MAX_KEYTERMS) break;
  }
  return terms;
}

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
  return { text: typeof data?.text === "string" ? data.text : "", model: resolvedModel };
}

module.exports = { transcribeWithElevenLabs, sanitizeKeyterms, ELEVENLABS_STT_URL };
