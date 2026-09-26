import logger from "./logger";

const wordSegmenter = new Intl.Segmenter("und", { granularity: "word" });
const cleanupLabel =
  /^(?:Cleaned transcript:|\*\*Cleaned transcript:\*\*|\*\*Cleaned transcript\*\*:)$/i;
// Four words in a row is a phrase lifted from the prompt, not a coincidence.
const PROMPT_RUN_LENGTH = 4;
// Cleanup drops fillers and false starts, so words the speaker said can sit up
// to this many transcript words apart.
const SPOKEN_GAP = 3;
const DUPLICATED = {
  message: "AI cleanup repeated the transcript. The original text was kept.",
  messageKey: "hooks.audioRecording.errorDescriptions.cleanupDuplicated",
};
const ADDED_TEXT = {
  message: "AI cleanup added text you didn't say. The original text was kept.",
  messageKey: "hooks.audioRecording.errorDescriptions.cleanupAddedText",
};

/** The instructions a default cleanup request sent, to spot a reply that copies them. */
export interface CleanupPrompt {
  /** System prompt (dictionary list included) and the instruction after the transcript. */
  text: string;
  /** Dictionary words and snippet triggers listed in the prompt; the speaker may say them. */
  dictionary: readonly string[];
}

export type CleanupOutputProblem = "duplicated_transcript" | "prompt_copy";

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

const isNumber = (token: string) => /^\p{N}+$/u.test(token);
// Digits and single characters recur in any date or number ("1 月 15 日", "5 30 pm").
const isSubstantive = (token: string) => !isNumber(token) && [...token].length > 1;

function wordRuns(tokens: readonly string[]): string[] {
  const runs: string[] = [];
  for (let i = 0; i + PROMPT_RUN_LENGTH <= tokens.length; i++) {
    runs.push(tokens.slice(i, i + PROMPT_RUN_LENGTH).join(" "));
  }
  return runs;
}

// The speaker said these words in this order, allowing for removed fillers.
// Digits never count against them: cleanup writes spoken numbers as digits.
function saidBySpeaker(tokens: readonly string[], rawTokens: readonly string[]): boolean {
  const words = tokens.filter((token) => !isNumber(token));
  if (words.length === 0) return true;
  const span = tokens.length + SPOKEN_GAP;
  for (let start = 0; start < rawTokens.length; start++) {
    if (rawTokens[start] !== words[0]) continue;
    const end = Math.min(rawTokens.length, start + span);
    let matched = 1;
    for (let next = start + 1; matched < words.length && next < end; next++) {
      if (rawTokens[next] === words[matched]) matched++;
    }
    if (matched === words.length) return true;
  }
  return false;
}

function repeatsTranscript(rawTokens: readonly string[], output: string): boolean {
  // Collapse stutters ("the the") so they don't read as saying a word twice.
  const originalTokens = rawTokens.filter((token, index, all) => token !== all[index - 1]);
  const tokens: string[] = [];
  for (const line of output.split(/\r?\n/u)) {
    if (cleanupLabel.test(line.trim())) continue;
    for (const token of comparisonTokens(line)) tokens.push(token);
  }

  const halfLength = tokens.length / 2;
  if (!Number.isInteger(halfLength) || halfLength < 6) return false;
  const copy = tokens.slice(0, halfLength);
  if (!copy.every((token, index) => token === tokens[index + halfLength])) return false;
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
  return saidTwice * 2 <= halfLength;
}

function copiesPrompt(
  rawTokens: readonly string[],
  output: string,
  prompt: CleanupPrompt
): boolean {
  const fromPrompt = new Set(wordRuns(comparisonTokens(prompt.text)));
  // A dictionary term longer than a run is the speaker's to say, even after
  // cleanup corrected its spelling.
  const insideDictionaryEntry = new Set(
    prompt.dictionary.flatMap((entry) => wordRuns(comparisonTokens(entry)))
  );
  const outputTokens = comparisonTokens(output);
  for (let i = 0; i + PROMPT_RUN_LENGTH <= outputTokens.length; i++) {
    const run = outputTokens.slice(i, i + PROMPT_RUN_LENGTH);
    const key = run.join(" ");
    if (!fromPrompt.has(key) || insideDictionaryEntry.has(key)) continue;
    if (run.filter(isSubstantive).length < 2) continue;
    if (!saidBySpeaker(run, rawTokens)) return true;
  }
  return false;
}

export function findCleanupOutputProblem(
  rawText: string,
  output: string,
  prompt?: CleanupPrompt
): CleanupOutputProblem | null {
  const rawTokens = comparisonTokens(rawText);
  if (repeatsTranscript(rawTokens, output)) return "duplicated_transcript";
  if (prompt && copiesPrompt(rawTokens, output, prompt)) return "prompt_copy";
  return null;
}

export function assertValidCleanupOutput(
  rawText: string,
  output: string,
  prompt?: CleanupPrompt
): void {
  const problem = findCleanupOutputProblem(rawText, output, prompt);
  if (!problem) return;
  // The reason only: the output can hold the speaker's words and dictionary names.
  logger.logReasoning("CLEANUP_OUTPUT_REJECTED", {
    reason: problem,
    inputLength: rawText.length,
    outputLength: output.length,
  });
  const { message, messageKey } = problem === "duplicated_transcript" ? DUPLICATED : ADDED_TEXT;
  throw Object.assign(new Error(message), { code: "CLEANUP_OUTPUT_INVALID", messageKey });
}
