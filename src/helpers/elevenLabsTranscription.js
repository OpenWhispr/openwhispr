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
const SILENCE_MARKER = "[pause]";

// ElevenLabs lists Filipino rather than Tagalog, so the app's "tl" goes out as "fil".
const LANGUAGE_CODES = { tl: "fil" };

function isKeytermRefusal(errorText) {
  let detail;
  try {
    detail = JSON.parse(errorText)?.detail;
  } catch {
    return false;
  }
  const isKeytermField = (field) => field === "keywords" || field === "keyterms";
  if (Array.isArray(detail)) {
    return detail.some((error) => error?.loc?.[0] === "body" && isKeytermField(error.loc[1]));
  }
  return isKeytermField(detail?.param);
}

// A longer pause between two words ends a segment.
const MAX_PAUSE_SECONDS = 1;
// A fluent speaker leaves only about 0.3 s between sentences, so past this length a
// segment ends with its sentence instead of waiting for a pause.
const SENTENCE_BREAK_SECONDS = 20;
// No segment runs longer, wherever its sentence ends.
const MAX_SEGMENT_SECONDS = 30;
// A sentence mark of any script, with the quotes or brackets that close after it.
const SENTENCE_END = /[\p{Sentence_Terminal}…][\p{Pe}\p{Pf}\p{Pi}"']*$/u;

// Groups the words Scribe returns into the timed segments an upload stores, one bubble
// each in the Transcript tab; a new speaker always starts one. Spacing items hold the
// whitespace between words. A word without times takes the previous word's end, since
// one segment without a finite start makes the note drop all its timing.
function groupWordsIntoSegments(words) {
  const segments = [];
  let spacing = "";
  let previousEnd = 0;
  let sentenceEnded = false;
  for (const word of words) {
    if (typeof word?.text !== "string") continue;
    if (word.type === "spacing") {
      spacing += word.text;
      continue;
    }
    const start = Number.isFinite(word.start) ? word.start : previousEnd;
    const end = Number.isFinite(word.end) ? word.end : start;
    const segment = segments.at(-1);
    // A word that names no speaker stays with the speaker before it.
    const speaker = word.speaker_id || segment?.speaker;
    if (
      !segment ||
      speaker !== segment.speaker ||
      start - previousEnd > MAX_PAUSE_SECONDS ||
      end - segment.start > MAX_SEGMENT_SECONDS ||
      (previousEnd - segment.start > SENTENCE_BREAK_SECONDS && sentenceEnded)
    ) {
      segments.push({ text: word.text, start, end, ...(speaker ? { speaker } : {}) });
    } else {
      segment.text += spacing + word.text;
      segment.end = end;
    }
    spacing = "";
    previousEnd = end;
    sentenceEnded = SENTENCE_END.test(word.text);
  }
  return segments;
}

async function transcribeWithElevenLabs(
  {
    audioBuffer,
    model,
    fileName,
    contentType,
    language,
    keyterms,
    diarize,
    timestamps,
    apiKey,
    signal,
  },
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
  // A speaker is named per word, so speaker labels need the words as much as timestamps do.
  const requestsWords = diarize || timestamps;

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
    // A caller that reads only the text skips the word timings, most of a long file's response.
    if (!requestsWords) formData.append("timestamps_granularity", "none");
    if (diarize) formData.append("diarize", "true");
    if (languageCode) formData.append("language_code", languageCode);
    for (const term of sentTerms) {
      formData.append("keyterms", term);
    }
    const response = await doFetch(ELEVENLABS_STT_URL, {
      method: "POST",
      headers: { "xi-api-key": apiKey },
      body: formData,
      // ElevenLabs' fixed endpoint never redirects. Following one would carry xi-api-key,
      // and on a 307 or 308 the recording, to whichever host it names (fetch drops only
      // Authorization across origins), so a redirect fails the request instead.
      redirect: "error",
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
  // above can't reproduce. Retry without hints only when the provider identifies their field.
  if (terms.length > 0 && [400, 422].includes(response.status) && isKeytermRefusal(errorText)) {
    debugLogger.warn("ElevenLabs refused the keyterms; retrying without them", {
      status: response.status,
      body: redactProviderBody(errorText),
    });
    terms = [];
    ({ response, errorText } = await send(terms));
  }

  // ElevenLabs refuses audio under 100 ms, which a tap of the hotkey records, instead of
  // answering it with an empty text. It holds no speech, so it ends as silence does. The
  // whole request was refused, so none of its keyterms was accepted.
  if (response.status === 400 && /audio_too_short/.test(errorText)) {
    debugLogger.debug(
      "ElevenLabs refused the recording as too short",
      { status: response.status, audioBytes: buffer.byteLength },
      "transcription"
    );
    return { text: "", model: resolvedModel, acceptedKeyterms: [] };
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
  const segments =
    requestsWords && Array.isArray(data.words) ? groupWordsIntoSegments(data.words) : [];
  // Scribe can answer silence with "[pause]" instead of an empty string.
  const trimmed = data.text.trim();
  return {
    text: !trimmed || trimmed === SILENCE_MARKER ? "" : data.text,
    model: resolvedModel,
    acceptedKeyterms: terms,
    ...(segments.length ? { segments } : {}),
  };
}

module.exports = {
  transcribeWithElevenLabs,
  groupWordsIntoSegments,
  sanitizeKeyterms,
  SILENCE_MARKER,
};
