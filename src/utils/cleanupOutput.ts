import logger from "./logger";

const wordSegmenter = new Intl.Segmenter("und", { granularity: "word" });
const cleanupLabel =
  /^(?:Cleaned transcript:|\*\*Cleaned transcript:\*\*|\*\*Cleaned transcript\*\*:)$/i;

function comparisonTokens(text: string): string[] {
  // Keep contractions as one word when punctuation is discarded.
  const normalized = text
    .normalize("NFKC")
    .toLowerCase()
    .replace(/['’]/gu, "")
    .replace(/\p{P}/gu, " ");
  return Array.from(wordSegmenter.segment(normalized))
    .filter((segment) => segment.isWordLike)
    .map((segment) => segment.segment);
}

export function assertValidCleanupOutput(rawText: string, output: string): void {
  // Collapse stutters ("the the") so they don't read as saying a word twice.
  const originalTokens = comparisonTokens(rawText).filter(
    (token, index, all) => token !== all[index - 1]
  );
  const tokens: string[] = [];
  for (const line of output.split(/\r?\n/u)) {
    if (cleanupLabel.test(line.trim())) continue;
    for (const token of comparisonTokens(line)) tokens.push(token);
  }

  const halfLength = tokens.length / 2;
  if (!Number.isInteger(halfLength) || halfLength < 6) return;
  const copy = tokens.slice(0, halfLength);
  if (!copy.every((token, index) => token === tokens[index + halfLength])) return;
  // A speaker who really said it twice said most of its words twice: each word
  // in the copy uses up two of its occurrences in the raw transcript.
  const rawCounts = new Map<string, number>();
  for (const token of originalTokens) rawCounts.set(token, (rawCounts.get(token) ?? 0) + 1);
  let saidTwice = 0;
  for (const token of copy) {
    const remaining = rawCounts.get(token) ?? 0;
    if (remaining < 2) continue;
    rawCounts.set(token, remaining - 2);
    saidTwice++;
  }
  if (saidTwice * 2 > halfLength) return;

  logger.logReasoning("CLEANUP_OUTPUT_REJECTED", {
    reason: "duplicated_transcript",
    inputLength: rawText.length,
    outputLength: output.length,
  });
  throw Object.assign(
    new Error("AI cleanup repeated the transcript. The original text was kept."),
    {
      code: "CLEANUP_OUTPUT_INVALID",
      messageKey: "hooks.audioRecording.errorDescriptions.cleanupDuplicated",
    }
  );
}

const FILLER_WORDS = new Set(
  "um uh er erm ah hmm mm mhm like so yeah okay ok well right".split(" ")
);
// An empty answer is right when the speech was only filler, so it takes this
// many other words before it reads as a failure.
const MIN_SPOKEN_WORDS_FOR_EMPTY_CHECK = 4;
// Cleanup removes words far more often than it adds them. Short dictations can
// still grow a lot in proportion (spelled-out numbers, expanded shorthand).
const RUNAWAY_WORD_RATIO = 1.5;
const RUNAWAY_MIN_WORDS = 8;

/**
 * A wider check than assertValidCleanupOutput, for models with a cleanup prompt
 * profile: rejects an empty answer to real speech and an answer far longer than
 * what was said (a runaway repeat, or the model answering instead of cleaning).
 * Throws the same error code, so the raw text is kept and the notice is raised.
 */
export function assertPlausibleCleanupOutput(rawText: string, output: string): void {
  const rawTokens = comparisonTokens(rawText);
  const outputTokens = comparisonTokens(output);

  let reason: string;
  let message: string;
  let messageKey: string | undefined;
  if (outputTokens.length === 0) {
    const spoken = rawTokens.filter((token) => !FILLER_WORDS.has(token)).length;
    if (spoken < MIN_SPOKEN_WORDS_FOR_EMPTY_CHECK) return;
    reason = "empty_output";
    message = "AI cleanup returned nothing. The original text was kept.";
    messageKey = "hooks.audioRecording.errorDescriptions.cleanupEmptyReply";
  } else if (
    outputTokens.length > RUNAWAY_MIN_WORDS &&
    outputTokens.length > rawTokens.length * RUNAWAY_WORD_RATIO
  ) {
    reason = "runaway_output";
    // English only for now: the one profiled model is English only.
    message = "AI cleanup returned far more text than was dictated. The original text was kept.";
  } else {
    return;
  }

  logger.logReasoning("CLEANUP_OUTPUT_REJECTED", {
    reason,
    inputLength: rawText.length,
    outputLength: output.length,
  });
  throw Object.assign(new Error(message), {
    code: "CLEANUP_OUTPUT_INVALID",
    ...(messageKey ? { messageKey } : {}),
  });
}

// Hesitation sounds only, unlike FILLER_WORDS, which also holds words like "so"
// and "right" that an answer usually keeps: leaving those out of the speaker's
// side would break the phrases around them into a false gap. It is also the list
// the drop thresholds were measured with (openwhispr-finetune guard/guards.py).
const HESITATIONS = new Set("um uh umm uhh er erm ah hmm mm mhm".split(" "));
// Words in the phrases matched against the answer. At 3, a measured drop hid
// behind short phrases that also occur elsewhere in the dictation.
const KEPT_PHRASE_WORDS = 4;

const spokenTokens = (rawText: string): string[] =>
  comparisonTokens(rawText).filter((token) => !HESITATIONS.has(token));

/**
 * The longest run of words the speaker said (hesitations aside) that the answer
 * lost: a word is kept when some 4-word phrase containing it appears anywhere
 * in the answer. A long run is a dropped passage, even in an answer as long as
 * the dictation (one paragraph written over and over in place of the rest).
 */
export function longestMissingRun(rawText: string, output: string): number {
  const spoken = spokenTokens(rawText);
  if (spoken.length < KEPT_PHRASE_WORDS) return 0;
  const answered = comparisonTokens(output);
  const answerPhrases = new Set<string>();
  for (let start = 0; start + KEPT_PHRASE_WORDS <= answered.length; start++) {
    answerPhrases.add(answered.slice(start, start + KEPT_PHRASE_WORDS).join(" "));
  }

  let keptThrough = -1;
  let run = 0;
  let longest = 0;
  for (let index = 0; index < spoken.length; index++) {
    const phrase = spoken.slice(index, index + KEPT_PHRASE_WORDS);
    if (phrase.length === KEPT_PHRASE_WORDS && answerPhrases.has(phrase.join(" "))) {
      keptThrough = index + KEPT_PHRASE_WORDS - 1;
    }
    run = index <= keptThrough ? 0 : run + 1;
    longest = Math.max(longest, run);
  }
  return longest;
}

/**
 * The longest run of words the speaker said (hesitations aside) that lining
 * them up with the answer, in order, leaves unmatched (a longest common
 * subsequence). Rewording that keeps the words in place, such as a numbered
 * list or figures written as digits, leaves no long run here where
 * longestMissingRun can find one; a passage moved elsewhere counts as missing.
 */
export function longestUnalignedRun(rawText: string, output: string): number {
  const spoken = spokenTokens(rawText);
  const answered = comparisonTokens(output);
  const width = answered.length + 1;
  // common[i * width + j]: the length of the longest common subsequence of the
  // first i spoken and the first j answered words, which 16 bits hold unless
  // both texts run past 65,535 words.
  const Lengths = Math.min(spoken.length, answered.length) > 0xffff ? Uint32Array : Uint16Array;
  const common = new Lengths((spoken.length + 1) * width);
  for (let i = 1; i <= spoken.length; i++) {
    for (let j = 1; j <= answered.length; j++) {
      common[i * width + j] =
        spoken[i - 1] === answered[j - 1]
          ? common[(i - 1) * width + j - 1] + 1
          : Math.max(common[(i - 1) * width + j], common[i * width + j - 1]);
    }
  }

  // Walk one such subsequence back from the end, counting the spoken words it
  // leaves out in a row.
  let i = spoken.length;
  let j = answered.length;
  let run = 0;
  let longest = 0;
  while (i > 0) {
    if (j > 0 && spoken[i - 1] === answered[j - 1]) {
      run = 0;
      i--;
      j--;
    } else if (j > 0 && common[i * width + j - 1] >= common[(i - 1) * width + j]) {
      j--;
    } else {
      run++;
      longest = Math.max(longest, run);
      i--;
    }
  }
  return longest;
}
