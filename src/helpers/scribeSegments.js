// Pure helpers for uploads to our own stt-api Scribe route (Phase 5, D-07). ESM so
// tests and main (require(esm)) share it. The server answers POST
// <base>/speech-to-text with word-level timing and speaker ids; this module builds
// the request fields and groups those words into the segments the upload UI
// already renders for Mistral and OpenAI.

// A gap longer than this between two words of one speaker starts a new segment.
export const SEGMENT_GAP_SECONDS = 1.5;
// A segment longer than this is split after its next sentence-final word.
export const SEGMENT_MAX_SECONDS = 30;

const SENTENCE_END = /[.?!]["')\]]*$/;

/**
 * Multipart fields for the Scribe request. No `language_code`: the server pins its
 * language and rejects a mismatch, and an uploaded file is often not in the
 * dictation language.
 */
export function scribeRequestFields({ model, diarize } = {}) {
  return {
    model_id: model || "scribe",
    diarize: diarize ? "true" : "false",
    timestamps_granularity: "word",
  };
}

const isWord = (item) =>
  item &&
  item.type === "word" &&
  typeof item.text === "string" &&
  item.text.trim() !== "" &&
  Number.isFinite(item.start) &&
  Number.isFinite(item.end);

const speakerOf = (item) =>
  typeof item.speaker_id === "string" && item.speaker_id !== "" ? item.speaker_id : null;

/**
 * Groups `words[]` (Scribe response) into `{ speaker?, text, start, end }`
 * segments: a new segment on a speaker change, on a gap over SEGMENT_GAP_SECONDS,
 * or after a sentence-final word once the segment exceeds SEGMENT_MAX_SECONDS.
 * Spacing items only supply the text between two words of one segment and never
 * start or end a segment. Items that are not usable words are skipped.
 */
export function scribeWordsToSegments(words) {
  if (!Array.isArray(words)) return [];

  const segments = [];
  let current = null;
  let gapText = "";

  const flush = () => {
    if (current) {
      segments.push({
        ...(current.speaker ? { speaker: current.speaker } : {}),
        text: current.text.trim(),
        start: current.start,
        end: current.end,
      });
    }
    current = null;
    gapText = "";
  };

  for (const item of words) {
    if (item && item.type === "spacing") {
      if (current && typeof item.text === "string") gapText += item.text;
      continue;
    }
    if (!isWord(item)) continue;

    const speaker = speakerOf(item);
    const start = Math.max(0, item.start);
    const end = Math.max(start, item.end);

    if (current && (speaker !== current.speaker || start - current.end > SEGMENT_GAP_SECONDS)) {
      flush();
    }

    if (!current) {
      current = { speaker, text: item.text.trim(), start, end };
    } else {
      // The original whitespace between the words; one space when the server sent none.
      current.text += (gapText !== "" && gapText.trim() === "" ? gapText : " ") + item.text.trim();
      current.end = Math.max(current.end, end);
    }
    gapText = "";

    if (current.end - current.start > SEGMENT_MAX_SECONDS && SENTENCE_END.test(item.text.trim())) {
      flush();
    }
  }
  flush();

  return segments;
}
