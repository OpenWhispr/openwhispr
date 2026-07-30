import phrasesData from "../constants/hallucinationPhrases.json" with { type: "json" };

// Same normalize semantics as dictionaryEchoFilter.js: lowercase, strip
// non-letter/non-number characters (unicode-aware), collapse whitespace.
const normalize = (s) =>
  s
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, "")
    .replace(/\s+/g, " ")
    .trim();

const DEFAULTS = {
  minLengthChars: 20,
  maxConsecutiveRepeats: 4,
  ngramSize: 4,
  maxNgramRepeatRatio: 0.6,
};

// n-gram repetition is only meaningful once there is enough sample size;
// below this, ratios are noisy and would false-positive on short text.
const MIN_TOTAL_NGRAMS = 15;

// Segments are split on sentence-ish boundaries. Ghost-phrase and
// consecutive-repeat checks both compare whole normalized segments, never
// substrings of the full text — this avoids false positives from a known
// phrase merely appearing embedded inside a longer, legitimate sentence.
const SEGMENT_SPLIT_REGEX = /[.!?;\n]+/;

const GHOST_PHRASES = new Set((phrasesData?.PHRASES ?? []).map((phrase) => normalize(phrase)));

function splitSegments(rawText) {
  // Split on sentence boundaries BEFORE normalizing — normalize() strips the
  // punctuation delimiters themselves, so segmentation must happen first.
  return rawText
    .split(SEGMENT_SPLIT_REGEX)
    .map((segment) => normalize(segment))
    .filter(Boolean);
}

function longestConsecutiveRun(segments) {
  let maxRun = segments.length > 0 ? 1 : 0;
  let currentRun = 1;
  for (let i = 1; i < segments.length; i++) {
    if (segments[i] === segments[i - 1]) {
      currentRun++;
      if (currentRun > maxRun) maxRun = currentRun;
    } else {
      currentRun = 1;
    }
  }
  return maxRun;
}

/**
 * Pure detector for likely Whisper/ASR hallucinations in raw transcription
 * text. No I/O, no app-state imports — safe to unit test in isolation.
 *
 * @param {string} text - raw transcription text (pre-reasoning/cleanup)
 * @param {object} [options] - threshold overrides (tests only; production
 *   callers should rely on the hardcoded DEFAULTS per spec R-B2)
 * @returns {{ isHallucination: boolean, reason: string | null }}
 */
export function detectHallucination(text, options = {}) {
  const opts = { ...DEFAULTS, ...options };

  if (!text || text.trim().length < opts.minLengthChars) {
    return { isHallucination: false, reason: null };
  }

  const norm = normalize(text);
  const segments = splitSegments(text);

  // Check 1: ghost_phrase — exact normalized segment equality (never a
  // substring/includes() check over the whole text).
  for (const segment of segments) {
    if (GHOST_PHRASES.has(segment)) {
      return { isHallucination: true, reason: "ghost_phrase" };
    }
  }

  // Check 2: consecutive_repeat — the same normalized segment repeated
  // consecutively at least maxConsecutiveRepeats times.
  if (longestConsecutiveRun(segments) >= opts.maxConsecutiveRepeats) {
    return { isHallucination: true, reason: "consecutive_repeat" };
  }

  // Check 3: ngram_repeat — high repetition ratio across word n-grams.
  const tokens = norm.split(" ").filter(Boolean);
  if (tokens.length >= opts.ngramSize) {
    const ngrams = [];
    for (let i = 0; i <= tokens.length - opts.ngramSize; i++) {
      ngrams.push(tokens.slice(i, i + opts.ngramSize).join(" "));
    }
    if (ngrams.length >= MIN_TOTAL_NGRAMS) {
      const uniqueNgrams = new Set(ngrams);
      const repetitionRatio = 1 - uniqueNgrams.size / ngrams.length;
      if (repetitionRatio > opts.maxNgramRepeatRatio) {
        return { isHallucination: true, reason: "ngram_repeat" };
      }
    }
  }

  return { isHallucination: false, reason: null };
}
