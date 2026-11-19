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
const DEFAULT_MODEL = "scribe_v3";

// ElevenLabs rejects the whole request (422) for a single keyterm outside its
// documented limits, so terms that break them are dropped rather than sent.
// It takes 1000 keyterms, but bills at least 20 seconds for a request with more
// than 100, which would multiply the cost of a short dictation.
const MAX_KEYTERMS = 100;
// ElevenLabs allows 50 characters. The renderer cuts longer dictionary entries to
// 50, and a cut-off word is no keyterm, so a term at the limit is dropped too.
const MAX_KEYTERM_CHARS = 50;
const MAX_KEYTERM_WORDS = 5;
const FORBIDDEN_KEYTERM_CHARS = /[<>{}[\]\\]/;

// ElevenLabs lists Filipino rather than Tagalog, so the app's "tl" goes out as "fil".
const LANGUAGE_CODES = { tl: "fil" };

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
  const audio = new Blob([buffer], { type });
  const languageCode =
    language && language !== "auto" ? (LANGUAGE_CODES[language] ?? language) : null;
  const terms = sanitizeKeyterms(keyterms);

  debugLogger.debug(
    "ElevenLabs batch transcription starting",
    { model: resolvedModel, language, audioBytes: buffer.byteLength, keyterms: terms.length },
    "transcription"
  );

  const doFetch = fetchImpl || ((url, init) => net.fetch(url, init));
  const send = async (sentTerms) => {
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
    return { response, errorText: response.ok ? "" : await response.text().catch(() => "") };
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
    ({ response, errorText } = await send([]));
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

  const data = await response.json().catch(() => null);
  const text = typeof data?.text === "string" ? data.text : "";
  // Scribe can answer silence with "[pause]" instead of an empty string.
  return { text: text.trim() === "[pause]" ? "" : text, model: resolvedModel };
}

module.exports = { transcribeWithElevenLabs, sanitizeKeyterms, ELEVENLABS_STT_URL };
